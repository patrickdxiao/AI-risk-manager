import { requiresRepositoryId } from "../evidence/evidenceModel.js";
import {
  ApplicationError,
  DomainInvariantError,
  MAX_REVIEW_REPOSITORIES,
  MAX_REVIEW_SEED_EVIDENCE,
  normalizeJsonRecord,
  normalizeStringList,
  requireInteger,
  requireNonBlank,
  requireTimestampOrder,
  requireUtcTimestamp,
  type ClockPort,
  type IdGeneratorPort,
} from "../primitives.js";
import type { TransactionContext, UnitOfWorkPort } from "../storageContracts.js";
import {
  pendingTriggerDispatch,
  type TriggerCandidate,
  type TriggerInputValue,
  type TriggerQueueRecord,
} from "./triggerModel.js";

export const MAX_PENDING_REVIEWS = 100;
export interface QueueReviewInput {
  readonly candidate: TriggerCandidate;
  readonly evidenceIds: readonly string[];
  readonly cooldownMinutes: number;
}
export interface QueueReviewResult {
  readonly status: "queued" | "existing";
  readonly trigger: TriggerQueueRecord;
}

/** Admit one explicitly scoped request and its delivery atomically. */
export class QueueReview {
  constructor(
    private readonly store: UnitOfWorkPort,
    private readonly ids: IdGeneratorPort,
    private readonly clock: ClockPort,
  ) {}

  async execute(input: QueueReviewInput): Promise<QueueReviewResult> {
    const candidate = normalizeCandidate(input.candidate);
    const evidenceIds = normalizedSet(
      input.evidenceIds,
      "evidenceIds",
      200,
      MAX_REVIEW_SEED_EVIDENCE,
    );
    const cooldownMinutes = requireInteger(input.cooldownMinutes, "cooldownMinutes", 0);
    return this.store.execute(async (store) => {
      const observedAt = requireUtcTimestamp(this.clock.now(), "observedAt");
      const expiry = new Date(Date.parse(observedAt) + cooldownMinutes * 60_000);
      if (!Number.isFinite(expiry.valueOf()))
        throw new DomainInvariantError(
          "out_of_range",
          "Cooldown exceeds supported dates",
          "cooldownMinutes",
        );
      const cooldownUntil = requireUtcTimestamp(expiry.toISOString(), "cooldownUntil");
      if ((await store.planning.findSprintById(candidate.sprintId)) === undefined)
        throw new ApplicationError("sprint_not_found", "Sprint does not exist", "sprintId");
      if (candidate.taskId !== undefined) {
        const task = await store.planning.findTaskById(candidate.taskId);
        if (task?.sprintId !== candidate.sprintId)
          throw new DomainInvariantError(
            "scope_mismatch",
            "Task does not belong to the requested sprint",
            "taskId",
          );
      }
      for (const id of candidate.repositoryIds)
        if ((await store.repositories.findById(id)) === undefined)
          throw new ApplicationError(
            "repository_not_found",
            `Repository ${id} is not registered`,
            "repositoryIds",
          );
      const citations = await loadCitations(store, candidate, evidenceIds, observedAt);
      const request = { ...candidate, evidenceCitations: citations };
      const exact = await store.triggerQueue.findByDedupKey(candidate.dedupKey);
      if (exact !== undefined) {
        if (!sameFacts(exact, request))
          throw new DomainInvariantError(
            "invalid_value",
            "Deduplication key was reused for different request facts",
            "dedupKey",
          );
        return Object.freeze({ status: "existing", trigger: exact });
      }
      const latest = await store.triggerQueue.findLatestByCooldownScope(candidate);
      if (
        candidate.type !== "manual_review" &&
        latest !== undefined &&
        observedAt < latest.cooldownUntil &&
        sameFacts(latest, request)
      ) {
        const dispatch = await store.triggerDispatches.findByTriggerId(latest.id);
        if (dispatch !== undefined && dispatch.status !== "completed" && dispatch.status !== "dead")
          return Object.freeze({ status: "existing", trigger: latest });
      }
      if ((await store.triggerDispatches.countPending()) >= MAX_PENDING_REVIEWS)
        throw new ApplicationError(
          "investigation_queue_full",
          "The review queue has 100 unfinished requests",
          "reviews",
        );
      const trigger: TriggerQueueRecord = Object.freeze({
        ...request,
        version: "trigger-queue-record.v1",
        id: requireNonBlank(this.ids.next(), "triggerId", 200),
        observedAt,
        cooldownUntil,
      });
      await store.triggerQueue.add(trigger);
      await store.triggerDispatches.add(pendingTriggerDispatch(trigger.id, observedAt));
      return Object.freeze({ status: "queued", trigger });
    });
  }
}

