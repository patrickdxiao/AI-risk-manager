import { describe, expect, it } from "vitest";
import { DomainInvariantError } from "../../../src/core/primitives.js";
import { evaluateTriggers } from "../../../src/core/triggers/evaluateTriggers.js";
import type { TriggerContext } from "../../../src/core/triggers/triggerModel.js";

const base: TriggerContext = {
  version: "trigger-context.v1",
  now: "2026-09-24T12:00:00Z",
  sprint: { id: "sprint-1", startAt: "2026-09-24T11:00:00Z", endAt: "2026-10-02T00:00:00Z" },
  repositoryIds: [],
  evidenceDigests: [],
};
const task: NonNullable<TriggerContext["task"]> = {
  id: "checkout",
  state: "in_progress",
  deadlineAt: base.now,
};
const gitChange: NonNullable<TriggerContext["gitChange"]> = {
  repositoryId: "web",
  occurredAt: base.now,
  digest: "change-digest",
};

describe("deterministic review requests", () => {
  it("allows plan-only scope and requests a deadline review exactly when unfinished work is due", () => {
    expect(evaluateTriggers(base)).toEqual([]);
    expect(evaluateTriggers({ ...base, task, now: "2026-09-24T11:59:59.999Z" })).toEqual([]);
    expect(evaluateTriggers({ ...base, task: { ...task, state: "done" } })).toEqual([]);
    const [candidate] = evaluateTriggers({ ...base, task });
    expect(candidate).toMatchObject({
      type: "task_deadline",
      sprintId: "sprint-1",
      taskId: "checkout",
      repositoryIds: [],
      inputSummary: { deadlineAt: "2026-09-24T12:00:00.000Z" },
    });
    expect(candidate).not.toHaveProperty("state");
  });

  it("uses sprint start for the first cadence and the last review for subsequent cadence", () => {
    const context = { ...base, sprint: { ...base.sprint, reviewCadenceMinutes: 60 } };
    expect(evaluateTriggers({ ...context, now: "2026-09-24T11:59:59.999Z" })).toEqual([]);
    expect(evaluateTriggers(context)).toMatchObject([
      {
        type: "scheduled_review",
        inputSummary: { reviewBaseAt: "2026-09-24T11:00:00.000Z", reviewCadenceMinutes: 60 },
      },
    ]);
    const reviewed = {
      ...context,
      sprint: { ...context.sprint, lastReviewedAt: "2026-09-24T11:30:00Z" },
    };
    expect(evaluateTriggers(reviewed)).toEqual([]);
    expect(evaluateTriggers({ ...reviewed, now: "2026-09-24T12:30:00Z" })).toMatchObject([
      { type: "scheduled_review" },
    ]);
    expect(
      evaluateTriggers({
        ...context,
        sprint: { ...context.sprint, lastReviewedAt: "2026-09-24T13:00:00Z" },
      }),
    ).toEqual([]);
  });

  it("does not schedule before sprint start even if an earlier manual review is supplied", () => {
    const context = {
      ...base,
      sprint: {
        ...base.sprint,
        startAt: "2026-09-25T11:00:00Z",
        reviewCadenceMinutes: 1,
        lastReviewedAt: "2026-09-23T11:00:00Z",
      },
    };
    expect(evaluateTriggers(context)).toEqual([]);
    expect(evaluateTriggers({ ...context, now: "2026-09-25T11:01:00Z" })).toMatchObject([
      { type: "scheduled_review", inputSummary: { reviewBaseAt: "2026-09-25T11:00:00.000Z" } },
    ]);
  });

  it("keeps cadence sprint-wide and Git/deadline requests scoped to the supplied task", () => {
    const candidates = evaluateTriggers({
      ...base,
      repositoryIds: ["web"],
      task,
      gitChange,
      sprint: { ...base.sprint, reviewCadenceMinutes: 30 },
    });
    expect(candidates.map((candidate) => candidate.type)).toEqual([
      "git_change",
      "task_deadline",
      "scheduled_review",
    ]);
    expect(candidates.slice(0, 2).map((candidate) => candidate.taskId)).toEqual([
      "checkout",
      "checkout",
    ]);
    expect(candidates[2]).not.toHaveProperty("taskId");
    expect(candidates[0]?.evidenceDigests).toEqual(["change-digest"]);
    expect(candidates[1]?.evidenceDigests).toEqual([]);
    expect(candidates[2]?.evidenceDigests).toEqual([]);
  });

  it("normalizes sorted unique scope and evidence without changing inputs or granting broader access", () => {
    const repositoryIds = [" web ", "api", "web"];
    const evidenceDigests = [" b ", "a", "a"];
    const candidates = evaluateTriggers({
      ...base,
      repositoryIds,
      evidenceDigests,
      gitChange: { ...gitChange, digest: " b " },
    });
    const [candidate] = candidates;
    expect(candidate).toMatchObject({ repositoryIds: ["api", "web"], evidenceDigests: ["a", "b"] });
    expect(repositoryIds).toEqual([" web ", "api", "web"]);
    expect(evidenceDigests).toEqual([" b ", "a", "a"]);
    repositoryIds.push("unapproved");
    evidenceDigests.push("later");
    expect(candidate?.repositoryIds).toEqual(["api", "web"]);
    expect(candidate?.evidenceDigests).toEqual(["a", "b"]);
    for (const value of [
      candidates,
      candidate,
      candidate?.repositoryIds,
      candidate?.evidenceDigests,
      candidate?.inputSummary,
    ])
      expect(Object.isFrozen(value)).toBe(true);
  });

  it("keeps keys stable across polling, input order, duplicates, whitespace, and timestamp precision", () => {
    const context = {
      ...base,
      repositoryIds: ["web", "api"],
      evidenceDigests: ["a", "b"],
      task,
      gitChange,
      sprint: { ...base.sprint, reviewCadenceMinutes: 30 },
    };
    const equivalent = {
      ...context,
      now: "2026-09-24T12:01:00Z",
      repositoryIds: ["api", " web ", "web"],
      evidenceDigests: ["b", "a", "b"],
      task: { ...task, deadlineAt: "2026-09-24T12:00:00.000Z" },
      gitChange: { ...gitChange, occurredAt: "2026-09-24T12:00:00.000Z" },
    };
    expect(evaluateTriggers(equivalent).map((candidate) => candidate.dedupKey)).toEqual(
      evaluateTriggers(context).map((candidate) => candidate.dedupKey),
    );
  });

  it("distinguishes changed scope, target, Git facts, deadline, and review baseline", () => {
    const context = {
      ...base,
      repositoryIds: ["web", "api"],
      task,
      gitChange,
      sprint: { ...base.sprint, reviewCadenceMinutes: 30 },
    };
    const keys = evaluateTriggers(context).map((candidate) => candidate.dedupKey);
    for (const changed of [
      { ...context, repositoryIds: ["web"] },
      { ...context, sprint: { ...context.sprint, id: "sprint-2" } },
      { ...context, evidenceDigests: ["new-evidence"] },
    ])
      expect(
        evaluateTriggers(changed).every((candidate, index) => candidate.dedupKey !== keys[index]),
      ).toBe(true);
    expect(
      evaluateTriggers({ ...context, task: { ...task, id: "another-task" } })[1]?.dedupKey,
    ).not.toBe(keys[1]);
    for (const change of [
      { ...gitChange, repositoryId: "api" },
      { ...gitChange, digest: "new-digest" },
      { ...gitChange, occurredAt: "2026-09-24T11:59:00Z" },
    ])
      expect(evaluateTriggers({ ...context, gitChange: change })[0]?.dedupKey).not.toBe(keys[0]);
    expect(
      evaluateTriggers({ ...context, task: { ...task, deadlineAt: "2026-09-24T11:59:00Z" } })[1]
        ?.dedupKey,
    ).not.toBe(keys[1]);
    expect(
      evaluateTriggers({
        ...context,
        sprint: { ...context.sprint, lastReviewedAt: "2026-09-24T11:30:00Z" },
      })[2]?.dedupKey,
    ).not.toBe(keys[2]);
  });

  it("does not infer risk from points, dependencies, claims, or missing failure inputs", () => {
    const context = {
      ...base,
      task: {
        ...task,
        deadlineAt: "2026-09-25T00:00:00Z",
        points: 100,
        repeatedFailureCount: 99,
        dependencyIds: ["prerequisite"],
        completionClaim: { supportedByEvidence: false },
      },
    };
    expect(evaluateTriggers(context)).toEqual([]);
    expect(
      evaluateTriggers({
        ...base,
        sprint: { ...base.sprint, reviewCadenceMinutes: Number.MAX_SAFE_INTEGER },
      }),
    ).toEqual([]);
  });
});

