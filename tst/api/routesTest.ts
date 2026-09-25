import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApiServer } from "../../src/api/httpServer.js";
import { registerPlanningRoutes } from "../../src/api/planningRoutes.js";
import { registerReviewRoutes, type ReviewRouteServices } from "../../src/api/reviewRoutes.js";
import { registerInvestigationTools } from "../../src/api/investigationTools.js";
import { createEvidenceItem } from "../../src/core/evidence/evidenceModel.js";
import { ExecuteInvestigation } from "../../src/core/investigation/executeInvestigation.js";
import { SubmitInvestigationResult } from "../../src/core/investigation/submitInvestigationResult.js";
import type { RunInvestigationInput } from "../../src/core/investigation/investigationModel.js";
import { ProcessTriggerDispatch } from "../../src/core/triggers/processTriggerDispatch.js";
import type { Task } from "../../src/core/planning/planningModel.js";
import { database, seeded } from "../adapters/sqlite/fixture.js";
import { evidence, now, repository, sprint, task } from "../fixtures/riskFixture.js";

const servers: ReturnType<typeof buildApiServer>[] = [];
afterEach(async () => {
  for (const app of servers.splice(0)) await app.close();
});
const token = "x".repeat(43);
function api(db = database(), enabled = false) {
  let sequence = 0;
  const ids = { next: () => `api-${String(++sequence)}` },
    clock = { now: () => now };
  const wakeWorker = vi.fn();
  const capture = vi.fn<ReviewRouteServices["reconcile"]>(() =>
    Promise.resolve({ changed: true, snapshotDigest: "snapshot", evidence: [evidence] }),
  );
  const app = buildApiServer({ token });
  servers.push(app);
  const services = { store: db.store, ids, clock, investigationsEnabled: enabled, wakeWorker };
  registerPlanningRoutes(app, services);
  const register = vi.fn<ReviewRouteServices["registerRepository"]>(() =>
    Promise.resolve(repository),
  );
  const discover = vi.fn<ReviewRouteServices["discoverRepositories"]>(() =>
    Promise.resolve({ repositories: [repository], incomplete: true, issues: ["entry limit"] }),
  );
  registerReviewRoutes(app, {
    ...services,
    registerRepository: register,
    discoverRepositories: discover,
    reconcile: capture,
  });
  registerInvestigationTools(app, { store: db.store, clock, capture });
  const request = (
    method: "GET" | "POST" | "PATCH",
    url: string,
    payload?: object,
    credential = token,
  ) =>
    app.inject({
      method,
      url,
      ...(payload === undefined ? {} : { payload }),
      headers: { authorization: `Bearer ${credential}` },
    });
  async function run(callback: (input: RunInvestigationInput) => Promise<void>, question = false) {
    let callbackError: Error | undefined;
    const runtime = {
      runInvestigation: async (input: RunInvestigationInput) => {
        try {
          await callback(input);
        } catch (error) {
          callbackError =
            error instanceof Error
              ? error
              : new Error("Runtime assertion failed", { cause: error });
          throw error;
        }
        return {
          runId: "scripted",
          sessionId: "fixture",
          latencyMs: 1,
          usage: { totalTokens: 10 },
          structuredResult: {
            version: "1" as const,
            findings: [
              {
                taskId: "task",
                state: "at_risk" as const,
                riskType: "completion_unverified" as const,
                confidence: 0.6,
                rationale: "Verification is missing",
                nextCheckCondition: "When verification arrives",
                evidenceCitations: [{ evidenceId: evidence.id }],
              },
            ],
            ...(question
              ? {
                  question: {
                    taskId: "task",
                    question: "Which check confirms completion?",
                    reason: "completion_criteria" as const,
                  },
                }
              : {}),
          },
        };
      },
    };
    const result = await new ProcessTriggerDispatch(
      db.store,
      new ExecuteInvestigation(
        db.store,
        runtime,
        new SubmitInvestigationResult(db.store, ids, clock),
        clock,
      ),
      ids,
      clock,
    ).execute({ leaseMinutes: 15, maxAttempts: 3, retryDelayMinutes: 1 });
    if (callbackError !== undefined) throw callbackError;
    return result;
  }
  return { db, app, request, run, capture, register, discover, wakeWorker };
}
const plan = {
  startAt: "2026-09-24T00:00:00Z",
  endAt: "2026-10-01T00:00:00Z",
  goal: "Ship checkout",
};

