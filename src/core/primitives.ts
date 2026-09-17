export type ProjectId = string;
export type RepositoryId = string;
export type SprintId = string;
export type TaskId = string;
export type EvidenceEventId = string;
export type EvidenceItemId = string;
export type InvestigationId = string;
export type FindingId = string;
export type FindingFeedbackId = string;
export type UtcTimestamp = string;

export type PrivacyMode = "metadata_only" | "selected_content";
export type RiskState = "healthy" | "uncertain" | "at_risk" | "blocked";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
