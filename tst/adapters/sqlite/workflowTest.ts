import { describe, expect, it, vi } from "vitest";
import { ExecuteInvestigation } from "../../../src/core/investigation/executeInvestigation.js";
import {
  GetInvestigationContext,
  GetInvestigationEvidence,
} from "../../../src/core/investigation/investigationLifecycle.js";
import type { RunInvestigationInput } from "../../../src/core/investigation/investigationModel.js";
import { SubmitInvestigationResult } from "../../../src/core/investigation/submitInvestigationResult.js";
import { RequestReview } from "../../../src/core/triggers/requestReview.js";
import { ProcessTriggerDispatch } from "../../../src/core/triggers/processTriggerDispatch.js";
import { EvaluateStoredTriggers } from "../../../src/core/triggers/storedTriggerEvaluation.js";
import { ReviewWorker } from "../../../src/core/triggers/reviewWorker.js";
import { GetSprintOverview } from "../../../src/core/risk/riskAssessment.js";
import { evidence, repository, now } from "../../fixtures/riskFixture.js";
import { database, observation, seeded } from "./fixture.js";

function services(db: ReturnType<typeof database>) {
  let time = now,
    sequence = 0;
  const ids = { next: () => `record-${String(++sequence)}` };
  const clock = { now: () => time };
  const calls = vi.fn(async (input: RunInvestigationInput) => {
    const context = await new GetInvestigationContext(db.store, clock).execute(input.attemptToken);
    expect(context.evidence.map((item) => item.id)).toContain(evidence.id);
    const records = await new GetInvestigationEvidence(db.store, clock).execute(
      input.attemptToken,
      [evidence.id],
    );
    expect(records).toEqual([evidence]);
    return {
      runId: "run",
      sessionId: "session",
      provider: "scripted",
      model: "fixture",
      latencyMs: 10,
      usage: { totalTokens: 100 },
      structuredResult: {
        version: "1" as const,
        findings: [
          {
            state: "at_risk" as const,
            riskType: "completion_unverified" as const,
            confidence: 0.6,
            rationale: "Commit lacks a passing verification",
            nextCheckCondition: "When a check result arrives",
            evidenceCitations: [{ evidenceId: evidence.id }],
          },
        ],
      },
    };
  });
  const executor = new ExecuteInvestigation(
    db.store,
    { runInvestigation: calls },
    new SubmitInvestigationResult(db.store, ids, clock),
    clock,
  );
  return {
    calls,
    clock,
    setTime(value: string) {
      time = value;
    },
    requests: new RequestReview(db.store, ids, clock),
    worker: new ReviewWorker(
      new EvaluateStoredTriggers(db.store, ids, clock),
      new ProcessTriggerDispatch(db.store, executor, ids, clock),
    ),
    overview: new GetSprintOverview(db.store, clock),
  };
}
const manual = {
  type: "manual_review" as const,
  requestId: "review-once",
  sprintId: "sprint",
  repositoryIds: [repository.id],
};

describe("review workflow on real SQLite", () => {
  it("reopens a saved request, authenticates scoped reads, accepts cited risk atomically and never runs a duplicate review", async () => {
    const first = await seeded();
    const request = await services(first).requests.execute(manual);
    first.close();
    const reopened = database(first.path);
    const flow = services(reopened);
    const turn = await flow.worker.execute({ repositoryIds: [], reviewLimit: 1 });
    expect(turn.errors).toEqual([]);
    expect(turn.dispatches).toMatchObject([
      { status: "completed", dispatch: { triggerId: request.trigger.id } },
    ]);
    const receipt = await reopened.store.execute((tx) =>
      tx.investigations.findLatestSubmittedResult("sprint"),
    );
    expect(receipt?.findings).toHaveLength(1);
    expect(await flow.overview.execute("sprint")).toMatchObject({
      overallRisk: "at_risk",
      confirmedDonePoints: 0,
      sprintRisk: { evidenceIds: [evidence.id] },
    });
    const attempts = await reopened.store.execute((tx) => tx.investigations.listAttemptsSince(now));
    expect(attempts).toMatchObject([
      {
        status: "succeeded",
        authority: { toolCalls: 2, repositoryIds: [repository.id] },
        usage: { totalTokens: 100 },
      },
    ]);
    expect(attempts[0]?.usage?.estimatedCostUsd).toBeUndefined();
    expect(JSON.stringify(attempts)).not.toContain("risk_attempt.");
    expect(await flow.requests.execute(manual)).toMatchObject({ status: "existing" });
    expect((await flow.worker.execute({ repositoryIds: [], reviewLimit: 1 })).dispatches).toEqual(
      [],
    );
    expect(flow.calls).toHaveBeenCalledTimes(1);
    reopened.close();
    const final = database(first.path);
    expect(
      await final.store.execute((tx) => tx.investigations.findLatestSubmittedResult("sprint")),
    ).toEqual(receipt);
    expect(await final.store.execute((tx) => tx.planning.findTaskById("task"))).toMatchObject({
      state: "planned",
      version: 1,
    });
  });

  it("rolls back partial acceptance when receipt persistence fails, then retries the same durable request", async () => {
    const db = await seeded();
    const flow = services(db);
    await flow.requests.execute(manual);
    db.raw.exec(
      "CREATE TRIGGER fail_receipt BEFORE INSERT ON investigation_results BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END",
    );
    const first = await flow.worker.execute({ repositoryIds: [], reviewLimit: 1 });
    expect(first.dispatches).toMatchObject([{ status: "retry_wait" }]);
    for (const table of [
      "findings",
      "finding_evidence",
      "risk_snapshots",
      "risk_transitions",
      "investigation_results",
    ])
      expect(db.raw.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.["count"]).toBe(0);
    db.raw.exec("DROP TRIGGER fail_receipt");
    flow.setTime("2026-09-24T02:02:00.000Z");
    const retried = await flow.worker.execute({ repositoryIds: [], reviewLimit: 1 });
    expect(retried.dispatches).toMatchObject([{ status: "completed" }]);
    expect(await db.store.execute((tx) => tx.investigations.listAttemptsSince(now))).toMatchObject([
      { version: 1, status: "failed" },
      { version: 2, status: "succeeded" },
    ]);
    expect(
      db.raw.prepare("SELECT count(*) AS count FROM investigation_results").get()?.["count"],
    ).toBe(1);
    expect(flow.calls).toHaveBeenCalledTimes(2);
  });

  it("admits each exact pending observation once and advances its cursor in the queue transaction", async () => {
    const db = await seeded();
    await db.store.execute((tx) => tx.repositoryObservations.save(observation()));
    const flow = services(db);
    const first = await flow.worker.execute({ repositoryIds: [repository.id], reviewLimit: 1 });
    expect(first.evaluation?.queued).toHaveLength(1);
    expect(first.dispatches).toMatchObject([{ status: "completed" }]);
    expect(
      await db.store.execute((tx) => tx.repositoryObservations.listPendingEvaluation(10)),
    ).toEqual([]);
    const second = await flow.worker.execute({ repositoryIds: [repository.id], reviewLimit: 1 });
    expect(second.evaluation?.queued).toEqual([]);
    expect(second.dispatches).toEqual([]);
    expect(flow.calls).toHaveBeenCalledTimes(1);
  });
});
