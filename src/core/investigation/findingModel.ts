import type { EvidenceItem } from "../evidence/evidenceModel.js";
import {
  DomainInvariantError,
  normalizeStringList,
  requireFiniteRange,
  requireNonBlank,
  requireTimestampOrder,
  requireUtcTimestamp,
  type EvidenceItemId,
  type FindingId,
  type InvestigationId,
  type RiskState,
  type SprintId,
  type TaskId,
  type UtcTimestamp,
} from "../primitives.js";
export interface EvidenceCitation {
  readonly evidenceId: EvidenceItemId;
  readonly note?: string;
}

export interface FindingEvidence extends EvidenceCitation {
  readonly findingId: FindingId;
}

const RISK_TYPES = [
  "stalled_work",
  "deadline_risk",
  "scope_drift",
  "dependency_blocker",
  "persistent_failure",
  "completion_unverified",
] as const;
export type RiskType = (typeof RISK_TYPES)[number];

export interface Finding {
  readonly id: FindingId;
  readonly investigationId: InvestigationId;
  readonly sprintId: SprintId;
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
  readonly evidenceCitations: readonly EvidenceCitation[];
}

export function createFindingEvidence(input: FindingEvidence): FindingEvidence {
  return Object.freeze({
    findingId: requireNonBlank(input.findingId, "findingId", 200),
    evidenceId: requireNonBlank(input.evidenceId, "evidenceId", 200),
    ...(input.note === undefined ? {} : { note: requireNonBlank(input.note, "note", 2_000) }),
  });
}

/** The caller supplies only permitted stored evidence; citations do not prove a conclusion. */
export function createFinding(
  input: CreateFindingInput,
  permittedEvidence: ReadonlyMap<EvidenceItemId, EvidenceItem>,
): { readonly finding: Finding; readonly citations: readonly FindingEvidence[] } {
  const id = requireNonBlank(input.id, "id", 200);
  const createdAt = requireUtcTimestamp(input.createdAt, "createdAt");
  if (!["healthy", "uncertain", "at_risk", "blocked"].includes(input.state))
    throw new DomainInvariantError("invalid_value", "Risk state is invalid", "state");
  if (input.riskType !== undefined && !RISK_TYPES.includes(input.riskType))
    throw new DomainInvariantError("invalid_value", "Risk type is invalid", "riskType");
  if ((input.state === "at_risk" || input.state === "blocked") && input.riskType === undefined)
    throw new DomainInvariantError(
      "required",
      "At-risk and blocked findings require a risk type",
      "riskType",
    );
  const text: Partial<
    Record<"uncertainty" | "recommendedUserAction" | "nextCheckCondition", string>
  > = {};
  for (const field of ["uncertainty", "recommendedUserAction", "nextCheckCondition"] as const)
    if (input[field] !== undefined) text[field] = requireNonBlank(input[field], field, 4_000);
  const missingEvidence = normalizeStringList(input.missingEvidence ?? [], "missingEvidence", 50);
  const nextCheckAt =
    input.nextCheckAt === undefined
      ? undefined
      : requireUtcTimestamp(input.nextCheckAt, "nextCheckAt");
  if (nextCheckAt !== undefined) requireTimestampOrder(createdAt, nextCheckAt, "nextCheckAt");
  if (
    input.state !== "healthy" &&
    nextCheckAt === undefined &&
    text.nextCheckCondition === undefined
  )
    throw new DomainInvariantError(
      "required",
      "Non-healthy findings require a next check",
      "nextCheckCondition",
    );
  if (input.evidenceCitations.length > 100)
    throw new DomainInvariantError(
      "out_of_range",
      "A finding may cite at most 100 evidence records",
      "evidenceCitations",
    );
  if (
    input.evidenceCitations.length === 0 &&
    (input.state !== "uncertain" ||
      (text.uncertainty === undefined && missingEvidence.length === 0))
  )
    throw new DomainInvariantError(
      "missing_evidence_citation",
      "The finding requires stored evidence citations",
      "evidenceCitations",
    );
  const seen = new Set<EvidenceItemId>();
  const citations = input.evidenceCitations.map((citation) => {
    const result = createFindingEvidence({ ...citation, findingId: id });
    if (seen.has(result.evidenceId))
      throw new DomainInvariantError(
        "duplicate_reference",
        "Each evidence record may be cited only once",
        "evidenceCitations",
      );
    seen.add(result.evidenceId);
    if (permittedEvidence.get(result.evidenceId)?.id !== result.evidenceId)
      throw new DomainInvariantError(
        "unknown_evidence_citation",
        `Evidence ${result.evidenceId} is unavailable`,
        "evidenceCitations",
      );
    return result;
  });
  const finding: Finding = Object.freeze({
    id,
    investigationId: requireNonBlank(input.investigationId, "investigationId", 200),
    sprintId: requireNonBlank(input.sprintId, "sprintId", 200),
    ...(input.taskId === undefined ? {} : { taskId: requireNonBlank(input.taskId, "taskId", 200) }),
    state: input.state,
    ...(input.riskType === undefined ? {} : { riskType: input.riskType }),
    confidence: requireFiniteRange(input.confidence, "confidence", 0, 1),
    rationale: requireNonBlank(input.rationale, "rationale"),
    ...text,
    missingEvidence,
    ...(nextCheckAt === undefined ? {} : { nextCheckAt }),
    createdAt,
  });
  return Object.freeze({ finding, citations: Object.freeze(citations) });
}
