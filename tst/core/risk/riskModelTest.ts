import { describe, expectTypeOf, it } from "vitest";
import type {
  RiskSnapshot,
  RiskTransition,
  RiskTransitionCause,
} from "../../../src/core/risk/riskModel.js";

describe("risk contracts", () => {
  it("retains sprint scope for both overall risk and individual tasks", () => {
    expectTypeOf<{
      id: "snapshot";
      sprintId: "sprint-2";
      state: "uncertain";
      createdAt: "2026-09-24T00:00:00Z";
    }>().toExtend<RiskSnapshot>();
    expectTypeOf<RiskSnapshot["taskId"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<
      Extract<keyof RiskSnapshot | keyof RiskTransition, "projectId" | "repositoryId">
    >().toEqualTypeOf<never>();
  });

  it("distinguishes changes caused by accepted findings from developer feedback", () => {
    expectTypeOf<RiskTransitionCause>().toEqualTypeOf<
      | { readonly type: "finding"; readonly findingId: string }
      | { readonly type: "feedback"; readonly feedbackId: string }
    >();
  });
});
