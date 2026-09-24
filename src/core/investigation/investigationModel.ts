import type { EvidenceCitation, RiskType } from "./findingModel.js";
import {
  DomainInvariantError,
  requireFiniteRange,
  requireInteger,
  requireNonBlank,
  requireTimestampOrder,
  requireUtcTimestamp,
  type InvestigationId,
  type RepositoryId,
  type RiskState,
  type SprintId,
  type TaskId,
  type UtcTimestamp,
} from "../primitives.js";

export type InvestigationStatus = "requested" | "running" | "completed" | "failed";

export interface InvestigationUsage extends RuntimeUsageObservation {
  readonly latencyMs?: number;
}

export interface InvestigationFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface Investigation {
  readonly id: InvestigationId;
  readonly sprintId: SprintId;
  /** When present, the task belongs to the investigation's sprint. */
  readonly taskId?: TaskId;
  readonly triggerId: string;
  readonly status: InvestigationStatus;
  readonly requestedAt: UtcTimestamp;
  readonly startedAt?: UtcTimestamp;
  readonly executionLeaseUntil?: UtcTimestamp;
  readonly executionAttemptId?: string;
  readonly executionVersion?: number;
  readonly completedAt?: UtcTimestamp;
  readonly usage?: InvestigationUsage;
  readonly failure?: InvestigationFailure;
}

/** Record a request without starting provider work. */
export function createInvestigation(
  input: Pick<Investigation, "id" | "sprintId" | "taskId" | "triggerId" | "requestedAt">,
): Investigation {
  return Object.freeze({
    id: requireNonBlank(input.id, "id", 200),
    sprintId: requireNonBlank(input.sprintId, "sprintId", 200),
    ...(input.taskId === undefined ? {} : { taskId: requireNonBlank(input.taskId, "taskId", 200) }),
    triggerId: requireNonBlank(input.triggerId, "triggerId", 200),
    status: "requested",
    requestedAt: requireUtcTimestamp(input.requestedAt, "requestedAt"),
  });
}

export function startInvestigation(value: Investigation, startedAtInput: string): Investigation {
  requireStatus(value, ["requested"]);
  const startedAt = requireUtcTimestamp(startedAtInput, "startedAt");
  requireTimestampOrder(value.requestedAt, startedAt, "startedAt");
  return Object.freeze({ ...value, status: "running", startedAt });
}

/** Clear the lease on completion; persisted ownership must be checked by the caller. */
export function completeInvestigation(
  value: Investigation,
  input: { readonly completedAt: string; readonly usage?: InvestigationUsage },
): Investigation {
  requireStatus(value, ["running"]);
  const completedAt = requireUtcTimestamp(input.completedAt, "completedAt");
  requireTimestampOrder(value.startedAt ?? value.requestedAt, completedAt, "completedAt");
  const usage = normalizeInvestigationUsage(input.usage);
  return Object.freeze({
    ...withoutExecutionLease(value),
    status: "completed",
    completedAt,
    ...(usage === undefined ? {} : { usage }),
  });
}

export function failInvestigation(
  value: Investigation,
  input: {
    readonly completedAt: string;
    readonly failure: InvestigationFailure;
    readonly usage?: InvestigationUsage;
  },
): Investigation {
  requireStatus(value, ["requested", "running"]);
  const completedAt = requireUtcTimestamp(input.completedAt, "completedAt");
  requireTimestampOrder(value.startedAt ?? value.requestedAt, completedAt, "completedAt");
  if (typeof input.failure.retryable !== "boolean")
    throw new DomainInvariantError(
      "invalid_value",
      "retryable must be a boolean",
      "failure.retryable",
    );
  const failure = Object.freeze({
    code: requireNonBlank(input.failure.code, "failure.code"),
    message: requireNonBlank(input.failure.message, "failure.message"),
    retryable: input.failure.retryable,
  });
  const usage = normalizeInvestigationUsage(input.usage);
  return Object.freeze({
    ...withoutExecutionLease(value),
    status: "failed",
    completedAt,
    ...(usage === undefined ? {} : { usage }),
    failure,
  });
}

/** Retry keeps the attempt version but clears the previous attempt's outcome and usage. */
export function retryInvestigation(value: Investigation, startedAtInput: string): Investigation {
  requireStatus(value, ["failed"]);
  if (value.failure?.retryable !== true)
    throw new DomainInvariantError(
      "invalid_transition",
      "Only retryable failures may restart",
      "failure.retryable",
    );
  const startedAt = requireUtcTimestamp(startedAtInput, "startedAt");
  requireTimestampOrder(
    value.completedAt ?? value.startedAt ?? value.requestedAt,
    startedAt,
    "startedAt",
  );
  const retried = { ...withoutExecutionLease(value), status: "running" as const, startedAt };
  delete retried.completedAt;
  delete retried.failure;
  delete retried.usage;
  return Object.freeze(retried);
}