describe("local planning and review HTTP routes on SQLite", () => {
  it("creates a project-free plan, edits versioned tasks, preserves explicit completion and archives ended work", async () => {
    const f = api();
    expect((await f.request("GET", "/api/status")).json()).toEqual({
      investigationsEnabled: false,
    });
    const created = await f.request("POST", "/api/sprints", plan);
    expect(created.statusCode).toBe(201);
    const { sprint: saved } = created.json<{ sprint: { id: string } }>();
    expect((await f.request("GET", "/api/sprints")).json()).toMatchObject({
      sprints: [{ id: saved.id }],
    });
    expect(
      (
        await f.request("PATCH", `/api/sprints/${saved.id}`, {
          assumptions: ["API available"],
          reviewCadenceMinutes: 60,
        })
      ).statusCode,
    ).toBe(200);
    const createdTask = await f.request("POST", "/api/tasks", {
      sprintId: saved.id,
      title: "Checkout",
      points: 3,
      description: "Verify API",
      completionCriteria: ["Passing check"],
    });
    expect(createdTask.statusCode).toBe(201);
    const { task: first } = createdTask.json<{ task: Task }>();
    const patch = await f.request("PATCH", `/api/tasks/${first.id}`, {
      version: 1,
      state: "done",
      description: null,
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toMatchObject({ task: { state: "done", version: 2 } });
    expect(patch.json<{ task: Task }>().task.description).toBeUndefined();
    expect(
      (await f.request("PATCH", `/api/tasks/${first.id}`, { version: 1, title: "Stale" }))
        .statusCode,
    ).toBe(409);
    expect((await f.request("GET", `/api/sprints/${saved.id}/overview`)).json()).toMatchObject({
      confirmedDonePoints: 3,
    });
    await f.db.store.execute(async (tx) => {
      await tx.planning.addSprint(
        sprint("past", {
          state: "completed",
          startAt: "2026-09-01T00:00:00Z",
          endAt: "2026-09-10T00:00:00Z",
        }),
      );
      await tx.planning.addTask(
        task("archived", {
          sprintId: "past",
          state: "done",
          startAt: "2026-09-01T00:00:00Z",
          endAt: "2026-09-10T00:00:00Z",
        }),
      );
    });
    expect((await f.request("GET", "/api/tasks?view=archive")).json()).toMatchObject({
      tasks: [{ id: "archived" }],
    });
    expect(
      (await f.request("POST", "/api/sprints", { ...plan, projectId: "hidden" })).statusCode,
    ).toBe(400);
    expect(
      (await f.request("PATCH", `/api/tasks/${first.id}`, { version: 2, autoComplete: true }))
        .statusCode,
    ).toBe(400);
    expect((await f.request("PATCH", "/api/sprints/missing", { goal: "Missing" })).statusCode).toBe(
      404,
    );
    expect((await f.request("GET", "/api/tasks")).statusCode).toBe(400);
    for (const [url, payload] of [
      ["/api/reviews", {}],
      ["/api/reviews/due", {}],
      ["/api/investigations/missing/answer", {}],
    ] as const)
      expect((await f.request("POST", url, payload)).statusCode).toBe(503);
    expect(f.wakeWorker).not.toHaveBeenCalled();
  });

  it("atomically rolls back planning when the selected review scope cannot be admitted", async () => {
    const f = api(database(), true);
    expect(
      (await f.request("POST", "/api/sprints", { ...plan, repositoryIds: ["unapproved"] }))
        .statusCode,
    ).toBe(404);
    expect((await f.request("GET", "/api/sprints")).json()).toEqual({ sprints: [] });
    expect(f.wakeWorker).not.toHaveBeenCalled();
    const created = await f.request("POST", "/api/sprints", plan);
    expect(created.statusCode).toBe(201);
    const sprintId = created.json<{ sprint: { id: string } }>().sprint.id;
    expect(
      (await f.request("POST", "/api/tasks", { sprintId, title: "Scoped task", points: 2 }))
        .statusCode,
    ).toBe(201);
    expect(
      (await f.request("PATCH", `/api/sprints/${sprintId}`, { goal: "Edited" })).statusCode,
    ).toBe(200);
    const pending = await f.db.store.execute((tx) =>
      tx.triggerQueue.listPendingBySprintId(sprintId, 100),
    );
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every((item) => item.repositoryIds.length === 0)).toBe(true);
    expect(f.wakeWorker).toHaveBeenCalledTimes(3);
  });

  it("routes approved repository operations without inventing project membership or widening scope", async () => {
    const f = api(await seeded(), true);
    expect((await f.request("GET", "/api/repositories")).json()).toEqual({
      repositories: [repository],
    });
    expect(
      (
        await f.request("POST", "/api/repositories", {
          path: "/approved/repo ",
          approvedRoot: "/approved",
        })
      ).statusCode,
    ).toBe(201);
    expect(f.register).toHaveBeenCalledWith({ path: "/approved/repo ", approvedRoot: "/approved" });
    expect(
      (
        await f.request("POST", "/api/repositories/discover", {
          roots: ["/approved"],
          exclusions: ["cache"],
        })
      ).json(),
    ).toMatchObject({ incomplete: true, issues: ["entry limit"] });
    expect(f.discover).toHaveBeenCalledWith({ roots: ["/approved"], exclusions: ["cache"] });
    expect(
      (await f.request("POST", `/api/repositories/${repository.id}/reconcile`)).statusCode,
    ).toBe(200);
    expect(f.capture).toHaveBeenCalledWith({ repositoryId: repository.id });
    const review = {
      sprintId: "sprint",
      repositoryIds: [repository.id],
      requestId: "manual",
      resync: true,
    };
    expect((await f.request("POST", "/api/reviews", review)).statusCode).toBe(202);
    expect(f.capture).toHaveBeenCalledTimes(2);
    expect(
      (await f.request("POST", "/api/reviews", { ...review, resync: false })).json(),
    ).toMatchObject({ status: "existing" });
    expect((await f.request("GET", "/api/sprints/sprint/investigations")).json()).toMatchObject({
      pending: [{ trigger: { repositoryIds: [repository.id] } }],
    });
    expect((await f.request("POST", "/api/reviews/due", { repositoryIds: [] })).statusCode).toBe(
      200,
    );
    expect((await f.request("GET", "/api/investigations/missing")).statusCode).toBe(404);
    expect((await f.request("GET", "/api/evidence/missing")).statusCode).toBe(404);
    expect(
      (
        await f.request("POST", "/api/investigations/missing/answer", {
          answer: "Answer",
          requestId: "a",
        })
      ).statusCode,
    ).toBe(400);
  });

  it("accepts cited reviews, exposes immutable history, saves feedback and idempotent question answers", async () => {
    const f = api(await seeded(), true);
    await f.request("POST", "/api/reviews", {
      sprintId: "sprint",
      repositoryIds: [repository.id],
      requestId: "review",
    });
    const result = await f.run(async (input) => {
      expect(
        (
          await f.request(
            "POST",
            "/api/investigation-tools/risk_get_context",
            {},
            input.attemptToken,
          )
        ).json(),
      ).toMatchObject({ context: { tasks: [{ id: "task" }] } });
      expect(
        (
          await f.request(
            "POST",
            "/api/investigation-tools/risk_get_evidence",
            { evidenceIds: [evidence.id] },
            input.attemptToken,
          )
        ).json(),
      ).toEqual({ evidence: [evidence] });
      expect(
        (
          await f.request(
            "POST",
            "/api/investigation-tools/risk_list_evidence",
            {},
            input.attemptToken,
          )
        ).json(),
      ).toEqual({ evidence: [evidence], truncated: false });
      expect(
        (
          await f.request(
            "POST",
            "/api/investigation-tools/risk_inspect_git",
            { repositoryId: repository.id },
            input.attemptToken,
          )
        ).statusCode,
      ).toBe(200);
      expect(
        (await f.request("GET", "/api/sprints", undefined, input.attemptToken)).statusCode,
      ).toBe(401);
    }, true);
    expect(result.status).toBe("completed");
    const receipt = await f.db.store.execute((tx) =>
      tx.investigations.findLatestSubmittedResult("sprint"),
    );
    if (receipt?.findings[0] === undefined) throw new Error("Missing accepted finding");
    const reviewId = receipt.investigation.id,
      findingId = receipt.findings[0].id;
    expect((await f.request("GET", `/api/investigations/${reviewId}`)).json()).toMatchObject({
      receipt: { resultDigest: receipt.resultDigest },
      attempts: [{ authority: { toolCalls: 4 } }],
    });
    expect((await f.request("GET", `/api/evidence/${evidence.id}`)).json()).toEqual({ evidence });
    expect((await f.request("GET", "/api/sprints/sprint/overview")).json()).toMatchObject({
      tasks: [{ state: "planned", riskState: "at_risk" }],
      confirmedDonePoints: 0,
    });
    expect(
      (
        await f.request("POST", `/api/findings/${findingId}/feedback`, {
          id: "feedback",
          kind: "correct",
          correction: { statement: "Verification ran locally" },
          note: "Awaiting CI",
        })
      ).statusCode,
    ).toBe(200);
    expect((await f.request("GET", `/api/findings/${findingId}/feedback`)).json()).toMatchObject({
      feedback: [{ id: "feedback", actor: "user" }],
    });
    const answer = {
      answer: "A passing checkout integration test",
      requestId: "answer",
      repositoryIds: [repository.id],
    };
    expect(
      (await f.request("POST", `/api/investigations/${reviewId}/answer`, answer)).json(),
    ).toMatchObject({ status: "queued" });
    expect(
      (await f.request("POST", `/api/investigations/${reviewId}/answer`, answer)).json(),
    ).toMatchObject({ status: "existing" });
    expect(
      (
        await f.request("POST", `/api/investigations/${reviewId}/answer`, {
          ...answer,
          answer: "Different answer",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await f.request("POST", `/api/investigations/${reviewId}/answer`, {
          ...answer,
          requestId: "second-action",
        })
      ).json(),
    ).toMatchObject({ status: "queued" });
    expect(
      (
        await f.request("POST", `/api/investigations/${reviewId}/answer`, {
          ...answer,
          requestId: "second-action",
          answer: "Conflicting retry",
        })
      ).statusCode,
    ).toBe(400);
    const requests = await f.db.store.execute((tx) =>
      tx.triggerQueue.listPendingBySprintId("sprint", 100),
    );
    expect(requests.every((request) => request.evidenceCitations.length === 1)).toBe(true);

    expect(
      (
        await f.db.store.execute((tx) => tx.evidence.findScoped({ sprintId: "sprint", limit: 100 }))
      ).filter((item) => item.source === "user"),
    ).toHaveLength(1);
    expect(
      await f.db.store.execute((tx) => tx.investigations.findSubmittedResult(reviewId)),
    ).toEqual(receipt);
  });

  it("charges failed reads, enforces repository scope and denies the thirteenth tool call", async () => {
    const f = api(await seeded(), true);
    await f.request("POST", "/api/reviews", {
      sprintId: "sprint",
      repositoryIds: [repository.id],
      requestId: "budget",
    });
    let attemptToken = "";
    expect(
      (await f.request("POST", "/api/investigation-tools/risk_get_context", {})).statusCode,
    ).toBe(403);
    const result = await f.run(async (input) => {
      attemptToken = input.attemptToken;
      expect(
        (
          await f.request(
            "POST",
            "/api/investigation-tools/risk_get_context",
            { extra: true },
            attemptToken,
          )
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await f.request(
            "POST",
            "/api/investigation-tools/risk_list_evidence",
            { repositoryId: "outside" },
            attemptToken,
          )
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await f.request(
            "POST",
            "/api/investigation-tools/risk_inspect_git",
            { repositoryId: "outside" },
            attemptToken,
          )
        ).statusCode,
      ).toBe(403);
      expect(f.capture).not.toHaveBeenCalled();
      expect(
        (
          await f.request(
            "POST",
            "/api/investigation-tools/risk_get_evidence",
            { evidenceIds: ["missing"] },
            attemptToken,
          )
        ).statusCode,
      ).toBe(404);
      for (let index = 0; index < 8; index++)
        expect(
          (
            await f.request(
              "POST",
              "/api/investigation-tools/risk_list_evidence",
              { repositoryId: repository.id, limit: 1 },
              attemptToken,
            )
          ).statusCode,
        ).toBe(200);
      expect(
        (
          await f.request("POST", "/api/investigation-tools/risk_get_context", {}, attemptToken)
        ).json(),
      ).toMatchObject({ error: { code: "tool_budget_exhausted" } });
    });
    expect(result.status).toBe("completed");
    expect(
      (await f.request("POST", "/api/investigation-tools/risk_get_context", {}, attemptToken))
        .statusCode,
    ).toBe(409);
  });

  it("lists authorized prerequisite evidence from an earlier sprint without granting another repository", async () => {
    const f = api(await seeded(), true);
    const prior = createEvidenceItem({
      id: "prior-evidence",
      eventId: "prior-event",
      sprintId: "previous",
      taskId: "prerequisite",
      source: "user",
      kind: "task_state_change",
      occurredAt: now,
      locator: "saved prerequisite",
      summary: "User reported API ready",
      digest: "prior-digest",
      privacyMode: "metadata_only",
      metadata: {},
    });
    await f.db.store.execute(async (tx) => {
      await tx.planning.addSprint(sprint("previous", { state: "completed" }));
      await tx.planning.addTask(task("prerequisite", { sprintId: "previous" }));
      await tx.planning.saveTask(task("task", { dependencyIds: ["prerequisite"], version: 2 }));
      await tx.evidence.add(prior);
    });
    await f.request("POST", "/api/reviews", {
      sprintId: "sprint",
      taskId: "task",
      repositoryIds: [repository.id],
      requestId: "dependencies",
    });
    const result = await f.run(async (input) => {
      const listed = await f.request(
        "POST",
        "/api/investigation-tools/risk_list_evidence",
        {},
        input.attemptToken,
      );
      expect(
        listed.json<{ evidence: { id: string }[] }>().evidence.map((item) => item.id),
      ).toContain(prior.id);
      const limited = await f.request(
        "POST",
        "/api/investigation-tools/risk_list_evidence",
        { limit: 1 },
        input.attemptToken,
      );
      expect(limited.json()).toMatchObject({ truncated: true });
      f.capture.mockResolvedValueOnce({
        changed: true,
        snapshotDigest: "wrong-scope",
        evidence: [{ ...evidence, repositoryId: "outside" }],
      });
      expect(
        (
          await f.request(
            "POST",
            "/api/investigation-tools/risk_inspect_git",
            { repositoryId: repository.id },
            input.attemptToken,
          )
        ).statusCode,
      ).toBe(403);
    });
    expect(result.status).toBe("completed");
  });

  it("rechecks ownership after Git capture so cancellation cannot return late evidence", async () => {
    const f = api(await seeded(), true);
    await f.request("POST", "/api/reviews", {
      sprintId: "sprint",
      repositoryIds: [repository.id],
      requestId: "cancel",
    });
    const result = await f.run(async (input) => {
      f.capture.mockImplementationOnce(async () => {
        const investigation = await f.db.store.execute((tx) => tx.investigations.findActive(now));
        if (investigation === undefined) throw new Error("Missing active investigation");
        expect(
          (
            await f.request("POST", `/api/investigations/${investigation.id}/cancel`, {
              executionAttemptId: investigation.executionAttemptId,
            })
          ).statusCode,
        ).toBe(204);
        return { changed: true, snapshotDigest: "late", evidence: [evidence] };
      });
      const response = await f.request(
        "POST",
        "/api/investigation-tools/risk_inspect_git",
        { repositoryId: repository.id },
        input.attemptToken,
      );
      expect(response.statusCode).toBe(409);
      expect(response.body).not.toContain(evidence.summary);
    });
    expect(result.status).not.toBe("completed");
    expect(
      await f.db.store.execute((tx) => tx.investigations.findLatestSubmittedResult("sprint")),
    ).toBeUndefined();
  });
});
