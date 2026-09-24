import type { TaskState } from "../planning/planningModel.js";
import {
  requireNonBlank,
  requireUtcTimestamp,
  type EvidenceItemId,
  type InvestigationId,
  type RepositoryId,
  type SprintId,
  type TaskId,
  type UtcTimestamp,
} from "../primitives.js";

export type TriggerType =
  | "git_change"
  | "task_deadline"
  | "scheduled_review"
  | "manual_review"
  | "plan_changed";

export interface TriggerContext {
  readonly version: "trigger-context.v1";
  readonly now: UtcTimestamp;
  readonly sprint: {
    readonly id: SprintId;
    readonly startAt: UtcTimestamp;
    readonly endAt: UtcTimestamp;
    readonly reviewCadenceMinutes?: number;
    readonly lastReviewedAt?: UtcTimestamp;
  };
  readonly task?: {
    readonly id: TaskId;
    readonly state: TaskState;
    readonly deadlineAt: UtcTimestamp;
  };
  readonly gitChange?: {
    readonly repositoryId: RepositoryId;
    readonly occurredAt: UtcTimestamp;
    readonly digest: string;
  };
  readonly repositoryIds: readonly RepositoryId[];
  readonly evidenceDigests: readonly string[];
}

export type TriggerInputValue = string | number | boolean | readonly string[];

interface ReviewRequest {
  readonly type: TriggerType;
  readonly sprintId: SprintId;
  readonly taskId?: TaskId;
  /** Sorted unique IDs fixed at admission; an empty list permits plan evidence only. */
  readonly repositoryIds: readonly RepositoryId[];
  readonly dedupKey: string;
  readonly reason: string;
  readonly inputSummary: Readonly<Record<string, TriggerInputValue>>;
  readonly evidenceDigests: readonly string[];
}

export interface TriggerCandidate extends ReviewRequest {
  readonly version: "trigger-candidate.v1";
}

/** Saved request facts are immutable; delivery state lives in TriggerDispatch. */
export interface TriggerQueueRecord extends ReviewRequest {
  readonly version: "trigger-queue-record.v1";
  readonly id: string;
  readonly evidenceCitations: readonly {
    readonly evidenceId: EvidenceItemId;
    readonly digest: string;
  }[];
  readonly observedAt: UtcTimestamp;
  readonly cooldownUntil: UtcTimestamp;
}

export type TriggerCooldownScope = Pick<
  ReviewRequest,
  "type" | "sprintId" | "taskId" | "repositoryIds"
>;

export interface TriggerQueueStore {
  findById(id: string): Promise<TriggerQueueRecord | undefined>;
  findByDedupKey(dedupKey: string): Promise<TriggerQueueRecord | undefined>;
  findLatestByCooldownScope(scope: TriggerCooldownScope): Promise<TriggerQueueRecord | undefined>;
  listPendingBySprintId(sprintId: SprintId, limit: number): Promise<readonly TriggerQueueRecord[]>;
  add(record: TriggerQueueRecord): Promise<void>;
}

export type TriggerDispatchStatus = "pending" | "leased" | "completed" | "retry_wait" | "dead";

export interface TriggerDispatch {
  readonly version: "trigger-dispatch.v1";
  readonly triggerId: string;
  readonly investigationId?: InvestigationId;
  readonly status: TriggerDispatchStatus;
  readonly leaseVersion: number;
  readonly attempts: number;
  readonly dueAt: UtcTimestamp;
  readonly leaseExpiresAt?: UtcTimestamp;
  readonly failureCode?: string;
  readonly createdAt: UtcTimestamp;
  readonly updatedAt: UtcTimestamp;
  readonly completedAt?: UtcTimestamp;
}

/** Persist delivery before any runtime work starts. */
export function pendingTriggerDispatch(triggerId: string, timestamp: string): TriggerDispatch {
  const now = requireUtcTimestamp(timestamp, "createdAt");
  return Object.freeze({
    version: "trigger-dispatch.v1",
    triggerId: requireNonBlank(triggerId, "triggerId", 200),
    status: "pending",
    leaseVersion: 0,
    attempts: 0,
    dueAt: now,
    createdAt: now,
    updatedAt: now,
  });
}

/** One installation-wide queue; a fenced save succeeds only for the expected owner and status. */
export interface TriggerDispatchStore {
  /** Count all nonterminal requests, including leased work and delayed retries. */
  countPending(): Promise<number>;
  findByTriggerId(triggerId: string): Promise<TriggerDispatch | undefined>;
  findByInvestigationId(investigationId: InvestigationId): Promise<TriggerDispatch | undefined>;
  /** Pending/retry work with dueAt <= now, or expired leases; exclude terminals and order by dueAt then triggerId. */
  findNextDue(now: UtcTimestamp): Promise<TriggerDispatch | undefined>;
  add(dispatch: TriggerDispatch): Promise<void>;
  saveFenced(
    dispatch: TriggerDispatch,
    expectedLeaseVersion: number,
    expectedStatus: TriggerDispatchStatus,
  ): Promise<boolean>;
}
