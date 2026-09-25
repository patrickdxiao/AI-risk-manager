import {
  normalizeJsonRecord,
  MAX_REVIEW_REPOSITORIES,
  MAX_REVIEW_SEED_EVIDENCE,
} from "../../core/primitives.js";
import {
  createSprint,
  createTask,
  type Sprint,
  type Task,
} from "../../core/planning/planningModel.js";
import {
  createRepository,
  createRepositoryObservationSnapshot,
  type Repository,
  type RepositoryObservation,
} from "../../core/repository/repositoryModel.js";
import { createEvidenceItem, type EvidenceItem } from "../../core/evidence/evidenceModel.js";
import {
  createFindingEvidence,
  validateFindingRisk,
  type Finding,
  type FindingEvidence,
} from "../../core/investigation/findingModel.js";
import {
  normalizeInvestigationUsage,
  type Investigation,
  type InvestigationAttempt,
} from "../../core/investigation/investigationModel.js";
import { createFindingFeedback, type FindingFeedback } from "../../core/risk/findingFeedback.js";
import type { RiskSnapshot, RiskTransition } from "../../core/risk/riskModel.js";
import type { SubmittedInvestigationResult } from "../../core/storageContracts.js";
import type { TriggerDispatch, TriggerQueueRecord } from "../../core/triggers/triggerModel.js";
import {
  array,
  boolean,
  enumeration,
  id,
  integer,
  invariant,
  nullable,
  number,
  object,
  optional,
  record,
  text,
  timestamp,
  triggerValue,
  type Decoder,
} from "./validation.js";

const scope = { sprintId: id, taskId: optional(id) };
const riskState = enumeration("healthy", "uncertain", "at_risk", "blocked");
const usage = object({
  latencyMs: optional(number()),
  inputTokens: optional(integer()),
  outputTokens: optional(integer()),
  totalTokens: optional(integer()),
  estimatedCostUsd: optional(number()),
});
const failure = object({ code: text(), message: text(), retryable: boolean });
const orderedScope: Decoder<readonly string[]> = (value) => {
  const ids = array(id, MAX_REVIEW_REPOSITORIES)(value);
  invariant(ids.every((item, index) => index === 0 || item > (ids[index - 1] ?? "")));
  return ids;
};

