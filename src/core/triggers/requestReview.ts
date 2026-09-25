import { createHash } from "node:crypto";
import { planningDigest } from "../investigation/evidenceScope.js";
import {
  ApplicationError,
  DomainInvariantError,
  MAX_REVIEW_REPOSITORIES,
  MAX_REVIEW_SEED_EVIDENCE,
  normalizeStringList,
  requireNonBlank,
  type ClockPort,
  type IdGeneratorPort,
} from "../primitives.js";
import type { UnitOfWorkPort } from "../storageContracts.js";
import { QueueReview, type QueueReviewResult } from "./triggerService.js";

interface ReviewScope {
  readonly sprintId: string;
  readonly taskId?: string;
  /** Explicit even for plan-only reviews, which use an empty list. */
  readonly repositoryIds: readonly string[];
}
export type RequestReviewInput = ReviewScope &
  (
    | {
        readonly type: "manual_review";
        readonly requestId: string;
        readonly evidenceIds?: readonly string[];
      }
    | { readonly type: "plan_changed" }
  );

/** Queue user intent or current saved plan facts without capturing or starting provider work. */
export class RequestReview {
  constructor(
    private readonly store: UnitOfWorkPort,
    private readonly ids: IdGeneratorPort,
    private readonly clock: ClockPort,
  ) {}

  async execute(input: RequestReviewInput): Promise<QueueReviewResult> {
    if (!["manual_review", "plan_changed"].includes(input.type))
      throw new DomainInvariantError("invalid_value", "Unsupported review request", "type");
    const type = input.type;
    const requestId =
      type === "manual_review" ? requireNonBlank(input.requestId, "requestId", 200) : undefined;
    const sprintId = requireNonBlank(input.sprintId, "sprintId", 200);
    const taskId =
      input.taskId === undefined ? undefined : requireNonBlank(input.taskId, "taskId", 200);
    const repositoryIds = Object.freeze(
      [
        ...new Set(
          normalizeStringList(input.repositoryIds, "repositoryIds", MAX_REVIEW_REPOSITORIES, 200),
        ),
      ].sort(),
    );
    const evidenceIds =
      type === "manual_review"
        ? [
            ...new Set(
              normalizeStringList(
                input.evidenceIds ?? [],
                "evidenceIds",
                MAX_REVIEW_SEED_EVIDENCE,
                200,
              ),
            ),
          ].sort()
        : [];
    const scope = Object.freeze({
      sprintId,
      ...(taskId === undefined ? {} : { taskId }),
      repositoryIds,
    });
    return this.store.execute(async (store) => {
      const evidenceDigests: string[] = [];
      for (const id of evidenceIds) {
        const item = await store.evidence.findById(id);
        if (item === undefined)
          throw new ApplicationError(
            "evidence_not_found",
            "Review evidence does not exist",
            "evidenceIds",
          );
        evidenceDigests.push(item.digest);
      }
      const inputSummary =
        requestId === undefined
          ? { planningDigest: await planningDigest(store, scope) }
          : { requestId };
      // Manual IDs identify one user action across retries, even after the plan changes.
      const identity = requestId === undefined ? [type, scope, inputSummary] : [type, requestId];
      return new QueueReview({ execute: (work) => work(store) }, this.ids, this.clock).execute({
        candidate: {
          version: "trigger-candidate.v1",
          ...scope,
          type,
          dedupKey: `trigger:${type}:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`,
          reason:
            type === "manual_review" ? "The user requested a review." : "The saved plan changed.",
          inputSummary,
          evidenceDigests,
        },
        evidenceIds,
        cooldownMinutes: 0,
      });
    });
  }
}
