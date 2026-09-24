import { describe, expect, expectTypeOf, it } from "vitest";
import type { Finding } from "../../../src/core/investigation/findingModel.js";
import {
  createFindingFeedback,
  type FindingFeedback,
} from "../../../src/core/risk/findingFeedback.js";
import { aggregateRiskStates, projectCurrentRisk } from "../../../src/core/risk/riskModel.js";
import type {
  RiskSnapshot,
  RiskTransition,
  RiskTransitionCause,
} from "../../../src/core/risk/riskModel.js";

const at = "2026-09-24T08:00:00Z";
const finding = (id: string, state: Finding["state"] = "blocked", createdAt = at): Finding => ({
  id,
  investigationId: "review-1",
  sprintId: "sprint-1",
  state,
  riskType: "stalled_work",
  confidence: 0.8,
  rationale: `Rationale for ${id}`,
  missingEvidence: [],
  nextCheckCondition: "Verify the work",
  createdAt,
});
const feedback = (
  id: string,
  findingId: string,
  kind: FindingFeedback["kind"],
  createdAt = at,
): FindingFeedback =>
  createFindingFeedback({
    id,
    findingId,
    kind,
    actor: "developer",
    source: "dashboard",
    createdAt,
    ...(kind === "correct" ? { correction: { statement: `Correction ${id}` } } : {}),
  });

describe("current risk projection", () => {
  it("keeps missing assessments uncertain and aggregates observed severity", () => {
    expect(aggregateRiskStates([])).toBe("uncertain");
    expect(aggregateRiskStates(["healthy", "healthy"])).toBe("healthy");
    expect(aggregateRiskStates(["healthy", "uncertain", "at_risk"])).toBe("at_risk");
    expect(aggregateRiskStates(["blocked", "healthy", "uncertain"])).toBe("blocked");
    expect(projectCurrentRisk([])).toEqual({ state: "uncertain" });
  });

  it("selects highest severity then newest timestamp and greatest ID without mutating input order", () => {
    const findings = [
      finding("z-old"),
      finding("a-new", "blocked", "2026-09-24T09:00:00Z"),
      finding("z-new", "blocked", "2026-09-24T09:00:00Z"),
      finding("healthy", "healthy", "2026-09-24T10:00:00Z"),
    ];
    const result = projectCurrentRisk(findings);
    expect(result.finding?.id).toBe("z-new");
    expect(result).toEqual(projectCurrentRisk(findings.toReversed()));
    expect(findings[0]?.id).toBe("z-old");
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("hides resolved/dismissed findings but does not turn unknown work healthy", () => {
    const blocked = finding("blocker");
    for (const kind of ["resolve", "dismiss"] as const) {
      const history = new Map([[blocked.id, [feedback("status", blocked.id, kind)]]]);
      expect(projectCurrentRisk([blocked], history)).toEqual({ state: "uncertain" });
      expect(projectCurrentRisk([blocked, finding("healthy", "healthy")], history).state).toBe(
        "healthy",
      );
    }
    expect(blocked.state).toBe("blocked");
  });

  it("applies latest status and correction independently even when feedback is out of order", () => {
    const original = finding("blocker");
    const history = [
      feedback("dismiss", original.id, "dismiss"),
      feedback("correct", original.id, "correct", "2026-09-24T09:00:00Z"),
      feedback("confirm", original.id, "confirm", "2026-09-24T10:00:00Z"),
    ];
    const result = projectCurrentRisk([original], new Map([[original.id, history]]));
    expect(result).toMatchObject({
      state: "blocked",
      statement: "Correction correct",
      feedback: { id: "confirm" },
    });
    expect(result).toEqual(
      projectCurrentRisk([original], new Map([[original.id, history.toReversed()]])),
    );
    expect(original.rationale).toBe("Rationale for blocker");
    expect(history[0]?.kind).toBe("dismiss");
  });

  it("breaks equal-time status and correction ties by ID rather than array order", () => {
    const original = finding("blocker");
    const history = [
      feedback("a-status", original.id, "dismiss"),
      feedback("z-status", original.id, "confirm"),
      feedback("b-correction", original.id, "correct"),
      feedback("y-correction", original.id, "correct"),
    ];
    const result = projectCurrentRisk([original], new Map([[original.id, history]]));
    expect(result).toMatchObject({ state: "blocked", statement: "Correction y-correction" });
    expect(result).toEqual(
      projectCurrentRisk([original], new Map([[original.id, history.toReversed()]])),
    );
  });

  it("ignores feedback for a different finding instead of hiding the selected risk", () => {
    const original = finding("blocker");
    expect(
      projectCurrentRisk(
        [original],
        new Map([[original.id, [feedback("wrong", "another-finding", "resolve")]]]),
      ),
    ).toMatchObject({ state: "blocked", statement: original.rationale });
  });
});

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