/** Compute a lease claim; the caller must atomically compare and save persisted ownership. */
export function claimInvestigationExecution(
  value: Investigation,
  input: { readonly now: string; readonly leaseUntil: string },
): Investigation {
  requireStatus(value, ["running"]);
  const now = requireUtcTimestamp(input.now, "now");
  const leaseUntil = requireUtcTimestamp(input.leaseUntil, "executionLeaseUntil");
  requireTimestampOrder(value.startedAt ?? value.requestedAt, now, "now");
  requireTimestampOrder(now, leaseUntil, "executionLeaseUntil", false);
  if (value.executionLeaseUntil !== undefined)
    requireTimestampOrder(
      requireUtcTimestamp(value.executionLeaseUntil, "executionLeaseUntil"),
      now,
      "now",
    );
  if (
    value.executionVersion === undefined &&
    (value.executionAttemptId !== undefined || value.executionLeaseUntil !== undefined)
  )
    throw new DomainInvariantError(
      "invalid_value",
      "Existing execution requires an ownership version",
      "executionVersion",
    );
  const previousVersion =
    value.executionVersion === undefined
      ? 0
      : requireInteger(value.executionVersion, "executionVersion", 1);
  const executionVersion = requireInteger(previousVersion + 1, "executionVersion", 1);
  return Object.freeze({
    ...value,
    executionLeaseUntil: leaseUntil,
    executionVersion,
    executionAttemptId: `${value.id}:attempt:${String(executionVersion)}`,
  });
}

function withoutExecutionLease(value: Investigation): Omit<Investigation, "executionLeaseUntil"> {
  const result = { ...value };
  delete result.executionLeaseUntil;
  return result;
}

function requireStatus(value: Investigation, allowed: readonly InvestigationStatus[]): void {
  if (!allowed.includes(value.status))
    throw new DomainInvariantError(
      "invalid_transition",
      `Investigation cannot transition from ${value.status}`,
      "status",
    );
}

/** Validate only reported values; absent counters and costs remain unknown. */
export function normalizeInvestigationUsage(
  usage: InvestigationUsage | undefined,
): InvestigationUsage | undefined {
  if (usage === undefined) return undefined;
  const result: Partial<Record<keyof InvestigationUsage, number>> = {};
  for (const field of ["inputTokens", "outputTokens", "totalTokens"] as const)
    if (usage[field] !== undefined)
      result[field] = requireInteger(usage[field], `usage.${field}`, 0);
  for (const field of ["latencyMs", "estimatedCostUsd"] as const)
    if (usage[field] !== undefined)
      result[field] = requireFiniteRange(usage[field], `usage.${field}`, 0);
  return Object.freeze(result);
}

export interface InvestigationAttempt {
  readonly id: string;
  readonly investigationId: InvestigationId;
  readonly version: number;
  readonly status: "running" | "succeeded" | "failed" | "cancelled" | "expired";
  readonly startedAt: string;
  readonly leaseUntil: string;
  readonly timeoutMs: number;
  readonly dispatchTriggerId?: string;
  readonly dispatchLeaseVersion?: number;
  readonly completedAt?: string;
  readonly terminalReason?: string;
  /** Elapsed time from original durable admission to this attempt, including retries/backoff. */
  readonly queueWaitMs: number;
  readonly durationMs?: number;
  readonly promptVersion: string;
  readonly resultSchemaVersion: string;
  readonly runtimeRunId?: string;
  readonly runtimeSessionId?: string;
  readonly runtimeSessionKey?: string;
  readonly runtimeVersion?: string;
  readonly provider?: string;
  readonly model?: string;
  /** Unreported counters and cost remain absent, never substituted with zero. */
  readonly usage?: InvestigationUsage;
  /** Missing authority grants no tool access; credentials themselves are never persisted. */
  readonly authority?: {
    readonly credentialHash: string;
    readonly repositoryIds: readonly RepositoryId[];
    readonly planningDigest: string;
    readonly toolCalls: number;
    readonly reservedTokens: number;
  };
}

export interface InvestigationRuntimePort {
  runInvestigation(input: RunInvestigationInput): Promise<InvestigationRuntimeRun>;
}

export interface RunInvestigationInput {
  readonly prompt: string;
  readonly attemptId?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface RuntimeUsageObservation {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly estimatedCostUsd?: number;
}

export interface RuntimeFindingDraft {
  readonly taskId?: string;
  readonly state: RiskState;
  readonly riskType?: RiskType;
  readonly confidence: number;
  readonly rationale: string;
  readonly uncertainty?: string;
  readonly missingEvidence?: readonly string[];
  readonly recommendedUserAction?: string;
  readonly nextCheckAt?: string;
  readonly nextCheckCondition?: string;
  readonly evidenceCitations: readonly EvidenceCitation[];
}

export interface InvestigationStructuredResult {
  readonly version: "1";
  readonly findings: readonly RuntimeFindingDraft[];
  readonly examinedFindingIds?: readonly string[];
  readonly question?: {
    readonly question: string;
    readonly reason: "scope" | "completion_criteria";
    readonly taskId?: string;
  };
}

export interface InvestigationRuntimeRun {
  readonly runId: string;
  readonly sessionId: string;
  readonly sessionKey?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly latencyMs?: number;
  readonly usage?: RuntimeUsageObservation;
  readonly structuredResult?: InvestigationStructuredResult;
  readonly runtimeVersion?: string;
  readonly promptVersion?: string;
  readonly resultSchemaVersion?: string;
}
