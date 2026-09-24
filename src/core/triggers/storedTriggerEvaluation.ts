import { createHash } from "node:crypto";
import {
  ApplicationError,
  DomainInvariantError,
  MAX_REVIEW_REPOSITORIES,
  MAX_REVIEW_SEED_EVIDENCE,
  normalizeStringList,
  requireInteger,
  requireNonBlank,
  requireTimestampOrder,
  requireUtcTimestamp,
  type ClockPort,
  type IdGeneratorPort,
} from "../primitives.js";
import type { UnitOfWorkPort } from "../storageContracts.js";
import { evaluateTriggers } from "./evaluateTriggers.js";
import { QueueReview } from "./triggerService.js";
import type { TriggerCandidate, TriggerContext, TriggerQueueRecord } from "./triggerModel.js";

export interface EvaluateStoredTriggersInput {
  readonly repositoryIds: readonly string[];
  readonly sprintId?: string;
  /** Select one task for deadline evaluation; Git changes and cadence stay sprint-wide. */
  readonly taskId?: string;
  readonly cooldownMinutes: number;
}

export interface EvaluateStoredTriggersResult {
  readonly fired: readonly TriggerCandidate[];
  readonly queued: readonly TriggerQueueRecord[];
  readonly existing: readonly TriggerQueueRecord[];
  /** These facts remain unqueued; capture recovery must not acknowledge their observations. */
  readonly deferred: readonly TriggerCandidate[];
}

/** Build review requests from stored facts; this service neither captures Git nor starts agents. */
export class EvaluateStoredTriggers {
  constructor(
    private readonly store: UnitOfWorkPort,
    private readonly ids: IdGeneratorPort,
    private readonly clock: ClockPort,
  ) {}

