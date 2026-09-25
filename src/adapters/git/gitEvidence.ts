import { createHash } from "node:crypto";
import {
  createEvidenceItem,
  type EvidenceItem,
  type EvidenceKind,
} from "../../core/evidence/evidenceModel.js";
import type { JsonValue } from "../../core/primitives.js";
import type {
  RepositoryInspection,
  RepositoryStatusPath,
  RepositoryStatusSummary,
} from "./inspectRepository.js";
export const GIT_EVIDENCE_PATH_LIMIT = 50;

export type DerivedGitEvidenceKind = Extract<
  EvidenceKind,
  "repository_snapshot" | "commit" | "branch_change" | "worktree_change"
>;

export interface GitEvidenceIds {
  readonly eventId: string;
  readonly evidenceItemId: string;
}

export interface GitEvidenceIdFactory {
  next(kind: DerivedGitEvidenceKind): GitEvidenceIds;
}

export interface DeriveGitEvidenceInput {
  readonly previous?: RepositoryInspection;
  readonly current: RepositoryInspection;
  readonly repositoryId: string;
  readonly observedAt: string;
  readonly idFactory: GitEvidenceIdFactory;
}

/** Reports invalid scope, identifiers, or paths in a Git snapshot. */
export class GitEvidenceDerivationError extends Error {
  override readonly name = "GitEvidenceDerivationError";

  constructor(
    readonly code: "snapshot_scope_mismatch" | "invalid_identifier" | "invalid_status_path",
    message: string,
  ) {
    super(message);
  }
}

interface NormalizedStatus extends Readonly<Record<string, JsonValue>> {
  readonly clean: boolean;
  readonly stagedCount: number;
  readonly unstagedCount: number;
  readonly untrackedCount: number;
  readonly totalPathCount: number;
  readonly paths: readonly NormalizedStatusPath[];
  readonly pathsTruncated: boolean;
}

interface NormalizedStatusPath extends Readonly<Record<string, JsonValue>> {
  readonly path: string;
  readonly staged: boolean;
  readonly unstaged: boolean;
  readonly untracked: boolean;
}

/** Converts snapshot differences into scoped evidence records.
 * @returns No records when the snapshot digest is unchanged.
 * @throws GitEvidenceDerivationError when snapshots belong to different worktrees. */
export function deriveGitEvidence(input: DeriveGitEvidenceInput): readonly EvidenceItem[] {
  const repositoryId = identifier(input.repositoryId, "repositoryId");
  if (input.previous !== undefined && input.previous.rootPath !== input.current.rootPath) {
    throw new GitEvidenceDerivationError(
      "snapshot_scope_mismatch",
      "previous and current Git snapshots must describe the same worktree",
    );
  }

  const currentStatus = normalizeStatus(input.current.status);
  if (input.previous === undefined) {
    return Object.freeze([
      evidence(
        input,
        repositoryId,
        "repository_snapshot",
        {
          repositoryId,
          head: input.current.head,
          branch: input.current.branch,
          detached: input.current.detached,
          status: currentStatus,
        },
        snapshotSummary(input.current, currentStatus),
      ),
    ]);
  }
  if (input.previous.snapshotDigest === input.current.snapshotDigest) return Object.freeze([]);

  const previousStatus = normalizeStatus(input.previous.status);
  const events: EvidenceItem[] = [];
  if (input.previous.head !== input.current.head) {
    events.push(
      evidence(
        input,
        repositoryId,
        "commit",
        {
          repositoryId,
          previousHead: input.previous.head,
          head: input.current.head,
          branch: input.current.branch,
        },
        `HEAD changed from ${shortHead(input.previous.head)} to ${shortHead(input.current.head)}`,
      ),
    );
  }
  if (input.previous.branch !== input.current.branch) {
    events.push(
      evidence(
        input,
        repositoryId,
        "branch_change",
        {
          repositoryId,
          previousBranch: input.previous.branch,
          branch: input.current.branch,
          head: input.current.head,
          detached: input.current.detached,
        },
        `Branch changed from ${branchName(input.previous.branch)} to ${branchName(input.current.branch)}`,
      ),
    );
  }
  if (
    JSON.stringify(previousStatus) !== JSON.stringify(currentStatus) ||
    (input.previous.head === input.current.head && input.previous.branch === input.current.branch)
  ) {
    events.push(
      evidence(
        input,
        repositoryId,
        "worktree_change",
        {
          repositoryId,
          head: input.current.head,
          branch: input.current.branch,
          snapshotDigest: input.current.snapshotDigest,
          before: previousStatus,
          after: currentStatus,
        },
        `Worktree changed: ${String(currentStatus.stagedCount)} staged, ${String(currentStatus.unstagedCount)} unstaged, ${String(currentStatus.untrackedCount)} untracked`,
      ),
    );
  }
  return Object.freeze(events);
}

