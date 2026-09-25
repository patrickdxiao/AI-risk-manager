import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ExecuteInvestigation,
  INVESTIGATION_TIMEOUT_MS,
  InvestigationRuntimeError,
  type ExecuteInvestigationInput,
} from "../../../src/core/investigation/executeInvestigation.js";
import {
  CancelInvestigationAttempt,
  GetInvestigationEvidence,
} from "../../../src/core/investigation/investigationLifecycle.js";
import {
  createInvestigation,
  type InvestigationRuntimePort,
  type InvestigationRuntimeRun,
  type RunInvestigationInput,
} from "../../../src/core/investigation/investigationModel.js";
import { SubmitInvestigationResult } from "../../../src/core/investigation/submitInvestigationResult.js";
import {
  credentialHash,
  ATTEMPT_TOKEN_RESERVATION,
  DAILY_TOKEN_ADMISSION_LIMIT,
} from "../../../src/core/investigation/attemptAuthority.js";
import {
  MAX_REVIEW_REPOSITORIES,
  MAX_REVIEW_SEED_EVIDENCE,
  type ClockPort,
} from "../../../src/core/primitives.js";
import type {
  TriggerDispatch,
  TriggerQueueRecord,
} from "../../../src/core/triggers/triggerModel.js";
import type { UnitOfWorkPort } from "../../../src/core/storageContracts.js";
import { executionFixture } from "../../fixtures/executionFixture.js";
import { before, evidence, now, repository, sprint, task } from "../../fixtures/riskFixture.js";

const investigation = (id = "review", sprintId = "sprint") =>
  createInvestigation({ id, sprintId, triggerId: `trigger-${id}`, requestedAt: before });
