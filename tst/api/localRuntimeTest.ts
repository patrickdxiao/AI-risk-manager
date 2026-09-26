import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalApiRuntime, type LocalApiRuntime } from "../../src/api/localRuntime.js";
import { captureLocally } from "../../src/api/localCapture.js";
import {
  createSQLiteUnitOfWork,
  openSQLiteDatabase,
} from "../../src/adapters/sqlite/sqliteDatabase.js";
import { GitRepositoryObservationAdapter } from "../../src/adapters/git/inspectRepository.js";
import { ReconcileRepository } from "../../src/core/repository/repositoryCapture.js";
import type {
  InvestigationRuntimePort,
  RunInvestigationInput,
} from "../../src/core/investigation/investigationModel.js";
import type { EvidenceItem } from "../../src/core/evidence/evidenceModel.js";
import type { Repository } from "../../src/core/repository/repositoryModel.js";
import type { Sprint, Task } from "../../src/core/planning/planningModel.js";
import { RiskApiClient } from "../../src/plugin/riskApiClient.js";

const folders: string[] = [];
const runtimes: LocalApiRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "risk-runtime-")));
  folders.push(root);
  const repo = join(root, "repository");
  mkdirSync(repo);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  function git(...args: string[]) {
    return execFileSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        ...args,
      ],
      { cwd: repo, env, encoding: "utf8", stdio: "pipe" },
    );
  }
  git("init", "--quiet");
  writeFileSync(join(repo, "README.txt"), "Fixture metadata only\n");
  git("add", "README.txt");
  git("commit", "--quiet", "-m", "Initial fixture", "--date=2026-09-24T09:00:00Z");
  const stateDir = join(root, "state");
  let time = Date.parse("2026-09-24T10:00:00Z");
  const clock = { now: () => new Date(time).toISOString() };
  const ids = { next: randomUUID };
  async function open(port?: InvestigationRuntimePort) {
    const runtime = await createLocalApiRuntime(
      {
        stateDir,
        ...(port === undefined ? {} : { openClaw: { mode: "injected" as const, port } }),
      },
      { clock, ids },
    );
    runtimes.push(runtime);
    return runtime;
  }
  function request(
    runtime: LocalApiRuntime,
    method: "GET" | "POST",
    url: string,
    payload?: object,
  ) {
    return runtime.app.inject({
      method,
      url,
      ...(payload === undefined ? {} : { payload }),
      headers: { authorization: `Bearer ${runtime.token}` },
    });
  }
  async function seed(runtime: LocalApiRuntime) {
    const repoResponse = await request(runtime, "POST", "/api/repositories", { path: repo });
    expect(repoResponse.statusCode).toBe(201);
    const { repository } = repoResponse.json<{ repository: Repository }>();
    const sprintResponse = await request(runtime, "POST", "/api/sprints", {
      startAt: clock.now(),
      endAt: "2026-10-01T10:00:00Z",
      reviewCadenceMinutes: 180,
    });
    expect(sprintResponse.statusCode).toBe(201);
    const { sprint } = sprintResponse.json<{ sprint: Sprint }>();
    const taskResponse = await request(runtime, "POST", "/api/tasks", {
      sprintId: sprint.id,
      title: "Verify the checkout",
      points: 3,
      completionCriteria: ["A passing integration check"],
    });
    expect(taskResponse.statusCode).toBe(201);
    return { repository, sprint, task: taskResponse.json<{ task: Task }>().task };
  }
  return {
    root,
    repo,
    stateDir,
    clock,
    ids,
    open,
    request,
    seed,
    advance: () => {
      time += 1_000;
    },
  };
}

function storeFor(runtime: LocalApiRuntime) {
  const database = openSQLiteDatabase({ path: runtime.dbPath });
  return {
    store: createSQLiteUnitOfWork(database.raw),
    close: () => {
      database.close();
    },
  };
}

