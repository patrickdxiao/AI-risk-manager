import {
  ApplicationError,
  DomainInvariantError,
  MAX_REVIEW_REPOSITORIES,
  normalizeStringList,
  requireInteger,
} from "../primitives.js";
import type {
  EvaluateStoredTriggers,
  EvaluateStoredTriggersResult,
} from "./storedTriggerEvaluation.js";
import type {
  ProcessTriggerDispatch,
  ProcessTriggerDispatchResult,
} from "./processTriggerDispatch.js";

export interface ReviewWorkerInput {
  /** Select automatic evaluation scope; saved dispatches retain their own approved scopes. */
  readonly repositoryIds: readonly string[];
  readonly reviewLimit: number;
  readonly signal?: AbortSignal;
}
export interface ReviewWorkerResult {
  readonly evaluation?: EvaluateStoredTriggersResult;
  readonly dispatches: readonly ProcessTriggerDispatchResult[];
  readonly errors: readonly { readonly stage: "evaluation" | "dispatch"; readonly code: string }[];
}

/** One bounded local turn; callers choose when to invoke it, without a background timer. */
export class ReviewWorker {
  constructor(
    private readonly evaluate: Pick<EvaluateStoredTriggers, "execute">,
    private readonly process: Pick<ProcessTriggerDispatch, "execute">,
  ) {}

  async execute(input: ReviewWorkerInput): Promise<ReviewWorkerResult> {
    const repositoryIds = Object.freeze(
      [
        ...new Set(
          normalizeStringList(input.repositoryIds, "repositoryIds", MAX_REVIEW_REPOSITORIES, 200),
        ),
      ].sort(),
    );
    const reviewLimit = requireInteger(input.reviewLimit, "reviewLimit", 1);
    if (reviewLimit > 10)
      throw new DomainInvariantError(
        "out_of_range",
        "One worker turn can process at most ten reviews",
        "reviewLimit",
      );
    const signal = input.signal;
    let evaluation: EvaluateStoredTriggersResult | undefined;
    const dispatches: ProcessTriggerDispatchResult[] = [];
    const errors: { readonly stage: "evaluation" | "dispatch"; readonly code: string }[] = [];
    if (signal?.aborted !== true) {
      try {
        // Admission and exact observation acknowledgement share the evaluator's transaction.
        evaluation = await this.evaluate.execute({ repositoryIds, cooldownMinutes: 15 });
      } catch (error) {
        errors.push({ stage: "evaluation", code: errorCode(error) });
      }
    }
    for (let index = 0; index < reviewLimit && signal?.aborted !== true; index++) {
      try {
        const result = await this.process.execute({
          leaseMinutes: 15,
          maxAttempts: 2,
          retryDelayMinutes: 1,
          ...(signal === undefined ? {} : { signal }),
        });
        if (result.status === "none") break;
        dispatches.push(result);
      } catch (error) {
        errors.push({ stage: "dispatch", code: errorCode(error) });
        // A failed claim could select the same record again; leave it for the next invocation.
        break;
      }
    }
    return Object.freeze({
      ...(evaluation === undefined ? {} : { evaluation }),
      dispatches: Object.freeze(dispatches),
      errors: Object.freeze(errors.map((error) => Object.freeze(error))),
    });
  }
}
function errorCode(error: unknown): string {
  return error instanceof ApplicationError || error instanceof DomainInvariantError
    ? error.code
    : "persistence_failure";
}