const sprintShape = object({
  id,
  startAt: timestamp,
  endAt: timestamp,
  goal: optional(text()),
  assumptions: optional(array(text(4_000), 100)),
  reviewCadenceMinutes: integer(1),
  pointTarget: integer(),
  state: enumeration("planned", "active", "completed"),
  createdAt: timestamp,
});
export const sprint: Decoder<Sprint> = (value) => createSprint(sprintShape(value));
const taskShape = object({
  id,
  sprintId: id,
  title: text(500),
  description: optional(text()),
  points: integer(1),
  state: enumeration("planned", "in_progress", "needs_confirmation", "done"),
  startAt: timestamp,
  endAt: timestamp,
  version: integer(1),
  dependencyIds: array(id),
  completionCriteria: array(text(4_000), 50),
  pathHints: array(text(4_096), 100),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export const task: Decoder<Task> = (value) => {
  const result = taskShape(value);
  return createTask(result);
};
const repositoryShape = object({
  id,
  approvedRoot: optional(text(4_096)),
  canonicalPath: text(4_096),
  gitRoot: text(4_096),
  identityDigest: text(512),
  registeredAt: timestamp,
});
export const repository: Decoder<Repository> = (value) => createRepository(repositoryShape(value));
const snapshot = object({
  rootPath: text(4_096),
  head: text(512),
  branch: nullable(text(512)),
  detached: boolean,
  snapshotDigest: text(512),
  status: object({
    clean: boolean,
    stagedCount: integer(),
    unstagedCount: integer(),
    untrackedCount: integer(),
    totalPathCount: integer(),
    pathsTruncated: boolean,
    paths: array(
      object({ path: text(4_096), staged: boolean, unstaged: boolean, untracked: boolean }),
      200,
    ),
  }),
});
const observationShape = object({
  repositoryId: id,
  observedAt: timestamp,
  snapshot,
  evidenceIds: array(id, 100),
  evaluatedSnapshotDigest: optional(text(512)),
});
export const observation: Decoder<RepositoryObservation> = (value) => {
  const result = observationShape(value);
  invariant(new Set(result.evidenceIds).size === result.evidenceIds.length);
  invariant(
    result.evaluatedSnapshotDigest === undefined ||
      result.evaluatedSnapshotDigest === result.snapshot.snapshotDigest,
  );
  return Object.freeze({
    ...result,
    snapshot: createRepositoryObservationSnapshot(result.snapshot),
  });
};
const evidenceShape = object({
  id,
  eventId: id,
  repositoryId: optional(id),
  sprintId: optional(id),
  taskId: optional(id),
  source: enumeration("git", "openclaw", "user", "replay", "system"),
  kind: enumeration(
    "repository_snapshot",
    "commit",
    "worktree_change",
    "branch_change",
    "upstream_relation",
    "agent_claim",
    "observed_failure",
    "task_state_change",
    "runtime_status",
    "periodic_review",
  ),
  occurredAt: timestamp,
  locator: text(4_096),
  summary: text(),
  digest: text(512),
  privacyMode: enumeration("metadata_only", "selected_content"),
  metadata: (value: unknown) => normalizeJsonRecord(value, "metadata"),
  selectedContent: optional(object({ text: text(8_000), truncated: boolean })),
});
export const evidence: Decoder<EvidenceItem> = (value) => createEvidenceItem(evidenceShape(value));

const investigationShape = object({
  id,
  ...scope,
  triggerId: id,
  status: enumeration("requested", "running", "completed", "failed"),
  requestedAt: timestamp,
  startedAt: optional(timestamp),
  executionLeaseUntil: optional(timestamp),
  executionAttemptId: optional(text(256)),
  executionVersion: optional(integer(1)),
  completedAt: optional(timestamp),
  usage: optional(usage),
  failure: optional(failure),
});
export const investigation: Decoder<Investigation> = (value) => {
  const result = investigationShape(value);
  const terminal = result.status === "completed" || result.status === "failed";
  invariant((result.completedAt !== undefined) === terminal);
  invariant((result.failure !== undefined) === (result.status === "failed"));
  invariant(result.startedAt === undefined || result.startedAt >= result.requestedAt);
  invariant(
    result.completedAt === undefined ||
      result.completedAt >= (result.startedAt ?? result.requestedAt),
  );
  invariant(
    result.status !== "requested" ||
      (result.startedAt === undefined &&
        result.usage === undefined &&
        result.executionVersion === undefined),
  );
  invariant(
    (result.status !== "running" && result.status !== "completed") ||
      result.startedAt !== undefined,
  );
  invariant(
    result.executionLeaseUntil === undefined ||
      (result.status === "running" &&
        result.executionLeaseUntil > (result.startedAt ?? result.requestedAt)),
  );
  invariant((result.executionAttemptId !== undefined) === (result.executionVersion !== undefined));
  invariant(result.executionLeaseUntil === undefined || result.executionVersion !== undefined);
  return result;
};
const attemptShape = object({
  id: text(256),
  investigationId: id,
  version: integer(1),
  status: enumeration("running", "succeeded", "failed", "cancelled", "expired"),
  startedAt: timestamp,
  leaseUntil: timestamp,
  timeoutMs: integer(1),
  dispatchTriggerId: optional(id),
  dispatchLeaseVersion: optional(integer(1)),
  completedAt: optional(timestamp),
  terminalReason: optional(text()),
  queueWaitMs: integer(),
  durationMs: optional(number()),
  promptVersion: text(),
  resultSchemaVersion: text(),
  runtimeRunId: optional(text()),
  runtimeSessionId: optional(text()),
  runtimeSessionKey: optional(text()),
  runtimeVersion: optional(text()),
  provider: optional(text()),
  model: optional(text()),
  usage: optional(usage),
  authority: optional(
    object({
      credentialHash: text(64),
      repositoryIds: orderedScope,
      planningDigest: text(512),
      toolCalls: integer(),
      reservedTokens: integer(),
    }),
  ),
});
export const attempt: Decoder<InvestigationAttempt> = (value) => {
  const result = attemptShape(value);
  invariant(result.leaseUntil > result.startedAt);
  invariant((result.completedAt === undefined) === (result.status === "running"));
  invariant(result.completedAt === undefined || result.completedAt >= result.startedAt);
  invariant(
    (result.dispatchTriggerId === undefined) === (result.dispatchLeaseVersion === undefined),
  );
  invariant(
    result.authority === undefined || /^[a-f0-9]{64}$/u.test(result.authority.credentialHash),
  );
  normalizeInvestigationUsage(result.usage);
  return result;
};
const findingShape = object({
  id,
  investigationId: id,
  ...scope,
  state: riskState,
  riskType: optional(
    enumeration(
      "stalled_work",
      "deadline_risk",
      "scope_drift",
      "dependency_blocker",
      "persistent_failure",
      "completion_unverified",
    ),
  ),
  confidence: number(0, 1),
  rationale: text(),
  uncertainty: optional(text(4_000)),
  missingEvidence: array(text(4_000), 50),
  recommendedUserAction: optional(text(4_000)),
  nextCheckAt: optional(timestamp),
  nextCheckCondition: optional(text(4_000)),
  createdAt: timestamp,
});
export const finding: Decoder<Finding> = (value) => {
  const result = findingShape(value);
  validateFindingRisk(result.state, result.riskType);
  invariant(
    result.state === "healthy" ||
      result.nextCheckAt !== undefined ||
      result.nextCheckCondition !== undefined,
  );
  invariant(result.nextCheckAt === undefined || result.nextCheckAt >= result.createdAt);
  return result;
};
const citationShape = object({ findingId: id, evidenceId: id, note: optional(text(2_000)) });
export const citation: Decoder<FindingEvidence> = (value) =>
  createFindingEvidence(citationShape(value));
const feedbackShape = object({
  id,
  findingId: id,
  kind: enumeration("confirm", "dismiss", "resolve", "correct"),
  note: optional(text(4_000)),
  correction: optional(object({ statement: text() })),
  actor: id,
  source: id,
  createdAt: timestamp,
});
export const feedback: Decoder<FindingFeedback> = (value) =>
  createFindingFeedback(feedbackShape(value));
export const riskSnapshot: Decoder<RiskSnapshot> = object({
  id,
  ...scope,
  state: riskState,
  findingId: optional(id),
  createdAt: timestamp,
});
const cause: Decoder<RiskTransition["cause"]> = (value) => {
  if (value !== null && typeof value === "object" && Reflect.get(value, "type") === "finding")
    return object({ type: enumeration("finding"), findingId: id })(value);
  return object({ type: enumeration("feedback"), feedbackId: id })(value);
};
export const riskTransition: Decoder<RiskTransition> = object({
  id,
  ...scope,
  from: nullable(riskState),
  to: riskState,
  cause,
  occurredAt: timestamp,
});
const receiptShape = object({
  resultDigest: text(512),
  investigation,
  findings: array(finding, 2_000),
  citations: array(citation, 200_000),
  riskSnapshots: array(riskSnapshot, 2_000),
  riskTransitions: array(riskTransition, 2_000),
  retainedFindingIds: optional(array(id, 2_000)),
  question: optional(
    object({
      id,
      question: text(),
      reason: enumeration("scope", "completion_criteria"),
      taskId: optional(id),
    }),
  ),
});
export const receipt: Decoder<SubmittedInvestigationResult> = (value) => {
  const result = receiptShape(value);
  invariant(result.investigation.status === "completed");
  const ids = new Set(result.findings.map((item) => item.id));
  invariant(ids.size === result.findings.length);
  invariant(result.citations.every((item) => ids.has(item.findingId)));
  invariant((result.retainedFindingIds ?? []).every((item) => ids.has(item)));
  invariant(
    result.findings.every(
      (item) =>
        item.sprintId === result.investigation.sprintId &&
        (item.investigationId === result.investigation.id ||
          result.retainedFindingIds?.includes(item.id) === true),
    ),
  );
  return result;
};

export const queue: Decoder<TriggerQueueRecord> = object({
  version: enumeration("trigger-queue-record.v1"),
  id,
  type: enumeration(
    "git_change",
    "task_deadline",
    "scheduled_review",
    "manual_review",
    "plan_changed",
  ),
  ...scope,
  repositoryIds: orderedScope,
  dedupKey: text(512),
  reason: text(4_000),
  inputSummary: record(triggerValue),
  evidenceDigests: array(text(512), MAX_REVIEW_SEED_EVIDENCE),
  evidenceCitations: array(object({ evidenceId: id, digest: text(512) }), MAX_REVIEW_SEED_EVIDENCE),
  observedAt: timestamp,
  cooldownUntil: timestamp,
});
const dispatchShape = object({
  version: enumeration("trigger-dispatch.v1"),
  triggerId: id,
  investigationId: optional(id),
  status: enumeration("pending", "leased", "completed", "retry_wait", "dead"),
  leaseVersion: integer(),
  attempts: integer(),
  dueAt: timestamp,
  leaseExpiresAt: optional(timestamp),
  failureCode: optional(text()),
  createdAt: timestamp,
  updatedAt: timestamp,
  completedAt: optional(timestamp),
});
export const dispatch: Decoder<TriggerDispatch> = (value) => {
  const result = dispatchShape(value);
  invariant(result.updatedAt >= result.createdAt);
  invariant((result.status === "leased") === (result.leaseExpiresAt !== undefined));
  invariant(
    result.status !== "leased" ||
      (result.investigationId !== undefined &&
        result.leaseVersion > 0 &&
        (result.leaseExpiresAt ?? "") > result.updatedAt),
  );
  invariant(
    (result.status === "dead" || result.status === "completed") ===
      (result.completedAt !== undefined),
  );
  invariant(result.completedAt === undefined || result.completedAt === result.updatedAt);
  return result;
};
