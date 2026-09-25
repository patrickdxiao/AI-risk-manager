import { execFileSync, fork } from "node:child_process";
import { once } from "node:events";
import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReviewScheduler } from "../../../src/api/reviewScheduler.js";
import type { InvestigationRuntimePort } from "../../../src/core/investigation/investigationModel.js";
import { ExecuteInvestigation } from "../../../src/core/investigation/executeInvestigation.js";
import { GetInvestigationContext } from "../../../src/core/investigation/investigationLifecycle.js";
import { SubmitInvestigationResult } from "../../../src/core/investigation/submitInvestigationResult.js";
import { RequestReview } from "../../../src/core/triggers/requestReview.js";
import { ProcessTriggerDispatch } from "../../../src/core/triggers/processTriggerDispatch.js";
import { EvaluateStoredTriggers } from "../../../src/core/triggers/storedTriggerEvaluation.js";
import { ReviewWorker } from "../../../src/core/triggers/reviewWorker.js";
import { evidence, repository, now } from "../../fixtures/riskFixture.js";
import { database, seeded, temporaryDirectory } from "./fixture.js";

import { compiledPath } from "./compiledFixture.js";

afterEach(() => vi.useRealTimers());

const answer = {
  version: "1" as const,
  findings: [
    {
      state: "at_risk" as const,
      riskType: "completion_unverified" as const,
      confidence: 0.6,
      rationale: "Saved evidence lacks verification",
      nextCheckCondition: "New verification",
      evidenceCitations: [{ evidenceId: evidence.id }],
    },
  ],
};
const manual = {
  type: "manual_review" as const,
  requestId: "crash-review",
  sprintId: "sprint",
  repositoryIds: [repository.id],
};
function services(db: ReturnType<typeof database>) {
  let sequence = 0;
  const ids = { next: () => `parent-${String(++sequence)}` };
  const clock = { now: () => new Date().toISOString() };
  const run = vi.fn<InvestigationRuntimePort["runInvestigation"]>(() =>
    Promise.resolve({
      runId: "recovered",
      sessionId: "recovered",
      structuredResult: answer,
      usage: { totalTokens: 100 },
    }),
  );
  const submit = new SubmitInvestigationResult(db.store, ids, clock);
  const worker = new ReviewWorker(
    new EvaluateStoredTriggers(db.store, ids, clock),
    new ProcessTriggerDispatch(
      db.store,
      new ExecuteInvestigation(db.store, { runInvestigation: run }, submit, clock),
      ids,
      clock,
    ),
  );
  return { run, submit, worker, clock };
}

async function killedWriter(
  path: string,
  mode: "transaction" | "running" | "accepted",
  atBoundary?: () => void | Promise<void>,
) {
  const child = fork(
    resolve(import.meta.dirname, "crashWorker.mjs"),
    [compiledPath(), path, mode, now],
    {
      silent: true,
    },
  );
  let diagnostic = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    diagnostic += chunk.toString();
  });
  const exited = once(child, "exit");
  try {
    const ready = await Promise.race([
      once(child, "message", { signal: AbortSignal.timeout(10_000) }).then(
        ([message]) => message as { stage: string; token?: string },
      ),
      exited.then(() => {
        throw new Error(`Child exited before crash boundary: ${diagnostic}`);
      }),
    ]);
    expect(ready.stage).toBe(mode === "transaction" ? "uncommitted" : mode);
    await atBoundary?.();
    child.kill("SIGKILL");
    expect(await exited).toEqual([null, "SIGKILL"]);
    return ready;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  }
}

