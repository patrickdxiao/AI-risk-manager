import { describe, expect, expectTypeOf, it } from "vitest";
import type { EvidenceItem, EvidenceQuery } from "../../../src/core/evidence/evidenceModel.js";
import type { CreateFindingInput, Finding } from "../../../src/core/investigation/findingModel.js";
import type {
  Investigation,
  InvestigationAttempt,
} from "../../../src/core/investigation/investigationModel.js";
import type {
  CreateSprintInput,
  CreateTaskInput,
  Sprint,
} from "../../../src/core/planning/planningModel.js";
import type { Repository } from "../../../src/core/repository/repositoryModel.js";
import type {
  FindingFeedback,
  SubmitFindingFeedbackInput,
} from "../../../src/core/risk/findingFeedback.js";
import {
  createSprint,
  createTask,
  transitionTaskState,
  type SprintState,
  type TaskState,
} from "../../../src/core/planning/planningModel.js";
import { DomainInvariantError } from "../../../src/core/primitives.js";

const sprintInput = {
  id: "sprint-2",
  startAt: "2026-09-21T00:00:00Z",
  endAt: "2026-10-02T23:59:59Z",
  reviewCadenceMinutes: 30,
  pointTarget: 8,
  createdAt: "2026-09-18T00:00:00Z",
};
const taskInput = {
  id: "checkout-ui",
  sprintId: "sprint-2",
  title: "Show checkout totals",
  points: 3,
  startAt: sprintInput.startAt,
  endAt: sprintInput.endAt,
  createdAt: sprintInput.createdAt,
};

describe("sprint validation", () => {
  it("normalizes a sprint and copies its assumptions without mutating the input", () => {
    const assumptions = [" API is ready "];
    const sprint = createSprint({ ...sprintInput, goal: " Ship checkout ", assumptions });
    assumptions[0] = "changed";
    expect(sprint).toMatchObject({
      state: "planned",
      goal: "Ship checkout",
      assumptions: ["API is ready"],
      startAt: "2026-09-21T00:00:00.000Z",
    });
    expect(Object.isFrozen(sprint)).toBe(true);
    expect(Object.isFrozen(sprint.assumptions)).toBe(true);
  });

  it("allows zero target points and an explicitly active sprint without inventing a goal", () => {
    const sprint = createSprint({ ...sprintInput, pointTarget: 0, state: "active" });
    expect(sprint).toMatchObject({ pointTarget: 0, state: "active", assumptions: [] });
    expect(sprint).not.toHaveProperty("goal");
  });

  it.each([
    { endAt: sprintInput.startAt },
    { endAt: "2026-09-20T00:00:00Z" },
    { reviewCadenceMinutes: 0 },
    { reviewCadenceMinutes: 1.5 },
    { reviewCadenceMinutes: Number.MAX_SAFE_INTEGER + 1 },
    { pointTarget: -1 },
    { pointTarget: Number.MAX_SAFE_INTEGER + 1 },
    { state: "missing" as SprintState },
    { assumptions: Array.from({ length: 101 }, () => "assumption") },
  ])("rejects invalid sprint details %j", (invalid) => {
    expect(() => createSprint({ ...sprintInput, ...invalid })).toThrow(DomainInvariantError);
  });
});