/** Canonical scope is supplied explicitly; registering another repository never widens it. */
function normalizeCandidate(input: TriggerCandidate): TriggerCandidate {
  if (
    !["trigger-candidate.v1"].includes(input.version) ||
    !["git_change", "task_deadline", "scheduled_review", "manual_review", "plan_changed"].includes(
      input.type,
    )
  )
    throw new DomainInvariantError(
      "invalid_value",
      "Trigger version or type is invalid",
      "candidate",
    );
  const summary = normalizeJsonRecord(input.inputSummary, "inputSummary");
  const entries = Object.entries(summary).sort(([left], [right]) =>
    left < right ? -1 : left === right ? 0 : 1,
  );
  const inputSummary: Record<string, TriggerInputValue> = {};
  for (const [key, value] of entries) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
      Object.defineProperty(inputSummary, key, { value, enumerable: true });
    else if (Array.isArray(value) && value.every((item: unknown) => typeof item === "string"))
      Object.defineProperty(inputSummary, key, { value, enumerable: true });
    else
      throw new DomainInvariantError(
        "invalid_value",
        "Trigger facts must be scalar values or string lists",
        "inputSummary",
      );
  }
  return Object.freeze({
    version: "trigger-candidate.v1",
    type: input.type,
    sprintId: requireNonBlank(input.sprintId, "sprintId", 200),
    ...(input.taskId === undefined ? {} : { taskId: requireNonBlank(input.taskId, "taskId", 200) }),
    repositoryIds: normalizedSet(
      input.repositoryIds,
      "repositoryIds",
      200,
      MAX_REVIEW_REPOSITORIES,
    ),
    evidenceDigests: normalizedSet(
      input.evidenceDigests,
      "evidenceDigests",
      512,
      MAX_REVIEW_SEED_EVIDENCE,
    ),
    dedupKey: requireNonBlank(input.dedupKey, "dedupKey", 512),
    reason: requireNonBlank(input.reason, "reason", 4_000),
    inputSummary: Object.freeze(inputSummary),
  });
}

function normalizedSet(
  values: readonly string[],
  field: string,
  maximumLength: number,
  maximumCount: number,
): readonly string[] {
  return Object.freeze(
    [...new Set(normalizeStringList(values, field, maximumCount, maximumLength))].sort(),
  );
}

async function loadCitations(
  store: TransactionContext,
  candidate: TriggerCandidate,
  evidenceIds: readonly string[],
  now: string,
): Promise<TriggerQueueRecord["evidenceCitations"]> {
  const citations = [];
  for (const id of evidenceIds) {
    const item = await store.evidence.findById(id);
    if (item === undefined || item.id !== id)
      throw new ApplicationError(
        "evidence_not_found",
        `Evidence ${id} does not exist`,
        "evidenceIds",
      );
    requireTimestampOrder(
      requireUtcTimestamp(item.occurredAt, "evidence.occurredAt"),
      now,
      "evidence.occurredAt",
    );
    if (item.repositoryId !== undefined) {
      if (!candidate.repositoryIds.includes(item.repositoryId))
        throw new DomainInvariantError(
          "scope_mismatch",
          "Evidence repository is outside the request scope",
          "evidenceIds",
        );
    } else {
      // Queue seeds are deliberately limited to this sprint; tools load prerequisite evidence later.
      const task =
        item.taskId === undefined ? undefined : await store.planning.findTaskById(item.taskId);
      if (
        requiresRepositoryId(item) ||
        (item.sprintId !== undefined && item.sprintId !== candidate.sprintId) ||
        (task === undefined
          ? item.sprintId !== candidate.sprintId
          : task.sprintId !== candidate.sprintId) ||
        (item.taskId !== undefined &&
          (task === undefined ||
            (candidate.taskId !== undefined && item.taskId !== candidate.taskId)))
      )
        throw new DomainInvariantError(
          "scope_mismatch",
          "Plan evidence is outside the request scope",
          "evidenceIds",
        );
    }
    citations.push(Object.freeze({ evidenceId: id, digest: item.digest }));
  }
  if (
    JSON.stringify([...new Set(citations.map((item) => item.digest))].sort()) !==
    JSON.stringify(candidate.evidenceDigests)
  )
    throw new DomainInvariantError(
      "invalid_value",
      "Evidence IDs must match the request digests",
      "evidenceIds",
    );
  return Object.freeze(citations);
}

function sameFacts(
  left: TriggerQueueRecord,
  right: TriggerCandidate & Pick<TriggerQueueRecord, "evidenceCitations">,
): boolean {
  function identity(value: typeof left | typeof right): string {
    return JSON.stringify([
      value.type,
      value.sprintId,
      value.taskId ?? null,
      [...value.repositoryIds].sort(),
      Object.entries(value.inputSummary).sort(([left], [right]) =>
        left < right ? -1 : left === right ? 0 : 1,
      ),
      [...value.evidenceDigests].sort(),
      value.evidenceCitations
        .map((item) => [item.evidenceId, item.digest] as const)
        .sort(([left], [right]) => (left < right ? -1 : left === right ? 0 : 1)),
    ]);
  }
  return identity(left) === identity(right);
}