describe("abrupt SQLite process recovery", () => {
  it("keeps committed WAL state and discards every partial write after SIGKILL", async () => {
    const original = await seeded();
    original.close();
    const snapshot = join(temporaryDirectory(), "pending-writer.sqlite");
    await killedWriter(original.path, "transaction", () => {
      execFileSync(
        process.execPath,
        [compiledPath("adapters/sqlite/stateSnapshot.js"), original.path, snapshot],
        { stdio: "pipe" },
      );
    });
    const backedUp = database(snapshot);
    expect(
      await backedUp.store.execute((tx) => tx.planning.findTaskById("committed-child")),
    ).toMatchObject({ id: "committed-child" });
    expect(
      await backedUp.store.execute((tx) => tx.planning.findTaskById("uncommitted-child")),
    ).toBeUndefined();
    expect(statSync(`${original.path}-wal`).size).toBeGreaterThan(0);
    const recovered = database(original.path);
    expect(
      await recovered.store.execute((tx) => tx.planning.findTaskById("committed-child")),
    ).toMatchObject({ id: "committed-child" });
    expect(
      await recovered.store.execute((tx) => tx.planning.findTaskById("uncommitted-child")),
    ).toBeUndefined();
    expect(
      await recovered.store.execute((tx) => tx.evidence.findById("uncommitted-evidence")),
    ).toBeUndefined();
    expect(await recovered.store.execute((tx) => tx.evidence.findById(evidence.id))).toEqual(
      evidence,
    );
    expect(recovered.raw.prepare("PRAGMA integrity_check").get()?.["integrity_check"]).toBe("ok");
  });

  it("waits for an orphaned lease, resumes on the next scheduler tick after a clock gap, and fences stale workers", async () => {
    const original = await seeded();
    const request = await new RequestReview(
      original.store,
      { next: () => "request" },
      { now: () => now },
    ).execute(manual);
    original.close();
    const abandoned = await killedWriter(original.path, "running");
    const recovered = database(original.path);
    const oldDispatch = await recovered.store.execute((tx) =>
      tx.triggerDispatches.findByTriggerId(request.trigger.id),
    );
    expect(oldDispatch).toMatchObject({ status: "leased", leaseVersion: 1, attempts: 1 });
    if (oldDispatch === undefined) throw new Error("Missing claimed dispatch");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const flow = services(recovered);
    const execute = vi.fn(flow.worker.execute.bind(flow.worker));
    const scheduler = new ReviewScheduler({ execute }, vi.fn());
    try {
      scheduler.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(execute).toHaveBeenCalledOnce();
      expect(flow.run).not.toHaveBeenCalled();
      // Advancing wall time alone represents sleep: interval callbacks were not delivered during it.
      vi.setSystemTime("2026-09-24T02:20:00.000Z");
      await expect(
        new GetInvestigationContext(recovered.store, flow.clock).execute(abandoned.token ?? ""),
      ).rejects.toMatchObject({ code: "execution_lease_lost" });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(execute).toHaveBeenCalledTimes(2);
      expect(flow.run).toHaveBeenCalledOnce();
      const dispatch = await recovered.store.execute((tx) =>
        tx.triggerDispatches.findByTriggerId(request.trigger.id),
      );
      expect(dispatch).toMatchObject({ status: "completed", leaseVersion: 2, attempts: 2 });
      expect(
        await recovered.store.execute((tx) => tx.investigations.listAttemptsSince(now)),
      ).toMatchObject([
        { status: "expired", version: 1 },
        { status: "succeeded", version: 2 },
      ]);
      expect(
        await recovered.store.execute((tx) =>
          tx.triggerDispatches.saveFenced(oldDispatch, 1, "leased"),
        ),
      ).toBe(false);
      await expect(
        flow.submit.execute({ token: abandoned.token ?? "", result: answer }),
      ).rejects.toMatchObject({ code: "execution_lease_lost" });
      expect(
        recovered.raw.prepare("SELECT count(*) AS count FROM investigation_results").get()?.[
          "count"
        ],
      ).toBe(1);
      const unresolved = await recovered.store.execute((tx) =>
        tx.investigations.listUnsettledAttempts(),
      );
      expect(unresolved).toMatchObject([{ version: 1, authority: { reservedTokens: 20_000 } }]);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(flow.run).toHaveBeenCalledOnce();
    } finally {
      await scheduler.stop();
    }
  });

  it("abandons expired local waiting after a suspended clock resumes and recovers through the scheduler", async () => {
    const db = await seeded();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const flow = services(db);
    await new RequestReview(db.store, { next: () => "request" }, flow.clock).execute(manual);
    let abandonedSignal: AbortSignal | undefined;
    flow.run.mockImplementationOnce((input) => {
      abandonedSignal = input.signal;
      return new Promise(() => undefined);
    });
    const scheduler = new ReviewScheduler(flow.worker, vi.fn());
    try {
      scheduler.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(flow.run).toHaveBeenCalledOnce();
      vi.setSystemTime("2026-09-24T02:20:00.000Z");
      await vi.advanceTimersByTimeAsync(30_000);
      expect(abandonedSignal?.aborted).toBe(true);
      expect(flow.run).toHaveBeenCalledTimes(2);
      expect(
        await db.store.execute((tx) => tx.investigations.listAttemptsSince(now)),
      ).toMatchObject([
        { version: 1, status: "expired" },
        { version: 2, status: "succeeded" },
      ]);
      expect(
        db.raw.prepare("SELECT count(*) AS count FROM investigation_results").get()?.["count"],
      ).toBe(1);
    } finally {
      await scheduler.stop();
    }
  });

  it("retains an accepted receipt and completed dispatch after SIGKILL without calling the provider again", async () => {
    const original = await seeded();
    const request = await new RequestReview(
      original.store,
      { next: () => "request" },
      { now: () => now },
    ).execute(manual);
    original.close();
    await killedWriter(original.path, "accepted");
    const recovered = database(original.path);
    const receipt = await recovered.store.execute((tx) =>
      tx.investigations.findLatestSubmittedResult("sprint"),
    );
    expect(receipt?.findings).toHaveLength(1);
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-24T02:20:00.000Z");
    const flow = services(recovered);
    const result = await flow.worker.execute({ repositoryIds: [], reviewLimit: 1 });
    expect(result.dispatches).toEqual([]);
    expect(
      await recovered.store.execute((tx) =>
        tx.triggerDispatches.findByTriggerId(request.trigger.id),
      ),
    ).toMatchObject({ status: "completed", leaseVersion: 1 });
    expect(flow.run).not.toHaveBeenCalled();
    expect(
      await recovered.store.execute((tx) => tx.investigations.findLatestSubmittedResult("sprint")),
    ).toEqual(receipt);
    expect(
      recovered.raw.prepare("SELECT count(*) AS count FROM investigation_results").get()?.["count"],
    ).toBe(1);
  });
});
