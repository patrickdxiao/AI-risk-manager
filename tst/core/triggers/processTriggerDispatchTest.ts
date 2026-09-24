import { describe, expect, it, vi } from "vitest";
import {
  ExecuteInvestigation,
  InvestigationExecutionError,
  InvestigationRuntimeError,
} from "../../../src/core/investigation/executeInvestigation.js";
import { SubmitInvestigationResult } from "../../../src/core/investigation/submitInvestigationResult.js";
import {
  createInvestigation,
  type Investigation,
  type InvestigationRuntimePort,
} from "../../../src/core/investigation/investigationModel.js";
import { createSprint } from "../../../src/core/planning/planningModel.js";
import { ApplicationError } from "../../../src/core/primitives.js";
import type { UnitOfWorkPort } from "../../../src/core/storageContracts.js";
import { ProcessTriggerDispatch } from "../../../src/core/triggers/processTriggerDispatch.js";
import {
  pendingTriggerDispatch,
  type TriggerQueueRecord,
} from "../../../src/core/triggers/triggerModel.js";
import { executionFixture } from "../../fixtures/executionFixture.js";

const time = "2026-09-24T12:00:00.000Z";
const trigger: TriggerQueueRecord = {
  version: "trigger-queue-record.v1",
  id: "request",
  type: "manual_review",
  sprintId: "sprint",
  repositoryIds: [],
  dedupKey: "manual:request",
  reason: "Review the saved plan",
  inputSummary: {},
  evidenceDigests: [],
  evidenceCitations: [],
  observedAt: time,
  cooldownUntil: time,
};
const options = { leaseMinutes: 11, maxAttempts: 3, retryDelayMinutes: 1 };
const request = (id = "investigation"): Investigation =>
  createInvestigation({ id, sprintId: "sprint", triggerId: trigger.id, requestedAt: time });
const answer = {
  version: "1" as const,
  findings: [
    {
      state: "uncertain" as const,
      confidence: 0.5,
      rationale: "Plan evidence is incomplete",
      missingEvidence: ["Repository observations"],
      nextCheckCondition: "Capture approved repositories",
      evidenceCitations: [],
    },
  ],
};

function setup(seed: Parameters<typeof executionFixture>[0] = {}) {
  const fixture = executionFixture({
    sprints: [
      createSprint({
        id: "sprint",
        pointTarget: 5,
        reviewCadenceMinutes: 60,
        startAt: time,
        endAt: "2026-09-30T00:00:00Z",
        createdAt: time,
        state: "active",
      }),
    ],
    triggers: [trigger],
    dispatches: [pendingTriggerDispatch(trigger.id, time)],
    ...seed,
  });
  let now = time,
    sequence = 0;
  const clock = { now: () => now },
    ids = { next: () => `saved-${String(++sequence)}` };
  const store: UnitOfWorkPort = {
    execute: (work) =>
      fixture.store.execute((context) =>
        work({
          ...context,
          investigations: {
            ...context.investigations,
            add: (value) => context.investigations.save(value),
            findByDedupKey: (key) =>
              Promise.resolve(
                fixture
                  .investigations()
                  .find(
                    (item) =>
                      item.sprintId === key.sprintId &&
                      item.taskId === key.taskId &&
                      item.triggerId === key.triggerId,
                  ),
              ),
          },
          triggerDispatches: {
            ...context.triggerDispatches,
            findNextDue: (timestamp) =>
              Promise.resolve(
                fixture
                  .dispatches()
                  .filter(
                    (item) =>
                      ((item.status === "pending" || item.status === "retry_wait") &&
                        item.dueAt <= timestamp) ||
                      (item.status === "leased" && (item.leaseExpiresAt ?? "") <= timestamp),
                  )
                  .sort(
                    (a, b) =>
                      a.dueAt.localeCompare(b.dueAt) || a.triggerId.localeCompare(b.triggerId),
                  )[0],
              ),
          },
        }),
      ),
  };
  const run = vi.fn(() =>
    Promise.resolve({
      runId: "run",
      sessionId: "session",
      structuredResult: answer,
      usage: { totalTokens: 100 },
    }),
  );
  const runtime: InvestigationRuntimePort = { runInvestigation: run };
  const execute = new ExecuteInvestigation(
    store,
    runtime,
    new SubmitInvestigationResult(store, ids, clock),
    clock,
  );
  const process = (runner: Pick<ExecuteInvestigation, "execute"> = execute) =>
    new ProcessTriggerDispatch(store, runner, ids, clock);
  return {
    ...fixture,
    store,
    runtime,
    run,
    execute,
    process,
    setNow: (value: string) => {
      now = value;
    },
  };
}

