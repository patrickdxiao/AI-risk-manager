import type { FindingFeedbackId, FindingId, ProjectId, UtcTimestamp } from "../primitives.js";

export type FindingFeedbackKind = "confirm" | "dismiss" | "resolve" | "correct";

interface FindingFeedbackCorrection {
  readonly statement: string;
}

export interface FindingFeedback {
  readonly id: FindingFeedbackId;
  readonly findingId: FindingId;
  readonly projectId: ProjectId;
  readonly kind: FindingFeedbackKind;
  readonly note?: string;
  readonly correction?: FindingFeedbackCorrection;
  readonly actor: string;
  readonly source: string;
  readonly createdAt: UtcTimestamp;
}

export interface SubmitFindingFeedbackInput {
  readonly projectId: ProjectId;
  readonly findingId: FindingId;
  readonly kind: FindingFeedbackKind;
  readonly note?: string;
  readonly correction?: FindingFeedbackCorrection;
  readonly actor: string;
  readonly source: string;
}

export interface SubmitFindingFeedbackResult {
  readonly status: "recorded" | "existing";
  readonly feedback: FindingFeedback;
}