const baseInput = (
  overrides: Partial<ExecuteInvestigationInput> = {},
): ExecuteInvestigationInput => ({
  investigationId: "review",
  repositoryIds: [repository.id],
  evidenceIds: [evidence.id],
  context: "Review the saved observations.",
  ...overrides,
});
const answer = (overrides: Partial<InvestigationRuntimeRun> = {}): InvestigationRuntimeRun => ({
  runId: "run",
  sessionId: "session",
  structuredResult: {
    version: "1",
    findings: [
      {
        state: "uncertain",
        confidence: 0.4,
        rationale: "No verification evidence",
        uncertainty: "The checks have not been observed",
        nextCheckCondition: "When checks are captured",
        evidenceCitations: [],
      },
    ],
  },
  ...overrides,
});
function deferred<T>() {
  let done: ((value: T) => void) | undefined;
  let fail: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    done = resolve;
    fail = reject;
  });
  return {
    promise,
    resolve: (value: T) => {
      done?.(value);
    },
    reject: (error: unknown) => {
      fail?.(error);
    },
  };
}
function runtimeHarness() {
  const begun = deferred<RunInvestigationInput>();
  const result = deferred<InvestigationRuntimeRun>();
  const run = vi.fn((input: RunInvestigationInput) => {
    begun.resolve(input);
    return result.promise;
  });
  const runtime: InvestigationRuntimePort = { runInvestigation: run };
  return { runtime, started: begun.promise, ...result };
}
function setup(
  seed: Parameters<typeof executionFixture>[0] = {},
  runtime?: InvestigationRuntimePort,
) {
  const fixture = executionFixture({
    sprints: [sprint()],
    tasks: [task()],
    repositories: [repository],
    evidence: [evidence],
    investigations: [investigation()],
    ...seed,
  });
  let time = now;
  let sequence = 0;
  const clock: ClockPort = { now: () => time };
  const ids = { next: () => `result-${String(++sequence)}` };
  const runner = runtime ?? { runInvestigation: vi.fn(() => Promise.resolve(answer())) };
  const run = vi.spyOn(runner, "runInvestigation");
  const submit = new SubmitInvestigationResult(fixture.store, ids, clock);
  return {
    ...fixture,
    clock,
    runner,
    run,
    submit,
    execute: new ExecuteInvestigation(fixture.store, runner, submit, clock),
    setNow: (value: string) => {
      time = value;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("scoped investigation execution", () => {
  it("starts requested work, authorizes real evidence tools, and accepts one immutable receipt", async () => {
    const runtime = runtimeHarness();
    const fixture = setup({}, runtime.runtime);
    const execution = fixture.execute.execute(baseInput());
    const input = await runtime.started;
    const [attempt] = fixture.attempts();
    expect(attempt).toMatchObject({
      status: "running",
      version: 1,
      authority: {
        repositoryIds: [repository.id],
        credentialHash: credentialHash(input.attemptToken),
        reservedTokens: ATTEMPT_TOKEN_RESERVATION,
      },
    });
    expect(Object.isFrozen(attempt)).toBe(true);
    expect(input.prompt).not.toContain(input.attemptToken);
    expect(JSON.parse(input.prompt) as unknown).toMatchObject({
      investigation: { sprintId: "sprint" },
      repositoryIds: [repository.id],
      evidenceIds: [evidence.id],
    });
    // This read would deadlock if the runtime still held the admission transaction.
    expect(
      await new GetInvestigationEvidence(fixture.store, fixture.clock).execute(input.attemptToken, [
        evidence.id,
      ]),
    ).toEqual([evidence]);
    runtime.resolve(
      answer({
        latencyMs: 12,
        usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
        provider: "provider",
        model: "model",
        runtimeVersion: "runtime1",
        promptVersion: "development-risk.investigator.v2",
        resultSchemaVersion: "provider-result.v2",
        sessionKey: "session-key",
      }),
    );
    const result = await execution;
    expect(result).toMatchObject({
      status: "submitted",
      acceptance: { investigationId: "review", completedAt: now },
    });
    expect(fixture.receipts()).toHaveLength(1);
    expect(fixture.attempts()).toMatchObject([
      {
        status: "succeeded",
        runtimeRunId: "run",
        runtimeSessionKey: "session-key",
        promptVersion: "development-risk.investigator.v2",
        resultSchemaVersion: "provider-result.v2",
        provider: "provider",
        model: "model",
        authority: { toolCalls: 1 },
        usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25, latencyMs: 12 },
      },
    ]);
    expect(JSON.stringify(fixture.attempts())).not.toContain(input.attemptToken);
    expect(fixture.tasks.get("task")?.state).toBe("planned");
    expect(await fixture.execute.execute(baseInput())).toEqual({ ...result, status: "existing" });
    expect(fixture.run).toHaveBeenCalledTimes(1);
    expect(Object.keys(result.acceptance).sort()).toEqual([
      "completedAt",
      "investigationId",
      "resultDigest",
    ]);
  });

  it("keeps plan-only scope explicit and unknown counters absent", async () => {
    const fixture = setup();
    await fixture.execute.execute(baseInput({ repositoryIds: [], evidenceIds: [] }));
    expect(fixture.attempts()).toMatchObject([{ authority: { repositoryIds: [] } }]);
    expect(fixture.attempts()[0]?.usage).toBeUndefined();
    expect(fixture.receipts()[0]?.investigation.usage).toBeUndefined();
  });

  it("allows only one active attempt across different sprints", async () => {
    const runtime = runtimeHarness();
    const fixture = setup(
      {
        sprints: [sprint(), sprint("other")],
        investigations: [investigation(), investigation("other-review", "other")],
      },
      runtime.runtime,
    );
    const first = fixture.execute.execute(baseInput());
    await runtime.started;
    await expect(
      fixture.execute.execute(baseInput({ investigationId: "other-review" })),
    ).rejects.toMatchObject({ failureCode: "execution_in_progress", retryable: true });
    expect(fixture.attempts()).toHaveLength(1);
    runtime.resolve(answer());
    await first;
    await expect(
      fixture.execute.execute(baseInput({ investigationId: "other-review" })),
    ).resolves.toMatchObject({ status: "submitted" });
    expect(fixture.attempts()).toHaveLength(2);
  });

  it("rolls back the claim when evidence, explicit scope, or planning validation fails", async () => {
    for (const input of [
      baseInput({ repositoryIds: [] }),
      baseInput({ repositoryIds: ["missing"] }),
      baseInput({ evidenceIds: ["missing"] }),
    ]) {
      const fixture = setup();
      await expect(fixture.execute.execute(input)).rejects.toBeInstanceOf(Error);
      expect(fixture.investigations()).toEqual([investigation()]);
      expect(fixture.attempts()).toEqual([]);
      expect(fixture.run).not.toHaveBeenCalled();
    }
    for (const seed of [
      { tasks: [task("task", { dependencyIds: ["missing"] })] },
      { evidence: [{ ...evidence, occurredAt: "2027-01-01T00:00:00Z" }] },
    ]) {
      const fixture = setup(seed);
      await expect(fixture.execute.execute(baseInput())).rejects.toBeInstanceOf(Error);
      expect(fixture.attempts()).toEqual([]);
    }
  });

  it("snapshots caller inputs before asynchronous admission reads and rejects invalid bounds", async () => {
    const fixture = setup();
    const input = {
      investigationId: "review",
      repositoryIds: [repository.id],
      evidenceIds: [evidence.id],
      context: "Initial context",
      timeoutMs: 100,
    };
    const result = fixture.execute.execute(input);
    input.investigationId = "missing";
    input.repositoryIds.push("missing");
    input.evidenceIds.push("missing");
    input.context = "Modified context";
    input.timeoutMs = -1;
    await result;
    expect(fixture.run.mock.calls[0]?.[0].prompt).toContain("Initial context");
    expect(fixture.run.mock.calls[0]?.[0].timeoutMs).toBe(100);
    const fresh = setup();
    for (const invalid of [
      { timeoutMs: 0 },
      { timeoutMs: INVESTIGATION_TIMEOUT_MS + 1 },
      { repositoryIds: Array<string>(MAX_REVIEW_REPOSITORIES + 1).fill(repository.id) },
      { evidenceIds: Array<string>(MAX_REVIEW_SEED_EVIDENCE + 1).fill(evidence.id) },
      { context: " " },
      { investigationId: "missing" },
    ])
      await expect(fresh.execute.execute(baseInput(invalid))).rejects.toBeInstanceOf(Error);
    expect(fresh.attempts()).toEqual([]);
  });

  it("keeps failed usage partial, safely retries, and does not persist provider error text", async () => {
    const runInvestigation = vi
      .fn<InvestigationRuntimePort["runInvestigation"]>()
      .mockRejectedValueOnce(
        new InvestigationRuntimeError("runtime_unavailable", true, { inputTokens: 9 }),
      )
      .mockResolvedValueOnce(answer());
    const fixture = setup({}, { runInvestigation });
    await expect(fixture.execute.execute(baseInput())).rejects.toMatchObject({
      failureCode: "runtime_unavailable",
      retryable: true,
    });
    expect(fixture.attempts()).toMatchObject([{ status: "failed", usage: { inputTokens: 9 } }]);
    expect(fixture.attempts()[0]?.usage?.totalTokens).toBeUndefined();
    await fixture.execute.execute(baseInput());
    expect(fixture.attempts().map((attempt) => [attempt.version, attempt.status])).toEqual([
      [1, "failed"],
      [2, "succeeded"],
    ]);
    expect(fixture.attempts()[0]?.authority?.reservedTokens).toBe(ATTEMPT_TOKEN_RESERVATION);
    const secretFailure = setup(
      {},
      {
        runInvestigation: () =>
          Promise.reject(new Error("provider secret token or private content")),
      },
    );
    await expect(secretFailure.execute.execute(baseInput())).rejects.toMatchObject({
      failureCode: "runtime_failure",
    });
    expect(JSON.stringify(secretFailure.investigations())).not.toContain("provider secret");
  });

  it("prevents unresolved failed reservations from exceeding the daily admission budget", async () => {
    const fixture = setup({}, { runInvestigation: () => Promise.reject(new Error("offline")) });
    for (let index = 0; index < DAILY_TOKEN_ADMISSION_LIMIT / ATTEMPT_TOKEN_RESERVATION; index++)
      await expect(fixture.execute.execute(baseInput())).rejects.toMatchObject({
        failureCode: "runtime_failure",
      });
    await expect(fixture.execute.execute(baseInput())).rejects.toMatchObject({
      code: "investigation_budget_exhausted",
    });
    expect(fixture.attempts()).toHaveLength(10);
  });

  it("expires an old attempt on takeover and rejects its late successful answer", async () => {
    const oldRuntime = runtimeHarness();
    const fixture = setup({}, oldRuntime.runtime);
    const oldExecution = fixture.execute.execute(baseInput({ timeoutMs: 100 }));
    await oldRuntime.started;
    fixture.setNow("2026-09-24T02:00:06.000Z");
    const next = new ExecuteInvestigation(
      fixture.store,
      { runInvestigation: () => Promise.resolve(answer()) },
      fixture.submit,
      fixture.clock,
    );
    await next.execute(baseInput());
    oldRuntime.resolve(answer({ usage: { totalTokens: 999 } }));
    await expect(oldExecution).rejects.toMatchObject({ code: "execution_lease_lost" });
    expect(fixture.attempts().map((attempt) => [attempt.status, attempt.usage])).toEqual([
      ["expired", undefined],
      ["succeeded", undefined],
    ]);
    expect(fixture.receipts()).toHaveLength(1);
    expect(fixture.investigations()[0]?.executionVersion).toBe(2);
  });

  it("preserves cancellation when a runtime ignores abort and returns later", async () => {
    const runtime = runtimeHarness();
    const fixture = setup({}, runtime.runtime);
    const execution = fixture.execute.execute(baseInput());
    const input = await runtime.started;
    await new CancelInvestigationAttempt(fixture.store, fixture.clock).execute({
      investigationId: "review",
      executionAttemptId: input.attemptId,
    });
    runtime.resolve(answer());
    await expect(execution).rejects.toMatchObject({ code: "execution_lease_lost" });
    expect(fixture.attempts()).toMatchObject([{ status: "cancelled" }]);
    expect(fixture.attempts()[0]?.usage).toBeUndefined();
    expect(fixture.receipts()).toEqual([]);
  });

  it.each([undefined, "shutdown"])("aborts local waiting safely with reason %s", async (reason) => {
    const runtime = runtimeHarness();
    const fixture = setup({}, runtime.runtime);
    const controller = new AbortController();
    const execution = fixture.execute.execute(baseInput({ signal: controller.signal }));
    const input = await runtime.started;
    controller.abort(reason);
    await expect(execution).rejects.toMatchObject({
      failureCode: reason === "shutdown" ? "runtime_shutdown" : "execution_cancelled",
      retryable: reason === "shutdown",
    });
    expect(input.signal.aborted).toBe(true);
    expect(fixture.attempts()[0]?.usage).toBeUndefined();
    runtime.resolve(answer());
    expect(fixture.receipts()).toEqual([]);
  });

  it("handles synchronous cancellation plus a throwing adapter without an unhandled stop promise", async () => {
    const controller = new AbortController();
    const fixture = setup(
      {},
      {
        runInvestigation: () => {
          controller.abort();
          throw new Error("adapter stopped synchronously");
        },
      },
    );
    await expect(
      fixture.execute.execute(baseInput({ signal: controller.signal })),
    ).rejects.toMatchObject({ failureCode: "execution_cancelled" });
    expect(fixture.attempts()[0]?.status).toBe("cancelled");
  });

  it("checks cancellation again after telemetry persistence, before result acceptance", async () => {
    const controller = new AbortController();
    const fixture = setup();
    let calls = 0;
    const store: UnitOfWorkPort = {
      execute: (work) =>
        fixture.store.execute(async (context) => {
          const result = await work(context);
          if (++calls === 2) controller.abort();
          return result;
        }),
    };
    const executor = new ExecuteInvestigation(store, fixture.runner, fixture.submit, fixture.clock);
    await expect(executor.execute(baseInput({ signal: controller.signal }))).rejects.toMatchObject({
      failureCode: "execution_cancelled",
    });
    expect(fixture.receipts()).toEqual([]);
    expect(fixture.attempts()[0]?.status).toBe("cancelled");
  });

  it("does not start a provider after admission consumed its runtime window", async () => {
    const fixture = setup();
    let calls = 0;
    const store: UnitOfWorkPort = {
      execute: (work) =>
        fixture.store.execute(async (context) => {
          const result = await work(context);
          if (++calls === 1) fixture.setNow("2026-09-24T02:00:00.100Z");
          return result;
        }),
    };
    const executor = new ExecuteInvestigation(store, fixture.runner, fixture.submit, fixture.clock);
    await expect(executor.execute(baseInput({ timeoutMs: 20 }))).rejects.toMatchObject({
      failureCode: "runtime_timeout",
    });
    expect(fixture.run).not.toHaveBeenCalled();
    expect(fixture.attempts()[0]?.usage).toBeUndefined();
  });

  it("does not admit pre-cancelled work and bounds a runtime that never settles", async () => {
    const fixture = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(
      fixture.execute.execute(baseInput({ signal: controller.signal })),
    ).rejects.toMatchObject({ failureCode: "execution_cancelled" });
    expect(fixture.attempts()).toEqual([]);
    vi.useFakeTimers();
    const runtime = runtimeHarness();
    const pending = setup({}, runtime.runtime);
    const execution = pending.execute.execute(baseInput({ timeoutMs: 20 }));
    const outcome = expect(execution).rejects.toMatchObject({
      failureCode: "runtime_timeout",
      retryable: true,
    });
    const input = await runtime.started;
    await vi.advanceTimersByTimeAsync(20);
    await outcome;
    expect(input.signal.aborted).toBe(true);
    expect(pending.attempts()).toMatchObject([
      { status: "failed", authority: { reservedTokens: ATTEMPT_TOKEN_RESERVATION } },
    ]);
    expect(pending.attempts()[0]?.usage).toBeUndefined();
  });

  it.each(["success", "invalid", "abort", "throw"] as const)(
    "clears both deadline timers after %s",
    async (outcome) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const fixture = setup(
        {},
        {
          runInvestigation: () => {
            if (outcome === "throw") throw new Error("Runtime startup failed");
            if (outcome === "abort") controller.abort();
            return Promise.resolve(
              outcome === "invalid"
                ? answer({ structuredResult: { version: "1", findings: [] } })
                : answer(),
            );
          },
        },
      );
      const result = fixture.execute.execute(baseInput({ signal: controller.signal }));
      if (outcome === "success")
        await expect(result).resolves.toMatchObject({ status: "submitted" });
      else await expect(result).rejects.toThrow();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["backward", "invalid", "throw"] as const)(
    "does not extend local waiting or saved authority when the wall clock is %s",
    async (mode) => {
      vi.useFakeTimers();
      const runtime = runtimeHarness();
      const fixture = setup({}, runtime.runtime);
      const execution = fixture.execute.execute(baseInput({ timeoutMs: 60_000 }));
      const rejected = expect(execution).rejects.toThrow();
      const input = await runtime.started;
      const leaseUntil = fixture.attempts()[0]?.leaseUntil;
      vi.spyOn(fixture.clock, "now").mockImplementation(() => {
        if (mode === "throw") throw new Error("Clock unavailable");
        return mode === "invalid" ? "not a timestamp" : before;
      });
      await vi.advanceTimersByTimeAsync(mode === "backward" ? 60_000 : 30_000);
      await rejected;
      expect(input.signal.aborted).toBe(true);
      expect(fixture.attempts()[0]?.leaseUntil).toBe(leaseUntil);
      expect(fixture.attempts()[0]?.authority?.reservedTokens).toBe(ATTEMPT_TOKEN_RESERVATION);
      expect(fixture.receipts()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    answer({ structuredResult: undefined } as unknown as Partial<InvestigationRuntimeRun>),
    answer({ usage: { totalTokens: -1 } }),
    answer({ latencyMs: Number.NaN }),
    answer({ runId: " " }),
    answer({ structuredResult: { version: "1", findings: [] } }),
  ])("rejects malformed runtime output without accepting findings", async (run) => {
    const fixture = setup({}, { runInvestigation: () => Promise.resolve(run) });
    await expect(fixture.execute.execute(baseInput())).rejects.toMatchObject({ retryable: false });
    expect(fixture.receipts()).toEqual([]);
    expect(fixture.attempts()[0]?.status).toBe("failed");
  });

  it("rejects stale planning and revoked scope after provider work", async () => {
    for (const revoke of [false, true]) {
      const runtime = runtimeHarness();
      const fixture = setup({}, runtime.runtime);
      const execution = fixture.execute.execute(baseInput());
      await runtime.started;
      if (revoke) fixture.repositories.delete(repository.id);
      else fixture.tasks.set("task", task("task", { title: "New criteria", version: 2 }));
      runtime.resolve(answer({ usage: { totalTokens: 27 } }));
      await expect(execution).rejects.toMatchObject({ retryable: false });
      expect(fixture.receipts()).toEqual([]);
      expect(fixture.attempts()[0]?.usage?.totalTokens).toBe(27);
    }
  });

  it("does not persist a credential echoed in runtime metadata or findings", async () => {
    for (const metadata of [true, false]) {
      const runtime: InvestigationRuntimePort = {
        runInvestigation: (input) =>
          Promise.resolve(
            metadata
              ? answer({ runId: input.attemptToken })
              : answer({
                  structuredResult: {
                    version: "1",
                    findings: [
                      {
                        state: "uncertain",
                        confidence: 0.3,
                        rationale: input.attemptToken,
                        uncertainty: "unknown",
                        nextCheckCondition: "later",
                        evidenceCitations: [],
                      },
                    ],
                  },
                }),
          ),
      };
      const fixture = setup({}, runtime);
      await expect(fixture.execute.execute(baseInput())).rejects.toMatchObject({
        failureCode: "invalid_runtime_result",
      });
      expect(JSON.stringify(fixture.attempts())).not.toContain("risk_attempt.");
      expect(fixture.receipts()).toEqual([]);
    }
  });

  it("copies only supported telemetry without traversing extra runtime properties", async () => {
    const usage = Object.defineProperty({ inputTokens: 8 }, "ignored", {
      enumerable: true,
      get() {
        throw new Error("Unbounded extra telemetry was traversed");
      },
    });
    const fixture = setup(
      {},
      { runInvestigation: () => Promise.resolve(answer({ usage, latencyMs: 2 })) },
    );
    await fixture.execute.execute(baseInput());
    expect(fixture.attempts()[0]?.usage).toEqual({ inputTokens: 8, latencyMs: 2 });
  });

  it("reports terminal write failure safely while retaining the unresolved attempt", async () => {
    const fixture = setup({}, { runInvestigation: () => Promise.reject(new Error("offline")) });
    let calls = 0;
    const store: UnitOfWorkPort = {
      execute: (work) =>
        ++calls === 2
          ? Promise.reject(new Error("private database path"))
          : fixture.store.execute(work),
    };
    const executor = new ExecuteInvestigation(store, fixture.runner, fixture.submit, fixture.clock);
    await expect(executor.execute(baseInput())).rejects.toMatchObject({
      failureCode: "persistence_failure",
      retryable: true,
    });
    expect(fixture.attempts()[0]?.status).toBe("running");
    expect(fixture.attempts()[0]?.usage).toBeUndefined();
    expect(fixture.receipts()).toEqual([]);
  });

  it("retains usage when acceptance persistence fails and releases no partial receipt", async () => {
    const fixture = setup(
      {},
      { runInvestigation: () => Promise.resolve(answer({ usage: { totalTokens: 42 } })) },
    );
    fixture.failReceiptWrites(true);
    await expect(fixture.execute.execute(baseInput())).rejects.toMatchObject({
      failureCode: "persistence_failure",
      retryable: true,
    });
    expect(fixture.receipts()).toEqual([]);
    expect(fixture.findings()).toEqual([]);
    expect(fixture.attempts()).toMatchObject([{ status: "failed", usage: { totalTokens: 42 } }]);
  });
});

function dispatchSeed(overrides: Partial<TriggerDispatch> = {}) {
  const trigger: TriggerQueueRecord = {
    version: "trigger-queue-record.v1",
    id: "trigger-review",
    sprintId: "sprint",
    type: "manual_review",
    repositoryIds: [repository.id],
    dedupKey: "key",
    reason: "Review now",
    inputSummary: {},
    evidenceDigests: [evidence.digest],
    evidenceCitations: [{ evidenceId: evidence.id, digest: evidence.digest }],
    observedAt: before,
    cooldownUntil: before,
  };
  const dispatch: TriggerDispatch = {
    version: "trigger-dispatch.v1",
    triggerId: trigger.id,
    investigationId: "review",
    status: "leased",
    leaseVersion: 1,
    attempts: 1,
    dueAt: now,
    leaseExpiresAt: "2026-09-24T02:01:00.000Z",
    createdAt: before,
    updatedAt: now,
    ...overrides,
  };
  return { triggers: [trigger], dispatches: [dispatch] };
}

describe("fenced dispatch execution", () => {
  const dispatchLease = { triggerId: "trigger-review", leaseVersion: 1 };
  it("uses the saved dispatch deadline and completes delivery with result acceptance", async () => {
    const runtime = runtimeHarness();
    const fixture = setup(dispatchSeed(), runtime.runtime);
    const execution = fixture.execute.execute(baseInput({ dispatchLease }));
    const input = await runtime.started;
    expect(input.timeoutMs).toBe(55_000);
    runtime.resolve(answer());
    await execution;
    expect(fixture.attempts()).toMatchObject([
      {
        dispatchTriggerId: "trigger-review",
        dispatchLeaseVersion: 1,
        leaseUntil: "2026-09-24T02:01:00.000Z",
      },
    ]);
    expect(fixture.dispatches()).toMatchObject([{ status: "completed" }]);
  });

  it("rejects absent or stale binding and any change to immutable queue scope or seeds", async () => {
    for (const change of [
      {},
      { dispatchLease: { ...dispatchLease, leaseVersion: 2 } },
      { dispatchLease, repositoryIds: [] },
      { dispatchLease, evidenceIds: [] },
    ]) {
      const fixture = setup(dispatchSeed());
      await expect(fixture.execute.execute(baseInput(change))).rejects.toBeInstanceOf(Error);
      expect(fixture.attempts()).toEqual([]);
    }
    const changedDigest = dispatchSeed();
    const fixture = setup({ ...changedDigest, evidence: [{ ...evidence, digest: "changed" }] });
    await expect(fixture.execute.execute(baseInput({ dispatchLease }))).rejects.toMatchObject({
      code: "evidence_scope_mismatch",
    });
    expect(fixture.attempts()).toEqual([]);
    for (const override of [
      { status: "pending" as const },
      { leaseExpiresAt: now },
      { investigationId: "different" },
    ]) {
      const fixture = setup(dispatchSeed(override));
      await expect(fixture.execute.execute(baseInput({ dispatchLease }))).rejects.toMatchObject({
        code: "execution_lease_lost",
      });
      expect(fixture.attempts()).toEqual([]);
    }
  });
});