describe("invalid trigger contexts", () => {
  it.each([
    { ...base, version: "unknown" as TriggerContext["version"] },
    { ...base, now: "2026-02-30T00:00:00Z" },
    { ...base, sprint: { ...base.sprint, id: " " } },
    { ...base, sprint: { ...base.sprint, endAt: base.sprint.startAt } },
    { ...base, repositoryIds: [" "] },
    { ...base, repositoryIds: Array.from({ length: 101 }, (_, index) => `repo-${String(index)}`) },
    { ...base, evidenceDigests: ["x".repeat(513)] },
    { ...base, gitChange },
    { ...base, repositoryIds: ["api"], gitChange },
    {
      ...base,
      repositoryIds: ["web"],
      gitChange: { ...gitChange, occurredAt: "2026-09-24T12:01:00Z" },
    },
    { ...base, task: { ...task, id: " " } },
    { ...base, task: { ...task, state: "unknown" as typeof task.state } },
    { ...base, task: { ...task, deadlineAt: "yesterday" } },
    { ...base, sprint: { ...base.sprint, reviewCadenceMinutes: 0 } },
    { ...base, sprint: { ...base.sprint, reviewCadenceMinutes: 1.5 } },
    { ...base, sprint: { ...base.sprint, reviewCadenceMinutes: Infinity } },
    { ...base, sprint: { ...base.sprint, reviewCadenceMinutes: 30, lastReviewedAt: "yesterday" } },
  ])("rejects invalid context %# before returning requests", (context) => {
    expect(() => evaluateTriggers(context)).toThrow(DomainInvariantError);
  });
});
