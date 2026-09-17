import type {
  EvidenceEventId,
  EvidenceItemId,
  JsonValue,
  PrivacyMode,
  ProjectId,
  RepositoryId,
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
  readonly projectId: ProjectId;
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
  readonly projectId: ProjectId;
  readonly taskId?: TaskId | null;
  readonly repositoryId?: RepositoryId;
  readonly source?: EvidenceSource;
  readonly kinds?: readonly EvidenceKind[];
  readonly occurredSince?: string;
  readonly occurredThrough?: string;
  readonly limit: number;
}
