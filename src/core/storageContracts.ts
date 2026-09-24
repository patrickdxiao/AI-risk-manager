import type { EvidenceItem, EvidenceQuery } from "./evidence/evidenceModel.js";
import type { Finding, FindingEvidence } from "./investigation/findingModel.js";
import type {
  Investigation,
  InvestigationAttempt,
  InvestigationStructuredResult,
} from "./investigation/investigationModel.js";
import type { Sprint, Task } from "./planning/planningModel.js";
import type {
  EvidenceItemId,
  FindingFeedbackId,
  FindingId,
  InvestigationId,
  RepositoryId,
  SprintId,
  TaskId,
  UtcTimestamp,
} from "./primitives.js";
import type { Repository, RepositoryObservation } from "./repository/repositoryModel.js";
import type { FindingFeedback } from "./risk/findingFeedback.js";
import type { RiskSnapshot, RiskTransition } from "./risk/riskModel.js";
import type { TriggerDispatchStore, TriggerQueueStore } from "./triggers/triggerModel.js";

/** Compare all provenance fields; repository observations need no sprint or task assignment. */
export type EvidenceIdentity = Pick<
  EvidenceItem,
  "repositoryId" | "sprintId" | "taskId" | "source" | "kind" | "digest"
>;

export interface PlanningStore {
  listSprints(): Promise<readonly Sprint[]>;
  listTasks(): Promise<readonly Task[]>;
  countOpenTasks(): Promise<number>;
  findActiveSprint(): Promise<Sprint | undefined>;
  findSprintById(id: SprintId): Promise<Sprint | undefined>;
  findTaskById(id: TaskId): Promise<Task | undefined>;
  findTasksBySprintId(id: SprintId): Promise<readonly Task[]>;
  addSprint(sprint: Sprint): Promise<void>;
  addTask(task: Task): Promise<void>;
  saveSprint(sprint: Sprint): Promise<void>;
  saveTask(task: Task): Promise<void>;
}

export interface RepositoryStore {
  list(): Promise<readonly Repository[]>;
  findById(id: RepositoryId): Promise<Repository | undefined>;
  add(repository: Repository): Promise<void>;
}

export class RepositoryConflictError extends Error {
  override readonly name = "RepositoryConflictError";
  constructor(
    readonly conflict: "id" | "canonical_path",
    readonly value: string,
  ) {
    super(`repository ${conflict} ${value} already exists`);
  }
}

export class PlanningEntityAlreadyExistsError extends Error {
  override readonly name = "PlanningEntityAlreadyExistsError";
  constructor(
    readonly entity: "sprint" | "task",
    readonly id: string,
  ) {
    super(`${entity} ${id} already exists`);
  }
}

export interface RepositoryObservationStore {
  findByRepositoryId(repositoryId: RepositoryId): Promise<RepositoryObservation | undefined>;
  save(observation: RepositoryObservation): Promise<void>;
  listPendingEvaluation(limit: number): Promise<readonly RepositoryObservation[]>;
  /** Advance only the cursor for the exact captured snapshot and time. */
  markEvaluated(
    repositoryId: RepositoryId,
    snapshotDigest: string,
    observedAt: UtcTimestamp,
  ): Promise<boolean>;
}

export interface EvidenceStore {
  findScoped(query: EvidenceQuery): Promise<readonly EvidenceItem[]>;
  findByIdentity(identity: EvidenceIdentity): Promise<EvidenceItem | undefined>;
  findById(id: EvidenceItemId): Promise<EvidenceItem | undefined>;
  add(item: EvidenceItem): Promise<void>;
}

/** Immutable acceptance receipt; findings and questions do not complete tasks. */
export interface SubmittedInvestigationResult {
  readonly question?: NonNullable<InvestigationStructuredResult["question"]> & {
    readonly id: string;
  };
  readonly retainedFindingIds?: readonly FindingId[];
  readonly resultDigest: string;
  readonly investigation: Investigation;
  readonly findings: readonly Finding[];
  readonly citations: readonly FindingEvidence[];
  readonly riskSnapshots: readonly RiskSnapshot[];
  readonly riskTransitions: readonly RiskTransition[];
}

