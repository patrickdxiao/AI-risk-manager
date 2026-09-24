import type { Finding } from "../investigation/findingModel.js";
import type {
  FindingFeedbackId,
  FindingId,
  RiskState,
  SprintId,
  TaskId,
  UtcTimestamp,
} from "../primitives.js";
import type { FindingFeedback } from "./findingFeedback.js";

export type RiskTransitionCause =
  | { readonly type: "finding"; readonly findingId: FindingId }
  | { readonly type: "feedback"; readonly feedbackId: FindingFeedbackId };

export interface RiskSnapshot {
  readonly id: string;
  readonly sprintId: SprintId;
  readonly taskId?: TaskId;
  readonly state: RiskState;
  readonly findingId?: FindingId;
  readonly createdAt: UtcTimestamp;
}

export interface RiskTransition {
  readonly id: string;
  readonly sprintId: SprintId;
  readonly taskId?: TaskId;
  readonly from: RiskState | null;
  readonly to: RiskState;
  readonly cause: RiskTransitionCause;
  readonly occurredAt: UtcTimestamp;
}

/** Feedback affects the current reading without rewriting the accepted finding. */
export interface CurrentRiskAssessment {
  readonly state: RiskState;
  readonly finding?: Finding;
  readonly feedback?: FindingFeedback;
  readonly statement?: string;
}

const PRECEDENCE: Readonly<Record<RiskState, number>> = {
  healthy: 0,
  uncertain: 1,
  at_risk: 2,
  blocked: 3,
};

/** No assessment means unknown; otherwise retain the most severe observed risk state. */
export function aggregateRiskStates(states: readonly RiskState[]): RiskState {
  return states.reduce<RiskState>(
    (current, state) => (PRECEDENCE[state] > PRECEDENCE[current] ? state : current),
    states.length === 0 ? "uncertain" : "healthy",
  );
}

/**
 * Project the current accepted findings without changing them or completing tasks.
 * Latest status feedback hides (dismiss/resolve) or restores (confirm) a finding.
 * Latest correction changes its displayed wording independently of status feedback.
 * Highest risk wins; newest timestamp then lexicographically greatest ID breaks finding/feedback ties.
 */
export function projectCurrentRisk(
  findings: readonly Finding[],
  currentFeedback: ReadonlyMap<FindingId, readonly FindingFeedback[]> = new Map(),
): CurrentRiskAssessment {
  const active = findings
    .map((finding) => ({
      finding,
      history: (currentFeedback.get(finding.id) ?? [])
        .filter((item) => item.findingId === finding.id)
        .sort(newestFirst),
    }))
    .filter(({ history }) => {
      const status = history.find((item) => item.kind !== "correct")?.kind;
      return status !== "dismiss" && status !== "resolve";
    })
    .sort(
      (left, right) =>
        PRECEDENCE[right.finding.state] - PRECEDENCE[left.finding.state] ||
        newestFirst(left.finding, right.finding),
    );
  const selected = active[0];
  if (selected === undefined) return Object.freeze({ state: "uncertain" });
  const { finding, history } = selected;
  const feedback = history[0];
  const correction = history.find((item) => item.kind === "correct");
  return Object.freeze({
    state: finding.state,
    finding,
    ...(feedback === undefined ? {} : { feedback }),
    statement: correction?.correction?.statement ?? finding.rationale,
  });
}

function newestFirst(
  left: { readonly id: string; readonly createdAt: UtcTimestamp },
  right: { readonly id: string; readonly createdAt: UtcTimestamp },
): number {
  return (
    Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
    (left.id === right.id ? 0 : left.id < right.id ? 1 : -1)
  );
}
