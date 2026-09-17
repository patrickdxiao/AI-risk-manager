import type { RiskType } from "./findingModel.js";
import type { InvestigationId, ProjectId, RiskState, TaskId, UtcTimestamp } from "../primitives.js";

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
  readonly projectId: ProjectId;
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

export interface InvestigationAttempt {
  readonly id: string;
  readonly investigationId: string;
  readonly projectId: string;
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
  /** Immutable scope and admission state; secrets themselves are never persisted. */
  readonly authority?: {
    readonly credentialHash: string;
    readonly repositoryIds: readonly string[];
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

interface FindingEvidenceCitation {
  readonly evidenceId: string;
  readonly note?: string;
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
  readonly evidenceCitations: readonly FindingEvidenceCitation[];
}

export interface InvestigationStructuredResult {
  /** Absent only for existing scripted clients; external result contracts require version 1. */
  readonly version?: "1";
  readonly findings: readonly RuntimeFindingDraft[];
  readonly needsConfirmation?: boolean;
  readonly examinedFindingIds?: readonly string[];
  readonly question?: {
    readonly question: string;
    readonly reason: "scope" | "completion_criteria";
    readonly taskId?: string;
  };
  readonly completedTasks?: readonly {
    readonly taskId: string;
    readonly version: number;
    readonly criteriaEvidence: readonly {
      readonly criterion: string;
      readonly evidenceIds: readonly string[];
    }[];
  }[];
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
