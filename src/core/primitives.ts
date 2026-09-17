export type ProjectId = string;
export type RepositoryId = string;
export type SprintId = string;
export type TaskId = string;
export type EvidenceEventId = string;
export type EvidenceItemId = string;
export type UtcTimestamp = string;

export type PrivacyMode = "metadata_only" | "selected_content";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