describe("task validation", () => {
  it("retains missing criteria and normalizes independent dependency and path lists", () => {
    const dependencyIds = [" earlier-sprint-task "];
    const pathHints = [" web/src "];
    const task = createTask({
      ...taskInput,
      title: " Show totals ",
      description: " In cents ",
      dependencyIds,
      pathHints,
    });
    dependencyIds.push("later-edit");
    pathHints[0] = "changed";
    expect(task).toMatchObject({
      title: "Show totals",
      description: "In cents",
      state: "planned",
      version: 1,
      dependencyIds: ["earlier-sprint-task"],
      completionCriteria: [],
      pathHints: ["web/src"],
    });
    for (const value of [task, task.dependencyIds, task.completionCriteria, task.pathHints])
      expect(Object.isFrozen(value)).toBe(true);
  });

  it("preserves supplied criteria, version, state, and update time", () => {
    expect(
      createTask({
        ...taskInput,
        state: "in_progress",
        version: 2,
        completionCriteria: [" Formats dollars "],
        updatedAt: "2026-09-22T00:00:00Z",
      }),
    ).toMatchObject({
      state: "in_progress",
      version: 2,
      completionCriteria: ["Formats dollars"],
      updatedAt: "2026-09-22T00:00:00.000Z",
    });
  });

  it.each([
    { title: " " },
    { title: "x".repeat(501) },
    { id: "x".repeat(201) },
    { sprintId: " " },
    { description: "x".repeat(8_001) },
    { points: 0 },
    { points: 1.5 },
    { points: Number.MAX_SAFE_INTEGER + 1 },
    { version: 0 },
    { version: Number.MAX_SAFE_INTEGER + 1 },
    { state: "missing" as TaskState },
    { endAt: taskInput.startAt },
    { endAt: "2026-09-20T00:00:00Z" },
    { updatedAt: "2026-09-17T00:00:00Z" },
    { dependencyIds: [" checkout-ui "] },
    { dependencyIds: ["task-1", " task-1 "] },
    { dependencyIds: Array.from({ length: 1_001 }, (_, index) => `task-${String(index)}`) },
    { completionCriteria: [" "] },
    { completionCriteria: Array.from({ length: 51 }, () => "criterion") },
    { pathHints: ["x".repeat(4_097)] },
  ])("rejects invalid task details %j", (invalid) => {
    expect(() => createTask({ ...taskInput, ...invalid })).toThrow(DomainInvariantError);
  });
});

describe("task transitions", () => {
  const occurredAt = "2026-09-22T00:00:00Z";

  it.each(["runtime", undefined, null])("rejects unrecognized actor %j", (actor) => {
    expect(() =>
      transitionTaskState(createTask(taskInput), {
        to: "done",
        actor: actor as "user",
        occurredAt,
      }),
    ).toThrow(DomainInvariantError);
  });

  it.each([
    ["planned", "in_progress"],
    ["planned", "done"],
    ["in_progress", "planned"],
    ["in_progress", "done"],
    ["needs_confirmation", "in_progress"],
    ["needs_confirmation", "done"],
    ["done", "in_progress"],
  ] as const)(
    "allows the developer to change %s to %s and advances the edit version",
    (state, to) => {
      const original = createTask({ ...taskInput, state });
      const result = transitionTaskState(original, { to, actor: "user", occurredAt });
      expect(result.task).toMatchObject({
        state: to,
        version: 2,
        updatedAt: "2026-09-22T00:00:00.000Z",
      });
      expect(result.transition).toMatchObject({
        taskId: original.id,
        from: state,
        to,
        actor: "user",
      });
      expect(original).toMatchObject({ state, version: 1 });
      for (const value of [result, result.task, result.transition])
        expect(Object.isFrozen(value)).toBe(true);
    },
  );

  it.each(["planned", "in_progress"] as const)(
    "allows an investigation to request confirmation from %s",
    (state) => {
      const result = transitionTaskState(createTask({ ...taskInput, state }), {
        to: "needs_confirmation",
        actor: "investigation",
        occurredAt,
      });
      expect(result.task.state).toBe("needs_confirmation");
    },
  );

  it.each(["planned", "in_progress", "needs_confirmation", "done"] as const)(
    "never lets an investigation mark %s work done",
    (state) => {
      expect(() =>
        transitionTaskState(createTask({ ...taskInput, state }), {
          to: "done",
          actor: "investigation",
          occurredAt,
        }),
      ).toThrow(DomainInvariantError);
    },
  );

  it("rejects a no-op, a reversed timestamp, and version overflow", () => {
    const task = createTask(taskInput);
    expect(() => transitionTaskState(task, { to: "planned", actor: "user", occurredAt })).toThrow(
      DomainInvariantError,
    );
    expect(() =>
      transitionTaskState(task, { to: "done", actor: "user", occurredAt: "2026-09-17T00:00:00Z" }),
    ).toThrow(DomainInvariantError);
    expect(() =>
      transitionTaskState(createTask({ ...taskInput, version: Number.MAX_SAFE_INTEGER }), {
        to: "done",
        actor: "user",
        occurredAt,
      }),
    ).toThrow(DomainInvariantError);
  });
});

