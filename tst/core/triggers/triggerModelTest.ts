import { describe, expectTypeOf, it } from "vitest";
import type {
  TriggerDispatchStore,
  TriggerQueueRecord,
  TriggerType,
} from "../../../src/core/triggers/triggerModel.js";

describe("review queue contracts", () => {
  it("permits explicit multi-repository scope and plan-only scope without a primary repository", () => {
    type Scope = Pick<TriggerQueueRecord, "sprintId" | "taskId" | "repositoryIds">;
    expectTypeOf<{
      sprintId: "sprint-2";
      taskId: "checkout";
      repositoryIds: readonly ["web", "payments"];
    }>().toExtend<Scope>();
    expectTypeOf<{ sprintId: "sprint-2"; repositoryIds: readonly [] }>().toExtend<Scope>();
    expectTypeOf<TriggerQueueRecord["repositoryIds"]>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<
      Extract<keyof TriggerQueueRecord, "projectId" | "repositoryId" | "status">
    >().toEqualTypeOf<never>();
  });

  it("provides global queue admission and due-work selection", () => {
    expectTypeOf<Parameters<TriggerDispatchStore["countPending"]>>().toEqualTypeOf<[]>();
    expectTypeOf<Parameters<TriggerDispatchStore["findNextDue"]>>().toEqualTypeOf<[now: string]>();
  });

  it("names supported manual and observed reasons without inventing unavailable failure inputs", () => {
    expectTypeOf<TriggerType>().toEqualTypeOf<
      "git_change" | "task_deadline" | "scheduled_review" | "manual_review" | "plan_changed"
    >();
  });
});