/** Creates one evidence record with a digest over its scope and metadata. */
function evidence(
  input: DeriveGitEvidenceInput,
  repositoryId: string,
  kind: DerivedGitEvidenceKind,
  metadata: Readonly<Record<string, JsonValue>>,
  summary: string,
): EvidenceItem {
  const ids = input.idFactory.next(kind);
  const eventId = identifier(ids.eventId, `${kind}.eventId`);
  const evidenceItemId = identifier(ids.evidenceItemId, `${kind}.evidenceItemId`);
  const normalizedMetadata = Object.freeze({ ...metadata });
  const digest = createHash("sha256")
    .update(JSON.stringify({ kind, repositoryId, metadata: normalizedMetadata }), "utf8")
    .digest("hex");
  return createEvidenceItem({
    id: evidenceItemId,
    eventId,
    repositoryId,
    source: "git",
    kind,
    occurredAt: input.observedAt,
    locator: `git:${repositoryId}`,
    summary,
    digest,
    privacyMode: "metadata_only",
    metadata: normalizedMetadata,
  });
}

/** Orders and limits changed paths before they enter stored evidence. */
function normalizeStatus(status: RepositoryStatusSummary): NormalizedStatus {
  const paths = status.paths
    .map((entry) => normalizePath(entry))
    .sort(
      (left, right) =>
        left.path.localeCompare(right.path) || pathFlags(left).localeCompare(pathFlags(right)),
    )
    .slice(0, GIT_EVIDENCE_PATH_LIMIT);
  return Object.freeze({
    clean: status.clean,
    stagedCount: status.stagedCount,
    unstagedCount: status.unstagedCount,
    untrackedCount: status.untrackedCount,
    totalPathCount: status.totalPathCount,
    paths: Object.freeze(paths),
    pathsTruncated: status.pathsTruncated || status.paths.length > GIT_EVIDENCE_PATH_LIMIT,
  });
}

/** Requires evidence paths to remain relative to the worktree. */
function normalizePath(entry: RepositoryStatusPath): NormalizedStatusPath {
  const path = entry.path;
  if (
    path === "" ||
    path.startsWith("/") ||
    path === ".." ||
    path.startsWith("../") ||
    path.includes("/../")
  ) {
    throw new GitEvidenceDerivationError(
      "invalid_status_path",
      "Git evidence paths must be root-relative",
    );
  }
  return Object.freeze({
    path,
    staged: entry.staged,
    unstaged: entry.unstaged,
    untracked: entry.untracked,
  });
}

/** Summarizes repository state without treating activity as completion. */
function snapshotSummary(snapshot: RepositoryInspection, status: NormalizedStatus): string {
  return `Repository snapshot at ${shortHead(snapshot.head)} on ${branchName(snapshot.branch)}: ${String(status.totalPathCount)} changed paths`;
}

/** Abbreviates an object ID for display. */
function shortHead(head: string): string {
  return head.slice(0, 12);
}

/** Labels detached checkouts when no branch name is available. */
function branchName(branch: string | null): string {
  return branch ?? "detached HEAD";
}

/** Requires a bounded, trimmed evidence identifier. */
function identifier(value: string, field: string): string {
  if (value.trim() !== value || value.length === 0 || value.length > 200) {
    throw new GitEvidenceDerivationError(
      "invalid_identifier",
      `${field} must be a non-blank identifier of at most 200 characters`,
    );
  }
  return value;
}

/** Creates a stable ordering key for paths with different change flags. */
function pathFlags(path: RepositoryStatusPath): string {
  return `${String(Number(path.staged))}${String(Number(path.unstaged))}${String(Number(path.untracked))}`;
}