  async execute(input: EvaluateStoredTriggersInput): Promise<EvaluateStoredTriggersResult> {
    const repositoryIds = Object.freeze(
      [
        ...new Set(
          normalizeStringList(input.repositoryIds, "repositoryIds", MAX_REVIEW_REPOSITORIES, 200),
        ),
      ].sort(),
    );
    const cooldownMinutes = requireInteger(input.cooldownMinutes, "cooldownMinutes", 0);
    const taskId =
      input.taskId === undefined ? undefined : requireNonBlank(input.taskId, "taskId", 200);
    const requestedSprintId =
      input.sprintId === undefined ? undefined : requireNonBlank(input.sprintId, "sprintId", 200);
    return this.store.execute(async (store) => {
      const now = requireUtcTimestamp(this.clock.now(), "now");
      for (const id of repositoryIds)
        if ((await store.repositories.findById(id)) === undefined)
          throw new ApplicationError(
            "repository_not_found",
            `Repository ${id} is not registered`,
            "repositoryIds",
          );
      const selectedTask =
        taskId === undefined ? undefined : await store.planning.findTaskById(taskId);
      if (taskId !== undefined && selectedTask === undefined)
        throw new ApplicationError("task_not_found", "Task does not exist", "taskId");
      const sprintId = requestedSprintId ?? selectedTask?.sprintId;
      const sprint =
        sprintId === undefined
          ? await store.planning.findActiveSprint()
          : await store.planning.findSprintById(sprintId);
      if (sprintId !== undefined && sprint === undefined)
        throw new ApplicationError("sprint_not_found", "Sprint does not exist", "sprintId");
      if (selectedTask !== undefined && selectedTask.sprintId !== sprint?.id)
        throw new DomainInvariantError(
          "scope_mismatch",
          "Task does not belong to the selected sprint",
          "taskId",
        );
      const pending: {
        readonly candidate: TriggerCandidate;
        readonly evidenceIds: readonly string[];
      }[] = [];
      if (sprint !== undefined) {
        const base: TriggerContext = {
          version: "trigger-context.v1",
          now,
          repositoryIds,
          evidenceDigests: [],
          sprint: { id: sprint.id, startAt: sprint.startAt, endAt: sprint.endAt },
        };
        if (sprint.state === "active" && Date.parse(now) < Date.parse(sprint.endAt)) {
          const lastReviewedAt = (await store.investigations.findLatestSubmittedResult(sprint.id))
            ?.investigation.completedAt;
          for (const candidate of evaluateTriggers({
            ...base,
            sprint: {
              ...base.sprint,
              reviewCadenceMinutes: sprint.reviewCadenceMinutes,
              ...(lastReviewedAt === undefined ? {} : { lastReviewedAt }),
            },
          }))
            pending.push({ candidate, evidenceIds: [] });
        }
        for (const repositoryId of repositoryIds) {
          const observation = await store.repositoryObservations.findByRepositoryId(repositoryId);
          if (observation === undefined) continue;
          if (observation.repositoryId !== repositoryId)
            throw new DomainInvariantError(
              "scope_mismatch",
              "Stored observation does not match the selected repository",
              "repositoryId",
            );
          const occurredAt = requireUtcTimestamp(observation.observedAt, "observation.observedAt");
          requireTimestampOrder(occurredAt, now, "observation.observedAt");
          const snapshotDigest = requireNonBlank(
            observation.snapshot.snapshotDigest,
            "snapshotDigest",
            512,
          );
          const allIds = [
            ...new Set(normalizeStringList(observation.evidenceIds, "evidenceIds", 100, 200)),
          ].sort();
          if (allIds.length === 0)
            throw new DomainInvariantError(
              "required",
              "Saved observation has no supporting evidence",
              "evidenceIds",
            );
          const seeds = [];
          for (const id of allIds) {
            const item = await store.evidence.findById(id);
            if (
              item?.id !== id ||
              item.repositoryId !== repositoryId ||
              item.source !== "git" ||
              item.sprintId !== undefined ||
              item.taskId !== undefined
            )
              throw new DomainInvariantError(
                "scope_mismatch",
                "Observation evidence is missing or has different provenance",
                "evidenceIds",
              );
            requireTimestampOrder(item.occurredAt, occurredAt, "evidence.occurredAt");
            seeds.push(item);
          }
          const selected = seeds.slice(0, MAX_REVIEW_SEED_EVIDENCE);
          const digests = [...new Set(selected.map((item) => item.digest))].sort();
          const first = selected[0];
          if (first === undefined) throw new Error("Observation requires a seed");
          for (const candidate of evaluateTriggers({
            ...base,
            evidenceDigests: digests,
            gitChange: { repositoryId, occurredAt, digest: first.digest },
          }))
            pending.push({
              candidate: Object.freeze({
                ...candidate,
                inputSummary: Object.freeze({
                  ...candidate.inputSummary,
                  snapshotDigest,
                  evidenceCount: allIds.length,
                  seedEvidenceCount: selected.length,
                }),
                dedupKey: `trigger:git_change:${createHash("sha256")
                  .update(JSON.stringify([candidate.dedupKey, snapshotDigest, occurredAt, allIds]))
                  .digest("hex")}`,
              }),
              evidenceIds: selected.map((item) => item.id),
            });
        }
        const tasks =
          selectedTask === undefined
            ? await store.planning.findTasksBySprintId(sprint.id)
            : [selectedTask];
        const unfinished = tasks.filter((task) => task.state !== "done");
        if (unfinished.length > 1_000)
          throw new DomainInvariantError(
            "out_of_range",
            "At most 1,000 unfinished tasks can be evaluated",
            "tasks",
          );
        for (const task of unfinished) {
          if (task.sprintId !== sprint.id)
            throw new DomainInvariantError(
              "scope_mismatch",
              "Stored task does not belong to the selected sprint",
              "taskId",
            );
          for (const candidate of evaluateTriggers({
            ...base,
            task: { id: task.id, state: task.state, deadlineAt: task.endAt },
          }))
            pending.push({ candidate, evidenceIds: [] });
        }
      }
      const queue = new QueueReview({ execute: (work) => work(store) }, this.ids, {
        now: () => now,
      });
      const queued: TriggerQueueRecord[] = [];
      const existing: TriggerQueueRecord[] = [];
      const deferred: TriggerCandidate[] = [];
      for (const request of pending) {
        try {
          const result = await queue.execute({
            ...request,
            cooldownMinutes,
          });
          (result.status === "queued" ? queued : existing).push(result.trigger);
        } catch (error) {
          if (!(error instanceof ApplicationError) || error.code !== "investigation_queue_full")
            throw error;
          deferred.push(request.candidate);
        }
      }
      return Object.freeze({
        fired: Object.freeze(pending.map((item) => item.candidate)),
        queued: Object.freeze(queued),
        existing: Object.freeze(existing),
        deferred: Object.freeze(deferred),
      });
    });
  }
}
