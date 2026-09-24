import { describe, expect, it } from "vitest";
import {
  claimInvestigationExecution,
  completeInvestigation,
  createInvestigation,
  failInvestigation,
  retryInvestigation,
  startInvestigation,
  type Investigation,
} from "../../../src/core/investigation/investigationModel.js";
import { DomainInvariantError } from "../../../src/core/primitives.js";

const requestedAt = "2026-09-24T08:00:00Z";
const startedAt = "2026-09-24T08:01:00Z";
const leaseUntil = "2026-09-24T08:02:00Z";
const later = "2026-09-24T08:03:00Z";
const failure = { code: "runtime_unavailable", message: "Gateway unavailable", retryable: true };
const requested = () =>
  createInvestigation({
    id: "review-1",
    sprintId: "sprint-1",
    triggerId: "trigger-1",
    requestedAt,
  });
const running = () => startInvestigation(requested(), startedAt);
const claimed = () => claimInvestigationExecution(running(), { now: startedAt, leaseUntil });

describe("investigation lifecycle", () => {
  it("creates a sprint-wide request or a task request without starting work", () => {
    const sprintReview = requested();
    expect(sprintReview).toEqual({
      id: "review-1",
      sprintId: "sprint-1",
      triggerId: "trigger-1",
      requestedAt: "2026-09-24T08:00:00.000Z",
      status: "requested",
    });
    const taskReview = createInvestigation({ ...sprintReview, taskId: " task-1 " });
    expect(taskReview.taskId).toBe("task-1");
    expect(Object.isFrozen(taskReview)).toBe(true);
  });

  it("completes leased work without retaining execution authority or changing the running record", () => {
    const original = claimed();
    const usage = {
      latencyMs: 1.5,
      inputTokens: 0,
      outputTokens: 5,
      totalTokens: 5,
      estimatedCostUsd: 0.001,
    };
    const completed = completeInvestigation(original, { completedAt: leaseUntil, usage });
    usage.outputTokens = 10;
    expect(completed).toMatchObject({
      status: "completed",
      executionVersion: 1,
      executionAttemptId: "review-1:attempt:1",
      usage: { inputTokens: 0, outputTokens: 5, totalTokens: 5 },
    });
    expect(completed).not.toHaveProperty("executionLeaseUntil");
    expect(original).toMatchObject({
      status: "running",
      executionLeaseUntil: "2026-09-24T08:02:00.000Z",
    });
    expect(Object.isFrozen(completed)).toBe(true);
    expect(Object.isFrozen(completed.usage)).toBe(true);
  });

  it("leaves missing usage absent and does not infer totals or costs from partial reports", () => {
    expect(completeInvestigation(running(), { completedAt: leaseUntil })).not.toHaveProperty(
      "usage",
    );
    expect(completeInvestigation(running(), { completedAt: leaseUntil, usage: {} }).usage).toEqual(
      {},
    );
    expect(
      completeInvestigation(running(), { completedAt: leaseUntil, usage: { inputTokens: 0 } })
        .usage,
    ).toEqual({ inputTokens: 0 });
  });

  it("records a failure before execution starts", () => {
    const failed = failInvestigation(requested(), { completedAt: startedAt, failure });
    expect(failed).toMatchObject({ status: "failed", failure });
    expect(failed).not.toHaveProperty("startedAt");
    expect(failed).not.toHaveProperty("usage");
    expect(Object.isFrozen(failed.failure)).toBe(true);
  });

  it("retries a temporary failure without reusing an attempt ID or previous usage", () => {
    const failed = failInvestigation(claimed(), {
      completedAt: leaseUntil,
      failure,
      usage: { inputTokens: 7 },
    });
    expect(failed).not.toHaveProperty("executionLeaseUntil");
    const retried = retryInvestigation(failed, leaseUntil);
    for (const field of ["failure", "completedAt", "usage", "executionLeaseUntil"])
      expect(retried).not.toHaveProperty(field);
    expect(retried).toMatchObject({
      status: "running",
      executionVersion: 1,
      requestedAt: "2026-09-24T08:00:00.000Z",
    });
    const next = claimInvestigationExecution(retried, { now: leaseUntil, leaseUntil: later });
    expect(next).toMatchObject({ executionVersion: 2, executionAttemptId: "review-1:attempt:2" });
    expect(failed).toMatchObject({ status: "failed", failure, usage: { inputTokens: 7 } });
  });

  it("reclaims an expired lease at its boundary with a new ownership version", () => {
    const original = claimed();
    const recovered = claimInvestigationExecution(original, { now: leaseUntil, leaseUntil: later });
    expect(recovered).toMatchObject({
      executionVersion: 2,
      executionAttemptId: "review-1:attempt:2",
      executionLeaseUntil: "2026-09-24T08:03:00.000Z",
    });
    expect(original.executionVersion).toBe(1);
    expect(Object.isFrozen(recovered)).toBe(true);
  });

  it("rejects lease theft, backwards claims, and empty lease intervals", () => {
    expect(() =>
      claimInvestigationExecution(claimed(), {
        now: "2026-09-24T08:01:59.999Z",
        leaseUntil: later,
      }),
    ).toThrow(DomainInvariantError);
    expect(() => claimInvestigationExecution(running(), { now: requestedAt, leaseUntil })).toThrow(
      DomainInvariantError,
    );
    expect(() =>
      claimInvestigationExecution(running(), { now: startedAt, leaseUntil: startedAt }),
    ).toThrow(DomainInvariantError);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER, null])(
    "rejects an invalid or exhausted ownership version %s",
    (version) => {
      expect(() =>
        claimInvestigationExecution(
          { ...running(), executionVersion: version as number },
          { now: startedAt, leaseUntil },
        ),
      ).toThrow(DomainInvariantError);
    },
  );

  it.each([{ executionAttemptId: "review-1:attempt:3" }, { executionLeaseUntil: startedAt }])(
    "rejects existing execution with no ownership version: %j",
    (execution) => {
      expect(() =>
        claimInvestigationExecution({ ...running(), ...execution }, { now: startedAt, leaseUntil }),
      ).toThrow(DomainInvariantError);
    },
  );

  it("rejects non-retryable failures and transitions out of terminal states", () => {
    const failed = failInvestigation(running(), {
      completedAt: leaseUntil,
      failure: { ...failure, retryable: false },
    });
    const completed = completeInvestigation(running(), { completedAt: leaseUntil });
    for (const value of [failed, completed]) {
      expect(() => startInvestigation(value, later)).toThrow(DomainInvariantError);
      expect(() => completeInvestigation(value, { completedAt: later })).toThrow(
        DomainInvariantError,
      );
      expect(() => failInvestigation(value, { completedAt: later, failure })).toThrow(
        DomainInvariantError,
      );
      expect(() =>
        claimInvestigationExecution(value, { now: leaseUntil, leaseUntil: later }),
      ).toThrow(DomainInvariantError);
      expect(() => retryInvestigation(value, later)).toThrow(DomainInvariantError);
    }
    expect(() => completeInvestigation(requested(), { completedAt: startedAt })).toThrow(
      DomainInvariantError,
    );
  });

  it("preserves chronology through startup, failure, completion, and retry", () => {
    expect(() => startInvestigation(requested(), "2026-09-24T07:59:59Z")).toThrow(
      DomainInvariantError,
    );
    expect(() => completeInvestigation(running(), { completedAt: requestedAt })).toThrow(
      DomainInvariantError,
    );
    expect(() => failInvestigation(running(), { completedAt: requestedAt, failure })).toThrow(
      DomainInvariantError,
    );
    expect(() =>
      failInvestigation(requested(), { completedAt: "2026-09-24T07:59:59Z", failure }),
    ).toThrow(DomainInvariantError);
    const failed = failInvestigation(running(), { completedAt: leaseUntil, failure });
    expect(() => retryInvestigation(failed, startedAt)).toThrow(DomainInvariantError);
  });

  it.each([{ code: " " }, { message: " " }, { retryable: "true" as unknown as boolean }])(
    "rejects invalid failure details: %j",
    (invalid) => {
      expect(() =>
        failInvestigation(running(), {
          completedAt: leaseUntil,
          failure: { ...failure, ...invalid },
        }),
      ).toThrow(DomainInvariantError);
    },
  );

  it.each([
    { latencyMs: -1 },
    { latencyMs: Number.POSITIVE_INFINITY },
    { inputTokens: 1.5 },
    { inputTokens: Number.MAX_SAFE_INTEGER + 1 },
    { outputTokens: -1 },
    { totalTokens: 1.5 },
    { estimatedCostUsd: Number.NaN },
    { estimatedCostUsd: -0.001 },
  ])("rejects invalid reported usage: %j", (usage) => {
    expect(() => completeInvestigation(running(), { completedAt: leaseUntil, usage })).toThrow(
      DomainInvariantError,
    );
  });

  it("does not restart corrupt legacy failure records before their recorded start", () => {
    const legacy: Investigation = { ...running(), status: "failed", failure };
    expect(() => retryInvestigation(legacy, requestedAt)).toThrow(DomainInvariantError);
  });
});
