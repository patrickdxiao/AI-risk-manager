import { describe, expect, it, vi } from "vitest";
import { ExecuteInvestigation } from "../../../src/core/investigation/executeInvestigation.js";
import {
  GetInvestigationEvidence,
  GetInvestigationContext,
} from "../../../src/core/investigation/investigationLifecycle.js";
import type {
  InvestigationRuntimePort,
  RunInvestigationInput,
} from "../../../src/core/investigation/investigationModel.js";
import { SubmitInvestigationResult } from "../../../src/core/investigation/submitInvestigationResult.js";
import { GetSprintOverview } from "../../../src/core/risk/riskAssessment.js";
import type { RepositoryObservation } from "../../../src/core/repository/repositoryModel.js";
import { DomainInvariantError } from "../../../src/core/primitives.js";
import { RequestReview } from "../../../src/core/triggers/requestReview.js";
import { ReviewWorker } from "../../../src/core/triggers/reviewWorker.js";
import { ProcessTriggerDispatch } from "../../../src/core/triggers/processTriggerDispatch.js";
import { EvaluateStoredTriggers } from "../../../src/core/triggers/storedTriggerEvaluation.js";
import {
  pendingTriggerDispatch,
  type TriggerQueueRecord,
} from "../../../src/core/triggers/triggerModel.js";
import { executionFixture } from "../../fixtures/executionFixture.js";
import { before, now, evidence, repository, sprint, task } from "../../fixtures/riskFixture.js";

const observation = (repositoryId = repository.id): RepositoryObservation => ({
  repositoryId,
  observedAt: now,
  evidenceIds: [`evidence-${repositoryId}`],
  snapshot: {
    rootPath: `/${repositoryId}`,
    head: "head",
    branch: "main",
    detached: false,
    snapshotDigest: `snapshot-${repositoryId}`,
    status: {
      clean: true,
      stagedCount: 0,
      unstagedCount: 0,
      untrackedCount: 0,
      totalPathCount: 0,
      paths: [],
      pathsTruncated: false,
    },
  },
});
function setup(
  seed: Parameters<typeof executionFixture>[0] = {},
  runtime?: InvestigationRuntimePort,
) {
  const fixture = executionFixture({
    sprints: [sprint("sprint", { reviewCadenceMinutes: 180 })],
    tasks: [task()],
    repositories: [repository],
    ...seed,
  });
  let sequence = 0;
  const ids = { next: () => `saved-${String(++sequence)}` };
  const clock = { now: () => now };
  const run = vi.fn(async (input: RunInvestigationInput) => {
    const prompt = JSON.parse(input.prompt) as { evidenceIds: string[] };
    const context = await new GetInvestigationContext(fixture.store, clock).execute(
      input.attemptToken,
    );
    const ids =
      prompt.evidenceIds.length === 0
        ? context.evidence.slice(0, 1).map((item) => item.id)
        : prompt.evidenceIds;
    const items =
      ids.length === 0
        ? []
        : await new GetInvestigationEvidence(fixture.store, clock).execute(input.attemptToken, ids);
    return {
      runId: "run",
      sessionId: "session",
      usage: { totalTokens: 100 },
      structuredResult: {
        version: "1" as const,
        findings: [
          {
            state: items.length === 0 ? ("uncertain" as const) : ("at_risk" as const),
            riskType: "completion_unverified" as const,
            confidence: 0.5,
            rationale: "Verification is still needed",
            uncertainty: "No passing check was observed",
            nextCheckCondition: "When verification evidence arrives",
            evidenceCitations: items.map((item) => ({ evidenceId: item.id })),
          },
        ],
      },
    };
  });
  const executor = new ExecuteInvestigation(
    fixture.store,
    runtime ?? { runInvestigation: run },
    new SubmitInvestigationResult(fixture.store, ids, clock),
    clock,
  );
  const evaluate = new EvaluateStoredTriggers(fixture.store, ids, clock);
  const process = new ProcessTriggerDispatch(fixture.store, executor, ids, clock);
  return {
    ...fixture,
    run,
    evaluate,
    process,
    overview: new GetSprintOverview(fixture.store, clock),
    requests: new RequestReview(fixture.store, ids, clock),
    worker: new ReviewWorker(evaluate, process),
  };
}
const manual = (requestId: string) => ({
  type: "manual_review" as const,
  requestId,
  sprintId: "sprint",
  repositoryIds: [],
});