describe("planning without project grouping", () => {
  it("accepts a sprint and dependent task without a project or repository assignment", () => {
    expectTypeOf<{
      id: "sprint-2";
      startAt: "2026-09-21T00:00:00Z";
      endAt: "2026-10-02T23:59:59Z";
      reviewCadenceMinutes: 30;
      pointTarget: 8;
      createdAt: "2026-09-18T00:00:00Z";
    }>().toExtend<CreateSprintInput>();
    expectTypeOf<{
      id: "checkout-ui";
      sprintId: "sprint-2";
      title: "Show checkout totals";
      points: 3;
      dependencyIds: readonly ["payments-api-from-sprint-1"];
      createdAt: "2026-09-18T00:00:00Z";
    }>().toExtend<CreateTaskInput>();
  });

  it("allows reusable repository evidence and findings with multiple citations", () => {
    expectTypeOf<{
      id: "web";
      canonicalPath: "/approved/web";
      gitRoot: "/approved/web";
      identityDigest: "web-identity";
      registeredAt: "2026-09-18T00:00:00Z";
    }>().toExtend<Repository>();
    // A repository observation does not need a sprint or task assignment to be retained.
    expectTypeOf<{
      id: "web-observation";
      eventId: "capture-1";
      repositoryId: "web";
      source: "git";
      kind: "repository_snapshot";
      occurredAt: "2026-09-18T00:00:00Z";
      locator: "git:web";
      summary: "Captured repository metadata";
      digest: "snapshot-digest";
      privacyMode: "metadata_only";
      metadata: Record<string, never>;
    }>().toExtend<EvidenceItem>();
    expectTypeOf<{
      id: "checkout-finding";
      investigationId: "review-1";
      sprintId: "sprint-2";
      taskId: "checkout-ui";
      state: "uncertain";
      confidence: 0.3;
      rationale: "Repository metadata does not verify the checkout behavior";
      createdAt: "2026-09-18T00:00:00Z";
      evidenceCitations: readonly [
        { evidenceId: "web-observation" },
        { evidenceId: "payments-observation" },
      ];
    }>().toExtend<CreateFindingInput>();
  });

  it("keeps repository approval explicit and links corrections directly to findings", () => {
    type Authority = NonNullable<InvestigationAttempt["authority"]>;
    expectTypeOf<Authority>().toExtend<{
      readonly credentialHash: string;
      readonly repositoryIds: readonly string[];
      readonly planningDigest: string;
      readonly toolCalls: number;
      readonly reservedTokens: number;
    }>();
    expectTypeOf<{ repositoryId: "web"; limit: 20 }>().toExtend<EvidenceQuery>();
    expectTypeOf<{
      id: "correction-request";
      findingId: "checkout-finding";
      kind: "correct";
      correction: { statement: "The prerequisite was completed in the previous sprint" };
      actor: "developer";
      source: "dashboard";
    }>().toExtend<SubmitFindingFeedbackInput>();
  });

  it("removes project ownership from all planning, evidence, and review records", () => {
    type RecordKeys =
      | keyof Sprint
      | keyof CreateSprintInput
      | keyof Repository
      | keyof EvidenceItem
      | keyof EvidenceQuery
      | keyof Investigation
      | keyof InvestigationAttempt
      | keyof Finding
      | keyof FindingFeedback
      | keyof SubmitFindingFeedbackInput;
    expectTypeOf<Extract<RecordKeys, "projectId">>().toEqualTypeOf<never>();
  });
});
