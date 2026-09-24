import { createHash } from "node:crypto";
import {
  DomainInvariantError,
  MAX_REVIEW_REPOSITORIES,
  MAX_REVIEW_SEED_EVIDENCE,
  normalizeStringList,
  requireInteger,
  requireNonBlank,
  requireTimestampOrder,
  requireUtcTimestamp,
} from "../primitives.js";
import type { TriggerCandidate, TriggerContext, TriggerType } from "./triggerModel.js";

/** Turn observed changes and elapsed plan dates into requests, never risk or completion claims. */
export function evaluateTriggers(context: TriggerContext): readonly TriggerCandidate[] {
  if (!["trigger-context.v1"].includes(context.version))
    throw new DomainInvariantError(
      "invalid_value",
      "Unsupported trigger context version",
      "version",
    );
  const now = requireUtcTimestamp(context.now, "now");
  const sprintId = requireNonBlank(context.sprint.id, "sprint.id", 200);
  const startAt = requireUtcTimestamp(context.sprint.startAt, "sprint.startAt");
  const endAt = requireUtcTimestamp(context.sprint.endAt, "sprint.endAt");
  requireTimestampOrder(startAt, endAt, "sprint.endAt", false);
  const repositoryIds = canonicalSet(
    context.repositoryIds,
    "repositoryIds",
    200,
    MAX_REVIEW_REPOSITORIES,
  );
  const evidenceDigests = canonicalSet(
    context.evidenceDigests,
    "evidenceDigests",
    512,
    MAX_REVIEW_SEED_EVIDENCE,
  );
  const taskId =
    context.task === undefined ? undefined : requireNonBlank(context.task.id, "task.id", 200);
  const candidates: TriggerCandidate[] = [];

  function add(
    type: Exclude<TriggerType, "manual_review" | "plan_changed">,
    reason: string,
    facts: Readonly<Record<string, string | number>>,
    targetTaskId: string | undefined,
    digests = evidenceDigests,
  ): void {
    const inputSummary = Object.freeze(facts);
    const digest = createHash("sha256")
      .update(
        JSON.stringify([
          "trigger-candidate.v1",
          type,
          sprintId,
          targetTaskId ?? null,
          repositoryIds,
          inputSummary,
          digests,
        ]),
      )
      .digest("hex");
    candidates.push(
      Object.freeze({
        version: "trigger-candidate.v1",
        type,
        sprintId,
        ...(targetTaskId === undefined ? {} : { taskId: targetTaskId }),
        repositoryIds,
        dedupKey: `trigger:${type}:${digest}`,
        reason,
        inputSummary,
        evidenceDigests: digests,
      }),
    );
  }

  if (context.gitChange !== undefined) {
    const repositoryId = requireNonBlank(
      context.gitChange.repositoryId,
      "gitChange.repositoryId",
      200,
    );
    if (!repositoryIds.includes(repositoryId))
      throw new DomainInvariantError(
        "invalid_value",
        "Git change is outside the approved repository scope",
        "gitChange.repositoryId",
      );
    const occurredAt = requireUtcTimestamp(context.gitChange.occurredAt, "gitChange.occurredAt");
    requireTimestampOrder(occurredAt, now, "gitChange.occurredAt");
    const digest = requireNonBlank(context.gitChange.digest, "gitChange.digest", 512);
    add(
      "git_change",
      "A Git change was observed.",
      { repositoryId, occurredAt, digest },
      taskId,
      canonicalSet(
        [...new Set([...evidenceDigests, digest])],
        "evidenceDigests",
        512,
        MAX_REVIEW_SEED_EVIDENCE,
      ),
    );
  }

  if (context.task !== undefined) {
    if (!["planned", "in_progress", "needs_confirmation", "done"].includes(context.task.state))
      throw new DomainInvariantError("invalid_value", "Task state is invalid", "task.state");
    const deadlineAt = requireUtcTimestamp(context.task.deadlineAt, "task.deadlineAt");
    if (context.task.state !== "done" && Date.parse(now) >= Date.parse(deadlineAt))
      add("task_deadline", "The unfinished task has reached its end date.", { deadlineAt }, taskId);
  }

  if (context.sprint.reviewCadenceMinutes !== undefined) {
    const cadence = requireInteger(
      context.sprint.reviewCadenceMinutes,
      "sprint.reviewCadenceMinutes",
      1,
    );
    const lastReviewedAt =
      context.sprint.lastReviewedAt === undefined
        ? startAt
        : requireUtcTimestamp(context.sprint.lastReviewedAt, "sprint.lastReviewedAt");
    // Reviews made before the sprint starts do not advance its first scheduled review.
    const reviewBaseAt = lastReviewedAt < startAt ? startAt : lastReviewedAt;
    if ((Date.parse(now) - Date.parse(reviewBaseAt)) / 60_000 >= cadence)
      add(
        "scheduled_review",
        "The configured sprint review interval has elapsed.",
        {
          reviewBaseAt,
          reviewCadenceMinutes: cadence,
        },
        undefined,
      );
  }
  return Object.freeze(candidates);
}

/** Reject blank or oversized entries before deduplicating and sorting their canonical values. */
function canonicalSet(
  values: readonly string[],
  field: string,
  maximumLength: number,
  maximumCount: number,
): readonly string[] {
  return Object.freeze(
    [...new Set(normalizeStringList(values, field, maximumCount, maximumLength))].sort(),
  );
}
