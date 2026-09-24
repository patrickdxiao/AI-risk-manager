import type { EvidenceItem } from "../evidence/evidenceModel.js";
import {
  DomainInvariantError,
  type EvidenceEventId,
  type EvidenceItemId,
  type RepositoryId,
  requireNonBlank,
  requireUtcTimestamp,
  type UtcTimestamp,
} from "../primitives.js";
export interface Repository {
  readonly id: RepositoryId;
  readonly approvedRoot?: string;
  readonly canonicalPath: string;
  readonly gitRoot: string;
  readonly identityDigest: string;
  readonly registeredAt: UtcTimestamp;
}

/** Validate identity returned by inspection; this does not inspect paths or grant access. */
export function createRepository(input: Repository): Repository {
  const canonicalPath = requireStoredPath(input.canonicalPath, "canonicalPath");
  const gitRoot = requireStoredPath(input.gitRoot, "gitRoot");
  if (canonicalPath !== gitRoot)
    throw new DomainInvariantError(
      "scope_mismatch",
      "canonicalPath and gitRoot must identify the same worktree root",
      "gitRoot",
    );
  return Object.freeze({
    id: requireNonBlank(input.id, "id", 200),
    ...(input.approvedRoot === undefined
      ? {}
      : { approvedRoot: requireStoredPath(input.approvedRoot, "approvedRoot") }),
    canonicalPath,
    gitRoot,
    identityDigest: requireNonBlank(input.identityDigest, "identityDigest", 512),
    registeredAt: requireUtcTimestamp(input.registeredAt, "registeredAt"),
  });
}

/** Preserve inspected paths exactly, including valid spaces in directory names. */
function requireStoredPath(value: string, field: string): string {
  requireNonBlank(value, field, 4_096);
  if (value.length > 4_096)
    throw new DomainInvariantError("out_of_range", `${field} exceeds 4096 characters`, field);
  if (value.includes("\0"))
    throw new DomainInvariantError(
      "invalid_value",
      `${field} cannot contain a null character`,
      field,
    );
  return value;
}

type RepositoryInspectionErrorCode =
  | "invalid_repository_path"
  | "not_git_repository"
  | "state_directory_inside_repository";

/** Reports an unsafe or unavailable repository registration path. */
export class RepositoryInspectionError extends Error {
  override readonly name = "RepositoryInspectionError";

  constructor(
    readonly code: RepositoryInspectionErrorCode,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

export interface RepositoryRegistrationInspection {
  readonly canonicalRoot: string;
  readonly identityDigest: string;
}

export interface RepositoryInspectionPort {
  inspectRegistration(input: {
    readonly path: string;
    readonly stateDirectory: string;
    readonly approvedRoot?: string;
  }): Promise<RepositoryRegistrationInspection>;
}

export interface RepositoryObservationStatusPath {
  readonly path: string;
  readonly staged: boolean;
  readonly unstaged: boolean;
  readonly untracked: boolean;
}

export interface RepositoryObservationStatus {
  readonly clean: boolean;
  readonly stagedCount: number;
  readonly unstagedCount: number;
  readonly untrackedCount: number;
  readonly totalPathCount: number;
  readonly paths: readonly RepositoryObservationStatusPath[];
  readonly pathsTruncated: boolean;
}

export interface RepositoryObservationSnapshot {
  readonly rootPath: string;
  readonly head: string;
  readonly branch: string | null;
  readonly detached: boolean;
  readonly status: RepositoryObservationStatus;
  readonly snapshotDigest: string;
}

export interface RepositoryObservation {
  readonly repositoryId: string;
  readonly observedAt: string;
  readonly snapshot: RepositoryObservationSnapshot;
  readonly evaluatedSnapshotDigest?: string;
}

export interface RepositoryObservationCapture {
  readonly snapshot: RepositoryObservationSnapshot;
  readonly evidenceItems: readonly EvidenceItem[];
}

/** Reports that read-only repository evidence could not be captured. */
export class RepositoryObservationCaptureError extends Error {
  override readonly name = "RepositoryObservationCaptureError";

  constructor(message = "repository observation failed") {
    super(message);
  }
}

export interface RepositoryObservationPort {
  capture(input: {
    readonly repository: Repository;
    readonly previous?: RepositoryObservationSnapshot;
    readonly observedAt: string;
    readonly nextEvidenceId: () => EvidenceItemId;
    readonly nextEventId: () => EvidenceEventId;
  }): Promise<RepositoryObservationCapture>;
}
