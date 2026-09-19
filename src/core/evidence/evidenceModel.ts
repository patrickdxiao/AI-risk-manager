import type {
  EvidenceEventId,
  EvidenceItemId,
  JsonValue,
  PrivacyMode,
  RepositoryId,
  SprintId,
  TaskId,
  UtcTimestamp,
} from "../primitives.js";
export type EvidenceSource = "git" | "openclaw" | "user" | "replay" | "system";

export type EvidenceKind =
  | "repository_snapshot"
  | "commit"
  | "worktree_change"
  | "branch_change"
  | "upstream_relation"
  | "agent_claim"
  | "observed_failure"
  | "task_state_change"
  | "runtime_status"
  | "periodic_review";

export interface SelectedEvidenceContent {
  readonly text: string;
  readonly truncated: boolean;
}

export interface EvidenceItem {
  readonly id: EvidenceItemId;
  readonly eventId: EvidenceEventId;
  /** Repository provenance is independent of the sprint or task using the evidence. */
  readonly repositoryId?: RepositoryId;
  readonly sprintId?: SprintId;
  readonly taskId?: TaskId;
  readonly source: EvidenceSource;
  readonly kind: EvidenceKind;
  readonly occurredAt: UtcTimestamp;
  readonly locator: string;
  readonly summary: string;
  readonly digest: string;
  readonly privacyMode: PrivacyMode;
  readonly metadata: Readonly<Record<string, JsonValue>>;
  readonly selectedContent?: SelectedEvidenceContent;
}

export interface CreateEvidenceItemInput extends Omit<EvidenceItem, "occurredAt"> {
  readonly occurredAt: string;
}

export interface EvidenceQuery {
  /** Retrieval filters do not grant access beyond the attempt's approved repositories. */
  readonly sprintId?: SprintId;
  readonly taskId?: TaskId | null;
  readonly repositoryId?: RepositoryId;
  readonly source?: EvidenceSource;
  readonly kinds?: readonly EvidenceKind[];
  readonly occurredSince?: string;
  readonly occurredThrough?: string;
  readonly limit: number;
}
