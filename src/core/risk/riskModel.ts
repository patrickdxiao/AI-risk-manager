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