describe("one bounded review worker turn", () => {
  it("takes a saved manual request through dispatch, scoped tool reads, atomic acceptance and the risk overview without duplicate work", async () => {
    const fixture = setup({ evidence: [evidence] });
    const input = { ...manual("review-now"), repositoryIds: [repository.id] };
    const request = await fixture.requests.execute(input);
    const turn = await fixture.worker.execute({ repositoryIds: [], reviewLimit: 1 });
    expect(turn.errors).toEqual([]);
    expect(turn.dispatches).toMatchObject([
      { status: "completed", dispatch: { triggerId: request.trigger.id } },
    ]);
    expect(fixture.receipts()).toHaveLength(1);
    expect(fixture.snapshots()).toMatchObject([{ sprintId: "sprint", state: "at_risk" }]);
    expect(await fixture.overview.execute("sprint")).toMatchObject({
      overallRisk: "at_risk",
      confirmedDonePoints: 0,
      sprintRisk: { evidenceIds: [evidence.id] },
    });
    expect(fixture.attempts()[0]?.authority?.toolCalls).toBe(2);
    expect(fixture.tasks.get("task")?.state).toBe("planned");
    expect(await fixture.requests.execute(input)).toMatchObject({
      status: "existing",
    });
    expect(
      (await fixture.worker.execute({ repositoryIds: [], reviewLimit: 1 })).dispatches,
    ).toEqual([]);
    expect(fixture.run).toHaveBeenCalledTimes(1);
  });

  it("recovers selected observations once in a fixed multi-repository scope and leaves other cursors pending", async () => {
    const repositories = [
      repository,
      { ...repository, id: "api", canonicalPath: "/api", gitRoot: "/api" },
      { ...repository, id: "unselected", canonicalPath: "/unselected", gitRoot: "/unselected" },
    ];
    const fixture = setup({
      repositories,
      evidence: repositories.map((repo) => ({
        ...evidence,
        repositoryId: repo.id,
        id: `evidence-${repo.id}`,
      })),
      observations: repositories.map((repo) => observation(repo.id)),
    });
    const turn = await fixture.worker.execute({ repositoryIds: ["repo", "api"], reviewLimit: 2 });
    expect(turn.evaluation?.queued).toHaveLength(2);
    expect(turn.evaluation?.queued.every((item) => item.repositoryIds.join() === "api,repo")).toBe(
      true,
    );
    expect(turn.dispatches.map((item) => item.status)).toEqual(["completed", "completed"]);
    expect(fixture.triggers()).toHaveLength(2);
    expect(
      fixture
        .observations()
        .filter((item) => item.evaluatedSnapshotDigest !== undefined)
        .map((item) => item.repositoryId)
        .sort(),
    ).toEqual(["api", "repo"]);
    expect(
      fixture.observations().find((item) => item.repositoryId === "unselected"),
    ).not.toHaveProperty("evaluatedSnapshotDigest");
    expect(fixture.receipts()).toHaveLength(2);
    expect(
      fixture.attempts().every((item) => item.authority?.repositoryIds.join() === "api,repo"),
    ).toBe(true);
    const repeated = await fixture.worker.execute({
      repositoryIds: ["api", "repo"],
      reviewLimit: 2,
    });
    expect(repeated.evaluation?.queued).toEqual([]);
    expect(repeated.dispatches).toEqual([]);
    expect(fixture.run).toHaveBeenCalledTimes(2);
  });

  it("advances only an admitted Git cursor when unrelated reviews are deferred", async () => {
    const triggers: TriggerQueueRecord[] = Array.from({ length: 99 }, (_, index) => ({
      version: "trigger-queue-record.v1",
      id: `earlier-${String(index)}`,
      type: "manual_review",
      sprintId: "sprint",
      repositoryIds: [],
      dedupKey: `earlier-${String(index)}`,
      reason: "Earlier review",
      inputSummary: {},
      evidenceDigests: [],
      evidenceCitations: [],
      observedAt: before,
      cooldownUntil: before,
    }));
    const repositories = [
      repository,
      { ...repository, id: "api", canonicalPath: "/api", gitRoot: "/api" },
    ];
    const fixture = setup({
      repositories,
      triggers,
      dispatches: triggers.map((item) => pendingTriggerDispatch(item.id, before)),
      evidence: repositories.map((repo) => ({
        ...evidence,
        repositoryId: repo.id,
        id: `evidence-${repo.id}`,
      })),
      observations: repositories.map((repo) => observation(repo.id)),
    });
    const first = await fixture.worker.execute({ repositoryIds: ["repo", "api"], reviewLimit: 1 });
    expect(first.evaluation?.queued).toHaveLength(1);
    expect(first.evaluation?.deferred).toHaveLength(1);
    expect(
      fixture
        .observations()
        .filter((item) => item.evaluatedSnapshotDigest !== undefined)
        .map((item) => item.repositoryId),
    ).toEqual(["api"]);
    const second = await fixture.worker.execute({ repositoryIds: ["api", "repo"], reviewLimit: 1 });
    expect(second.evaluation?.queued).toHaveLength(1);
    expect(second.evaluation?.deferred).toEqual([]);
    expect(fixture.observations().every((item) => item.evaluatedSnapshotDigest !== undefined)).toBe(
      true,
    );
    expect(fixture.triggers().filter((item) => item.type === "git_change")).toHaveLength(2);
  });

  it("drains only its configured batch and preserves each saved request's scope", async () => {
    const fixture = setup();
    for (const requestId of ["one", "two", "three"])
      await fixture.requests.execute(manual(requestId));
    const first = await fixture.worker.execute({ repositoryIds: [repository.id], reviewLimit: 2 });
    expect(first.dispatches).toHaveLength(2);
    expect(fixture.attempts().every((item) => item.authority?.repositoryIds.length === 0)).toBe(
      true,
    );
    expect(fixture.dispatches().filter((item) => item.status === "pending")).toHaveLength(1);
    expect(
      (await fixture.worker.execute({ repositoryIds: [], reviewLimit: 2 })).dispatches,
    ).toHaveLength(1);
    expect(fixture.receipts()).toHaveLength(3);
  });

  it("reports failed evaluation without scope fallback and still drains saved requests", async () => {
    const fixture = setup();
    await fixture.requests.execute(manual("one"));
    const turn = await fixture.worker.execute({ repositoryIds: ["missing"], reviewLimit: 1 });
    expect(turn.errors).toEqual([{ stage: "evaluation", code: "repository_not_found" }]);
    expect(turn.evaluation).toBeUndefined();
    expect(turn.dispatches).toMatchObject([{ status: "completed" }]);
    expect(fixture.triggers()).toHaveLength(1);
  });

  it("stops cleanly before the next dispatch after cancellation", async () => {
    const controller = new AbortController();
    const fixture = setup(
      {},
      {
        runInvestigation: () => {
          controller.abort();
          return new Promise(() => undefined);
        },
      },
    );
    await fixture.requests.execute(manual("one"));
    await fixture.requests.execute(manual("two"));
    const first = await fixture.worker.execute({
      repositoryIds: [],
      reviewLimit: 2,
      signal: controller.signal,
    });
    expect(first.dispatches).toHaveLength(1);
    expect(fixture.dispatches().map((item) => item.status)).toEqual(["dead", "pending"]);
    expect(
      (
        await fixture.worker.execute({
          repositoryIds: [],
          reviewLimit: 2,
          signal: controller.signal,
        })
      ).dispatches,
    ).toEqual([]);
    expect(fixture.attempts()).toHaveLength(1);
  });

  it("reports a delivery infrastructure failure once and does not spin on its due item", async () => {
    const fixture = setup();
    const process = {
      execute: vi.fn(() => Promise.reject(new Error("private infrastructure details"))),
    };
    const worker = new ReviewWorker(fixture.evaluate, process);
    const turn = await worker.execute({ repositoryIds: [], reviewLimit: 10 });
    expect(turn.errors).toEqual([{ stage: "dispatch", code: "persistence_failure" }]);
    expect(process.execute).toHaveBeenCalledTimes(1);
  });

  it("snapshots inputs and rejects unbounded worker loops before any service work", async () => {
    const evaluate = {
      execute: vi.fn(() => Promise.resolve({ fired: [], queued: [], existing: [], deferred: [] })),
    };
    const process = { execute: vi.fn(() => Promise.resolve({ status: "none" as const })) };
    const worker = new ReviewWorker(evaluate, process);
    const input = { repositoryIds: [repository.id], reviewLimit: 1 };
    const result = worker.execute(input);
    input.repositoryIds.push("later");
    input.reviewLimit = 100;
    await result;
    expect(evaluate.execute.mock.calls).toHaveLength(1);
    expect(process.execute).toHaveBeenCalledTimes(1);
    for (const reviewLimit of [0, -1, 11, Number.NaN])
      await expect(worker.execute({ repositoryIds: [], reviewLimit })).rejects.toBeInstanceOf(
        DomainInvariantError,
      );
  });
});
