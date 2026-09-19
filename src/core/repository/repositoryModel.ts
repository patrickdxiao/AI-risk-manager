import type { EvidenceItem } from "../evidence/evidenceModel.js";
import type { EvidenceEventId, EvidenceItemId, RepositoryId, UtcTimestamp } from "../primitives.js";
export interface Repository {
  readonly id: RepositoryId;
  readonly approvedRoot?: string;
  readonly canonicalPath: string;
  readonly gitRoot: string;
  readonly identityDigest: string;
  readonly registeredAt: UtcTimestamp;
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

export interface RepositoryObservationPort {
  capture(input: {
    readonly repository: Repository;
    readonly previous?: RepositoryObservationSnapshot;
    readonly observedAt: string;
    readonly nextEvidenceId: () => EvidenceItemId;
    readonly nextEventId: () => EvidenceEventId;
  }): Promise<RepositoryObservationCapture>;
}
