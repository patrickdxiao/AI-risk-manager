import {
  DomainInvariantError,
  normalizeJsonRecord,
  requireNonBlank,
  requireUtcTimestamp,
  type EvidenceEventId,
  type EvidenceItemId,
  type JsonValue,
  type PrivacyMode,
  type RepositoryId,
  type SprintId,
  type TaskId,
  type UtcTimestamp,
} from "../primitives.js";
const evidenceSources = ["git", "openclaw", "user", "replay", "system"] as const;
export type EvidenceSource = (typeof evidenceSources)[number];

const repositoryEvidenceKinds = [
  "repository_snapshot",
  "commit",
  "worktree_change",
  "branch_change",
  "upstream_relation",
] as const;
const evidenceKinds = [
  ...repositoryEvidenceKinds,
  "agent_claim",
  "observed_failure",
  "task_state_change",
  "runtime_status",
  "periodic_review",
] as const;
export type EvidenceKind = (typeof evidenceKinds)[number];

export interface SelectedEvidenceContent {
  readonly text: string;
  readonly truncated: boolean;
}

export interface EvidenceItem {
  readonly id: EvidenceItemId;
  readonly eventId: EvidenceEventId;
  /** Required for repository-derived evidence, independently of its sprint or task. */
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

export function requiresRepositoryId(item: Pick<EvidenceItem, "source" | "kind">): boolean {
  return item.source === "git" || repositoryEvidenceKinds.some((kind) => kind === item.kind);
}

/** Validate an immutable observation; access and disclosure permissions are checked by services. */
export function createEvidenceItem(input: CreateEvidenceItemInput): EvidenceItem {
  for (const [field, valid] of [
    ["source", evidenceSources.includes(input.source)],
    ["kind", evidenceKinds.includes(input.kind)],
    ["privacyMode", ["metadata_only", "selected_content"].includes(input.privacyMode)],
  ] as const)
    if (!valid)
      throw new DomainInvariantError("invalid_value", `${field} is not recognized`, field);
  const repositoryId =
    input.repositoryId === undefined
      ? undefined
      : requireNonBlank(input.repositoryId, "repositoryId", 200);
  if (repositoryId === undefined && requiresRepositoryId(input))
    throw new DomainInvariantError(
      "required",
      "repository-derived evidence requires repositoryId",
      "repositoryId",
    );
  if (input.privacyMode === "metadata_only" && input.selectedContent !== undefined)
    throw new DomainInvariantError(
      "invalid_value",
      "metadata-only evidence cannot contain selected content",
      "selectedContent",
    );
  let selectedContent: SelectedEvidenceContent | undefined;
  if (input.selectedContent !== undefined) {
    const { text, truncated } = input.selectedContent;
    requireNonBlank(text, "selectedContent.text");
    if (text.length > 8_000)
      throw new DomainInvariantError(
        "out_of_range",
        "selected content exceeds 8000 characters",
        "selectedContent.text",
      );
    if (typeof truncated !== "boolean")
      throw new DomainInvariantError(
        "invalid_value",
        "truncated must be a boolean",
        "selectedContent.truncated",
      );
    selectedContent = Object.freeze({ text, truncated });
  }
  const sprintId =
    input.sprintId === undefined ? undefined : requireNonBlank(input.sprintId, "sprintId", 200);
  const taskId =
    input.taskId === undefined ? undefined : requireNonBlank(input.taskId, "taskId", 200);
  return Object.freeze({
    id: requireNonBlank(input.id, "id", 200),
    eventId: requireNonBlank(input.eventId, "eventId", 200),
    ...(repositoryId === undefined ? {} : { repositoryId }),
    ...(sprintId === undefined ? {} : { sprintId }),
    ...(taskId === undefined ? {} : { taskId }),
    source: input.source,
    kind: input.kind,
    occurredAt: requireUtcTimestamp(input.occurredAt, "occurredAt"),
    locator: requireNonBlank(input.locator, "locator", 4_096),
    summary: requireNonBlank(input.summary, "summary"),
    digest: requireNonBlank(input.digest, "digest", 512),
    privacyMode: input.privacyMode,
    metadata: normalizeJsonRecord(input.metadata, "metadata"),
    ...(selectedContent === undefined ? {} : { selectedContent }),
  });
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
