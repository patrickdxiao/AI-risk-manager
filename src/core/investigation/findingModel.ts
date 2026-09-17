import type {
  EvidenceItemId,
  FindingId,
  InvestigationId,
  ProjectId,
  RiskState,
  TaskId,
  UtcTimestamp,
} from "../primitives.js";
export interface FindingEvidence {
  readonly findingId: FindingId;
  readonly evidenceId: EvidenceItemId;
  readonly note?: string;
}

export type RiskType =
  | "stalled_work"
  | "deadline_risk"
  | "scope_drift"
  | "dependency_blocker"
  | "persistent_failure"
  | "completion_unverified";

export interface Finding {
  readonly id: FindingId;
  readonly investigationId: InvestigationId;
  readonly projectId: ProjectId;
  readonly taskId?: TaskId;
  readonly state: RiskState;
  readonly riskType?: RiskType;
  readonly confidence: number;
  readonly rationale: string;
  readonly uncertainty?: string;
  readonly missingEvidence: readonly string[];
  readonly recommendedUserAction?: string;
  readonly nextCheckAt?: UtcTimestamp;
  readonly nextCheckCondition?: string;
  readonly createdAt: UtcTimestamp;
}

export interface CreateFindingInput extends Omit<Finding, "createdAt" | "missingEvidence"> {
  readonly createdAt: string;
  readonly missingEvidence?: readonly string[];
  readonly evidenceCitations: readonly {
    readonly evidenceId: EvidenceItemId;
    readonly note?: string;
  }[];
}