describe("saved review delivery", () => {
  it("runs the real executor and atomic acceptance once, then finds no pending work", async () => {
    const f = setup();
    expect(await f.process().execute(options)).toMatchObject({
      status: "completed",
      dispatch: { attempts: 1, leaseVersion: 1 },
    });
    expect(f.investigations()[0]?.status).toBe("completed");
    expect(f.attempts()[0]).toMatchObject({
      status: "succeeded",
      dispatchTriggerId: "request",
      dispatchLeaseVersion: 1,
      usage: { totalTokens: 100 },
    });
    expect(await f.process().execute(options)).toEqual({ status: "none" });
    expect(f.run).toHaveBeenCalledTimes(1);
  });

  it("retries a temporary runtime failure after its due time and retains the first attempt", async () => {
    const f = setup();
    f.run.mockRejectedValueOnce(
      new InvestigationRuntimeError("runtime_unavailable", true, { totalTokens: 30 }),
    );
    expect(await f.process().execute(options)).toMatchObject({
      status: "retry_wait",
      dispatch: { attempts: 1, dueAt: "2026-09-24T12:01:00.000Z" },
    });
    expect(await f.process().execute(options)).toEqual({ status: "none" });
    f.setNow("2026-09-24T12:01:00.000Z");
    expect(await f.process().execute(options)).toMatchObject({
      status: "completed",
      dispatch: { attempts: 2, leaseVersion: 2 },
    });
    expect(f.attempts().map((item) => item.status)).toEqual(["failed", "succeeded"]);
    expect(f.attempts()[0]?.usage?.totalTokens).toBe(30);
  });

  it("ends permanent failures and bounded retry exhaustion", async () => {
    for (const retryable of [false, true]) {
      const f = setup();
      f.run.mockRejectedValue(new InvestigationRuntimeError("runtime_failure", retryable));
      expect(await f.process().execute({ ...options, maxAttempts: 1 })).toMatchObject({
        status: "dead",
      });
      expect(f.attempts()[0]?.usage?.totalTokens).toBeUndefined();
      expect(await f.process().execute(options)).toEqual({ status: "none" });
    }
  });

  it("does not claim or charge delivery while another investigation is live", async () => {
    const f = setup({
      investigations: [
        { ...request("other"), status: "running", executionLeaseUntil: "2026-09-24T12:05:00.000Z" },
      ],
    });
    expect(await f.process().execute(options)).toEqual({ status: "none" });
    expect(f.dispatches()[0]?.attempts).toBe(0);
    expect(f.run).not.toHaveBeenCalled();
  });

  it("releases execution contention without spending a delivery attempt", async () => {
    const f = setup();
    const runner = {
      execute: () => Promise.reject(new InvestigationExecutionError("execution_in_progress", true)),
    };
    expect(await f.process(runner).execute(options)).toMatchObject({
      status: "retry_wait",
      dispatch: { attempts: 0, leaseVersion: 1 },
    });
    f.setNow("2026-09-24T12:01:00.000Z");
    expect(await f.process().execute(options)).toMatchObject({
      status: "completed",
      dispatch: { attempts: 1, leaseVersion: 2 },
    });
  });

  it("recovers an expired delivery without creating another investigation", async () => {
    const f = setup({
      investigations: [request()],
      dispatches: [
        {
          ...pendingTriggerDispatch("request", time),
          status: "leased",
          investigationId: "investigation",
          attempts: 1,
          leaseVersion: 1,
          leaseExpiresAt: time,
        },
      ],
    });
    expect(await f.process().execute(options)).toMatchObject({
      status: "completed",
      dispatch: { attempts: 2, leaseVersion: 2 },
    });
    expect(f.investigations()).toHaveLength(1);
  });

  it("marks exhausted expired work dead and retains unresolved attempt usage", async () => {
    const running = {
      ...request(),
      status: "running" as const,
      startedAt: time,
      executionLeaseUntil: time,
      executionVersion: 1,
      executionAttemptId: "old",
    };
    const f = setup({
      investigations: [running],
      attempts: [
        {
          id: "old",
          investigationId: running.id,
          version: 1,
          status: "running",
          startedAt: time,
          leaseUntil: time,
          timeoutMs: 1,
          queueWaitMs: 0,
          promptVersion: "1",
          resultSchemaVersion: "1",
        },
      ],
      dispatches: [
        {
          ...pendingTriggerDispatch("request", time),
          status: "leased",
          investigationId: running.id,
          attempts: 3,
          leaseVersion: 3,
          leaseExpiresAt: time,
        },
      ],
    });
    expect(await f.process().execute(options)).toMatchObject({
      status: "dead",
      dispatch: { failureCode: "attempt_limit" },
    });
    expect(f.investigations()[0]).toMatchObject({
      status: "failed",
      failure: { retryable: false },
    });
    expect(f.attempts()[0]).toMatchObject({ status: "expired", terminalReason: "attempt_limit" });
    expect(f.attempts()[0]?.usage).toBeUndefined();
    expect(f.run).not.toHaveBeenCalled();
  });

  it("never settles an expired lease or replaces a newer worker's ownership", async () => {
    for (const newer of [false, true]) {
      const f = setup();
      const runner = {
        execute: async () => {
          if (newer)
            await f.store.execute(async ({ triggerDispatches }) => {
              const old = await triggerDispatches.findByTriggerId("request");
              if (old === undefined) throw new Error("Missing dispatch");
              await triggerDispatches.saveFenced({ ...old, leaseVersion: 2 }, 1, "leased");
            });
          else f.setNow("2026-09-24T12:11:00.000Z");
          throw new Error("Provider detail must not be stored");
        },
      };
      expect(await f.process(runner).execute(options)).toEqual({
        status: "stale",
        triggerId: "request",
      });
      expect(f.dispatches()[0]?.status).toBe("leased");
      expect(f.dispatches()[0]?.failureCode).toBeUndefined();
    }
  });

  it("rolls back admission when the lease fence fails", async () => {
    const f = setup({ failFenced: true });
    await expect(f.process().execute(options)).rejects.toMatchObject({
      code: "execution_lease_lost",
    });
    expect(f.investigations()).toEqual([]);
    expect(f.dispatches()[0]?.leaseVersion).toBe(0);
    expect(f.run).not.toHaveBeenCalled();
  });

  it("requires a receipt instead of treating a fulfilled executor call as completion", async () => {
    const f = setup();
    const runner = {
      execute: () =>
        Promise.resolve({
          status: "submitted" as const,
          acceptance: { investigationId: "saved-1", resultDigest: "unverified", completedAt: time },
        }),
    };
    expect(await f.process(runner).execute(options)).toMatchObject({
      status: "retry_wait",
      dispatch: { failureCode: "missing_result" },
    });
  });

  it("recovers a committed receipt after the executor reports a response failure", async () => {
    const f = setup();
    const runner = {
      execute: async (input: Parameters<ExecuteInvestigation["execute"]>[0]) => {
        await f.execute.execute(input);
        throw new Error("Lost response");
      },
    };
    expect(await f.process(runner).execute(options)).toMatchObject({ status: "completed" });
    expect(f.run).toHaveBeenCalledTimes(1);
  });

  it("rejects an unrepresentable retry schedule before admission or runtime work", async () => {
    const f = setup();
    f.run.mockRejectedValue(new InvestigationRuntimeError("runtime_failure", true));
    await expect(
      f.process().execute({ ...options, retryDelayMinutes: Number.MAX_SAFE_INTEGER }),
    ).rejects.toThrow();
    expect(f.run).not.toHaveBeenCalled();
    expect(f.investigations()).toEqual([]);
    expect(f.dispatches()[0]?.status).toBe("pending");
  });

  it("recognizes committed acceptance even when a lost response reports lost execution ownership", async () => {
    const f = setup();
    const runner = {
      execute: async (input: Parameters<ExecuteInvestigation["execute"]>[0]) => {
        await f.execute.execute(input);
        throw new ApplicationError("execution_lease_lost", "Response lost after commit", "attempt");
      },
    };
    expect(await f.process(runner).execute(options)).toMatchObject({ status: "completed" });
    expect(f.run).toHaveBeenCalledTimes(1);
  });

  it("preserves cancellation and rejects invalid options before claiming", async () => {
    const f = setup();
    expect(await f.process().execute({ ...options, signal: AbortSignal.abort() })).toEqual({
      status: "none",
    });
    for (const value of [0, -1, NaN, 0.5, Number.MAX_SAFE_INTEGER + 1])
      await expect(f.process().execute({ ...options, leaseMinutes: value })).rejects.toThrow();
    await expect(
      f.process().execute({ ...options, leaseMinutes: Number.MAX_SAFE_INTEGER }),
    ).rejects.toThrow();
    expect(f.investigations()).toEqual([]);
    expect(f.dispatches()[0]?.status).toBe("pending");
  });

  it("handles lost execution authority without writing a terminal outcome", async () => {
    const f = setup();
    expect(
      await f
        .process({
          execute: () =>
            Promise.reject(new ApplicationError("execution_lease_lost", "Stale", "attempt")),
        })
        .execute(options),
    ).toEqual({ status: "stale", triggerId: "request" });
    expect(f.dispatches()[0]?.status).toBe("leased");
  });
});