describe("composed local runtime", () => {
  it("authenticates display-only agent activity without enabling reviews", async () => {
    const f = fixture();
    const data = {
      status: "connected" as const,
      sessions: [
        {
          key: "agent:dev:main",
          agentId: "dev",
          label: "User agent",
          kind: "agent" as const,
          state: "running" as const,
          updatedAt: 123,
        },
      ],
    };
    const list = vi.fn().mockResolvedValue(data);
    const runtime = await createLocalApiRuntime({ stateDir: f.stateDir, agentActivity: { list } });
    runtimes.push(runtime);
    expect(
      (await runtime.app.inject({ method: "GET", url: "/api/agents/activity" })).statusCode,
    ).toBe(401);
    expect(list).not.toHaveBeenCalled();
    expect((await f.request(runtime, "GET", "/api/agents/activity")).json()).toEqual(data);
    expect((await f.request(runtime, "GET", "/api/status")).json()).toEqual({
      investigationsEnabled: false,
    });
    await runtime.close();
    const disabled = await f.open();
    expect((await f.request(disabled, "GET", "/api/agents/activity")).json()).toEqual({
      status: "disabled",
      sessions: [],
    });
  });
  it("persists plans and repeated local-only Git captures while providers are disabled", async () => {
    const f = fixture(),
      runtime = await f.open();
    const { repository, sprint, task } = await f.seed(runtime);
    expect((await f.request(runtime, "GET", "/api/status")).json()).toEqual({
      investigationsEnabled: false,
    });
    expect(
      (
        await f.request(runtime, "POST", "/api/reviews", {
          sprintId: sprint.id,
          repositoryIds: [repository.id],
          requestId: "disabled",
        })
      ).statusCode,
    ).toBe(503);
    const capture = () =>
      f.request(runtime, "POST", `/api/repositories/${repository.id}/reconcile`, {});
    const first = await capture();
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ changed: true });
    const db = storeFor(runtime);
    try {
      writeFileSync(join(f.repo, "README.txt"), "Changed local metadata\n");
      f.advance();
      const raw = await new ReconcileRepository(
        db.store,
        new GitRepositoryObservationAdapter(),
        f.ids,
        f.clock,
      ).execute({ repositoryId: repository.id });
      expect(raw.changed).toBe(true);
      expect(
        await db.store.execute((tx) => tx.repositoryObservations.listPendingEvaluation(100)),
      ).toHaveLength(1);
      await expect(
        captureLocally(
          db.store,
          { capture: () => Promise.reject(new Error("capture unavailable")) },
          f.ids,
          f.clock,
          repository.id,
        ),
      ).rejects.toThrow("capture unavailable");
      expect(
        await db.store.execute((tx) => tx.repositoryObservations.listPendingEvaluation(100)),
      ).toEqual([]);
      expect(
        (
          await db.store.execute((tx) =>
            tx.repositoryObservations.findByRepositoryId(repository.id),
          )
        )?.snapshot.snapshotDigest,
      ).toBe(raw.snapshotDigest);
      expect(
        await db.store.execute((tx) => tx.evidence.findById(raw.evidence[0]?.id ?? "missing")),
      ).toBeDefined();
      writeFileSync(join(f.repo, "another.txt"), "No code execution\n");
      f.advance();
      expect((await capture()).json()).toMatchObject({ changed: true });
      expect(
        await db.store.execute((tx) => tx.repositoryObservations.listPendingEvaluation(100)),
      ).toEqual([]);
      expect(
        await db.store.execute((tx) => tx.triggerQueue.listPendingBySprintId(sprint.id, 100)),
      ).toEqual([]);
      expect((await capture()).json()).toMatchObject({ changed: false });
    } finally {
      db.close();
    }
    const token = runtime.token;
    await runtime.close();
    await runtime.close();
    const reopened = await f.open();
    expect(reopened.token).toBe(token);
    expect(
      (await f.request(reopened, "GET", `/api/sprints/${sprint.id}/overview`)).json(),
    ).toMatchObject({ tasks: [{ id: task.id, state: "planned", riskState: "uncertain" }] });
    expect(readFileSync(join(f.repo, "another.txt"), "utf8")).toBe("No code execution\n");
  });

  it("runs one explicit resynced review through real HTTP tools and preserves its cited result across restart", async () => {
    const f = fixture(),
      setup = await f.open();
    const { repository, sprint, task } = await f.seed(setup);
    await setup.close();
    let calls = 0;
    let callbackError: Error | undefined;
    const run = async (input: RunInvestigationInput) => {
      calls++;
      try {
        const address = runtime.app.server.address();
        if (address === null || typeof address === "string")
          throw new Error("API is not listening");
        const client = new RiskApiClient({
          apiBaseUrl: `http://127.0.0.1:${String(address.port)}`,
          token: input.attemptToken,
          timeoutMs: 5_000,
          maxResponseBytes: 100_000,
        });
        expect(input.prompt).toContain(repository.id);
        expect(input.prompt).not.toContain(input.attemptToken);
        expect(await client.invokeTool("risk_get_context", {})).toMatchObject({
          context: { sprint: { id: sprint.id }, tasks: [{ id: task.id }] },
        });
        const listed = await client.invokeTool("risk_list_evidence", {
          repositoryId: repository.id,
          limit: 20,
        });
        const parsed = listed as { evidence: EvidenceItem[] };
        const item = parsed.evidence[0];
        if (item === undefined) throw new Error("Saved Git metadata is missing");
        expect(
          await client.invokeTool("risk_get_evidence", { evidenceIds: [item.id] }),
        ).toMatchObject({ evidence: [{ id: item.id, repositoryId: repository.id }] });
        return {
          runId: "scripted-real-http",
          sessionId: "integration",
          usage: { totalTokens: 17 },
          structuredResult: {
            version: "1" as const,
            findings: [
              {
                taskId: task.id,
                state: "at_risk" as const,
                riskType: "completion_unverified" as const,
                confidence: 0.6,
                rationale: "Git metadata does not verify the completion check",
                nextCheckCondition: "When the user supplies verification",
                evidenceCitations: [{ evidenceId: item.id }],
              },
            ],
          },
        };
      } catch (error) {
        callbackError =
          error instanceof Error ? error : new Error("Runtime assertion failed", { cause: error });
        throw error;
      }
    };
    const runtime = await f.open({ runInvestigation: run });
    await runtime.app.listen({ host: "127.0.0.1", port: 0 });
    const request = {
      sprintId: sprint.id,
      taskId: task.id,
      repositoryIds: [repository.id],
      requestId: "one-explicit-review",
      resync: true,
    };
    expect((await f.request(runtime, "POST", "/api/reviews", request)).statusCode).toBe(202);
    await vi.waitFor(async () => {
      if (callbackError !== undefined) throw callbackError;
      expect(
        (await f.request(runtime, "GET", `/api/sprints/${sprint.id}/overview`)).json(),
      ).toMatchObject({
        overallRisk: "at_risk",
        confirmedDonePoints: 0,
        tasks: [{ state: "planned", assessment: { evidenceIds: [expect.any(String)] } }],
      });
    });
    expect((await f.request(runtime, "POST", "/api/reviews", request)).statusCode).toBe(202);
    await runtime.close();
    expect(callbackError).toBeUndefined();
    expect(calls).toBe(1);
    const restarted = await f.open();
    const db = storeFor(restarted);
    try {
      const receipt = await db.store.execute((tx) =>
        tx.investigations.findLatestSubmittedResult(sprint.id, task.id),
      );
      expect(receipt?.findings).toHaveLength(1);
      expect(receipt?.investigation.usage?.totalTokens).toBe(17);
      expect(
        await db.store.execute((tx) => tx.repositoryObservations.listPendingEvaluation(100)),
      ).toEqual([]);
      expect(
        await db.store.execute((tx) => tx.triggerQueue.listPendingBySprintId(sprint.id, 100)),
      ).toEqual([]);
    } finally {
      db.close();
    }
    expect(
      (await f.request(restarted, "GET", `/api/sprints/${sprint.id}/overview`)).json(),
    ).toMatchObject({ overallRisk: "at_risk", confirmedDonePoints: 0 });
  });

  it("starts recovery only after listening and aborts active model waiting before closing durable state", async () => {
    const f = fixture(),
      setup = await f.open();
    const { sprint } = await f.seed(setup);
    await setup.close();
    let started: RunInvestigationInput | undefined;
    const runtime = await f.open({
      runInvestigation: (input) => {
        started = input;
        return new Promise((_resolve, reject) => {
          input.signal.addEventListener(
            "abort",
            () => {
              reject(new Error("private provider details"));
            },
            { once: true },
          );
        });
      },
    });
    expect(
      (
        await f.request(runtime, "POST", "/api/reviews", {
          sprintId: sprint.id,
          repositoryIds: [],
          requestId: "shutdown",
        })
      ).statusCode,
    ).toBe(202);
    expect(started).toBeUndefined();
    await runtime.app.listen({ host: "127.0.0.1", port: 0 });
    await vi.waitFor(() => {
      expect(started).toBeDefined();
    });
    await runtime.app.close();
    expect(started?.signal.aborted).toBe(true);
    await runtime.close();
    const reopened = await f.open();
    const db = storeFor(reopened);
    try {
      const history = await db.store.execute((tx) =>
        tx.investigations.findRecentBySprintId(sprint.id, f.clock.now(), 20),
      );
      expect(history).toHaveLength(1);
      const id = history[0]?.investigation.id;
      if (id === undefined) throw new Error("Investigation missing");
      const attempts = await db.store.execute((tx) => tx.investigations.findAttempts(id));
      expect(attempts).toMatchObject([
        {
          status: "cancelled",
          authority: { repositoryIds: [] },
        },
      ]);
      expect(attempts[0]?.usage?.totalTokens).toBeUndefined();
      expect(attempts[0]?.authority?.reservedTokens).toBeGreaterThan(0);
      expect(JSON.stringify(attempts)).not.toContain(started?.attemptToken ?? "missing token");
    } finally {
      db.close();
    }
  });

  it("rejects state inside Git before token or database writes and cleans up a failed composition", async () => {
    const f = fixture();
    const unsafe = join(f.repo, "state");
    await expect(createLocalApiRuntime({ stateDir: unsafe })).rejects.toMatchObject({
      code: "state_directory_inside_repository",
    });
    expect(existsSync(join(unsafe, "state.sqlite"))).toBe(false);
    expect(existsSync(join(unsafe, "api-token"))).toBe(false);
    await expect(
      createLocalApiRuntime({ stateDir: f.stateDir, token: "invalid" }),
    ).rejects.toThrow();
    const reopened = await f.open();
    expect((await f.request(reopened, "GET", "/api/status")).statusCode).toBe(200);
    await reopened.close();
    const attempts = join(f.stateDir, "attempts");
    symlinkSync(f.repo, attempts, "dir");
    await expect(
      createLocalApiRuntime({
        stateDir: f.stateDir,
        openClaw: { mode: "cli", investigationAgentId: "investigator" },
      }),
    ).rejects.toThrow();
    rmSync(attempts);
    const cli = await createLocalApiRuntime({
      stateDir: f.stateDir,
      openClaw: { mode: "cli", investigationAgentId: "investigator", executable: "/not-invoked" },
      writeWarning: () => undefined,
    });
    runtimes.push(cli);
    expect((await f.request(cli, "GET", "/api/status")).json()).toEqual({
      investigationsEnabled: true,
    });
  });
});