export type InvestigationDedupKey = Pick<Investigation, "sprintId" | "taskId" | "triggerId">;

export interface InvestigationActivity {
  readonly investigation: Investigation;
  readonly latestAttempt?: InvestigationAttempt;
}

export interface InvestigationStore {
  listAttemptsSince(since: UtcTimestamp): Promise<readonly InvestigationAttempt[]>;
  findRecentBySprintId(
    sprintId: SprintId,
    now: UtcTimestamp,
    limit: number,
  ): Promise<readonly InvestigationActivity[]>;
  /** At most one unexpired investigation can execute across this installation. */
  findActive(now: UtcTimestamp): Promise<Investigation | undefined>;
  findAttemptById(id: string): Promise<InvestigationAttempt | undefined>;
  findAttempts(investigationId: InvestigationId): Promise<readonly InvestigationAttempt[]>;
  saveAttempt(attempt: InvestigationAttempt): Promise<void>;
  /** An absent task selects a sprint-wide result, not the latest arbitrary task result. */
  findLatestSubmittedResult(
    sprintId: SprintId,
    taskId?: TaskId,
  ): Promise<SubmittedInvestigationResult | undefined>;
  findByDedupKey(key: InvestigationDedupKey): Promise<Investigation | undefined>;
  findById(id: InvestigationId): Promise<Investigation | undefined>;
  /** Refuse a claim while any unexpired investigation already owns execution capacity. */
  claimExecution(
    id: InvestigationId,
    now: UtcTimestamp,
    leaseUntil: UtcTimestamp,
  ): Promise<Investigation | undefined>;
  findSubmittedResult(id: InvestigationId): Promise<SubmittedInvestigationResult | undefined>;
  add(investigation: Investigation): Promise<void>;
  save(investigation: Investigation): Promise<void>;
  saveSubmittedResult(result: SubmittedInvestigationResult): Promise<void>;
}

export interface FindingStore {
  findById(id: FindingId): Promise<Finding | undefined>;
  findEvidenceByFindingId(findingId: FindingId): Promise<readonly FindingEvidence[]>;
  add(finding: Finding): Promise<void>;
  addEvidence(citation: FindingEvidence): Promise<void>;
}

export interface FindingFeedbackStore {
  findById(id: FindingFeedbackId): Promise<FindingFeedback | undefined>;
  findByFindingId(findingId: FindingId, limit: number): Promise<readonly FindingFeedback[]>;
  /** Latest status action and latest correction, newest first; at most two records. */
  findCurrentByFindingId(findingId: FindingId): Promise<readonly FindingFeedback[]>;
  add(feedback: FindingFeedback): Promise<void>;
}

export interface RiskStore {
  findLatestSnapshot(sprintId: SprintId, taskId?: TaskId): Promise<RiskSnapshot | undefined>;
  addSnapshot(snapshot: RiskSnapshot): Promise<void>;
  addTransition(transition: RiskTransition): Promise<void>;
}

export interface TransactionContext {
  readonly planning: PlanningStore;
  readonly repositories: RepositoryStore;
  readonly repositoryObservations: RepositoryObservationStore;
  readonly evidence: EvidenceStore;
  readonly investigations: InvestigationStore;
  readonly findings: FindingStore;
  readonly findingFeedback: FindingFeedbackStore;
  readonly triggerQueue: TriggerQueueStore;
  readonly triggerDispatches: TriggerDispatchStore;
  readonly risks: RiskStore;
}

/** Serialize writers and their admission reads; commit all callback writes or none on failure. */
export interface UnitOfWorkPort {
  execute<T>(work: (context: TransactionContext) => Promise<T>): Promise<T>;
}
