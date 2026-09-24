import {
  InvestigationExecutionError,
  type ExecuteInvestigation,
} from "../investigation/executeInvestigation.js";
import {
  createInvestigation,
  failInvestigation,
  type Investigation,
} from "../investigation/investigationModel.js";
import {
  ApplicationError,
  DomainInvariantError,
  requireInteger,
  requireUtcTimestamp,
  type ClockPort,
  type IdGeneratorPort,
} from "../primitives.js";
import type { TransactionContext, UnitOfWorkPort } from "../storageContracts.js";
import type { TriggerDispatch, TriggerQueueRecord } from "./triggerModel.js";

export interface ProcessTriggerDispatchInput {
  readonly leaseMinutes: number;
  readonly maxAttempts: number;
  readonly retryDelayMinutes: number;
  readonly signal?: AbortSignal;
}

export type ProcessTriggerDispatchResult =
  | { readonly status: "none" }
  | { readonly status: "stale"; readonly triggerId: string }
  | {
      readonly status: "completed" | "retry_wait" | "dead";
      readonly dispatch: TriggerDispatch;
    };

/** Deliver one saved request; only the current lease may settle or reschedule it. */
export class ProcessTriggerDispatch {
  constructor(
    private readonly store: UnitOfWorkPort,
    private readonly investigation: Pick<ExecuteInvestigation, "execute">,
    private readonly ids: IdGeneratorPort,
    private readonly clock: ClockPort,
  ) {}

  async execute(input: ProcessTriggerDispatchInput): Promise<ProcessTriggerDispatchResult> {
    const leaseMinutes = requireInteger(input.leaseMinutes, "leaseMinutes", 1);
    const maxAttempts = requireInteger(input.maxAttempts, "maxAttempts", 1);
    const retryDelayMinutes = requireInteger(input.retryDelayMinutes, "retryDelayMinutes", 1);
    const signal = input.signal;
    if (signal?.aborted === true) return Object.freeze({ status: "none" });
    const claim = await this.store.execute(async (store) => {
      const now = requireUtcTimestamp(this.clock.now(), "now");
      const leaseExpiresAt = addMinutes(now, leaseMinutes);
      addMinutes(now, retryDelayMinutes * maxAttempts);
      // Admission is installation-wide; contention consumes no delivery attempt.
      if ((await store.investigations.findActive(now)) !== undefined)
        return { status: "none" as const };
      const current = await store.triggerDispatches.findNextDue(now);
      if (current === undefined) return { status: "none" as const };
      if (
        !["pending", "retry_wait", "leased"].includes(current.status) ||
        Date.parse(current.dueAt) > Date.parse(now) ||
        (current.status === "leased" && Date.parse(current.leaseExpiresAt ?? "") > Date.parse(now))
      )
        throw new DomainInvariantError("invalid_transition", "Dispatch is not due", "dispatch");
      const trigger = await store.triggerQueue.findById(current.triggerId);
      if (trigger === undefined) throw new Error("Dispatch request is missing");
      let investigation = await store.investigations.findByDedupKey({
        sprintId: trigger.sprintId,
        ...(trigger.taskId === undefined ? {} : { taskId: trigger.taskId }),
        triggerId: trigger.id,
      });
      if (current.investigationId !== undefined && current.investigationId !== investigation?.id)
        throw new Error("Dispatch investigation does not match its request");
      if (investigation !== undefined) {
        const receipt = await store.investigations.findSubmittedResult(investigation.id);
        if (receipt !== undefined) {
          const dispatch = terminal(current, investigation.id, now, "completed");
          await saveFence(store, dispatch, current);
          return { status: "completed" as const, dispatch };
        }
      }
      if (investigation === undefined) {
        investigation = createInvestigation({
          id: this.ids.next(),
          sprintId: trigger.sprintId,
          ...(trigger.taskId === undefined ? {} : { taskId: trigger.taskId }),
          triggerId: trigger.id,
          requestedAt: current.createdAt,
        });
        await store.investigations.add(investigation);
      }
      const failureCode =
        current.attempts >= maxAttempts
          ? "attempt_limit"
          : investigation.status === "failed" && investigation.failure?.retryable !== true
            ? "permanent_failure"
            : investigation.status === "completed"
              ? "missing_result"
              : undefined;
      if (failureCode !== undefined) {
        const dispatch = terminal(current, investigation.id, now, "dead", failureCode);
        await stopUnownedInvestigation(store, investigation, now, failureCode);
        await saveFence(store, dispatch, current);
        return { status: "dead" as const, dispatch };
      }
      const dispatch: TriggerDispatch = Object.freeze({
        version: "trigger-dispatch.v1",
        triggerId: current.triggerId,
        investigationId: investigation.id,
        status: "leased",
        leaseVersion: requireInteger(current.leaseVersion + 1, "leaseVersion", 1),
        attempts: requireInteger(current.attempts + 1, "attempts", 1),
        dueAt: current.dueAt,
        leaseExpiresAt,
        createdAt: current.createdAt,
        updatedAt: now,
      });
      await saveFence(store, dispatch, current);
      return { status: "claimed" as const, dispatch, trigger, investigation };
    });
    if (claim.status !== "claimed") return Object.freeze(claim);
    let failure: { code: string; retryable: boolean } | undefined;
    try {
      await this.investigation.execute({
        investigationId: claim.investigation.id,
        repositoryIds: claim.trigger.repositoryIds,
        evidenceIds: claim.trigger.evidenceCitations.map((citation) => citation.evidenceId),
        context: dispatchContext(claim.trigger),
        dispatchLease: {
          triggerId: claim.dispatch.triggerId,
          leaseVersion: claim.dispatch.leaseVersion,
        },
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      failure =
        error instanceof InvestigationExecutionError
          ? { code: error.failureCode, retryable: error.retryable }
          : error instanceof ApplicationError || error instanceof DomainInvariantError
            ? { code: error.code, retryable: false }
            : { code: "persistence_failure", retryable: true };
    }
    return this.store.execute(async (store) => {
      const now = requireUtcTimestamp(this.clock.now(), "now");
      const current = await store.triggerDispatches.findByTriggerId(claim.dispatch.triggerId);
      if (current?.leaseVersion === claim.dispatch.leaseVersion && current.status === "completed")
        return Object.freeze({ status: "completed", dispatch: current });
      if (
        failure?.code === "execution_lease_lost" ||
        current?.status !== "leased" ||
        current.leaseVersion !== claim.dispatch.leaseVersion ||
        !(Date.parse(current.leaseExpiresAt ?? "") > Date.parse(now))
      )
        return Object.freeze({ status: "stale", triggerId: claim.dispatch.triggerId });
      // A successful runtime call alone is insufficient; acceptance must have saved a receipt.
      const receipt = await store.investigations.findSubmittedResult(claim.investigation.id);
      const contention = failure?.code === "execution_in_progress";
      const attempts = current.attempts - (contention ? 1 : 0);
      const outcome =
        receipt !== undefined
          ? undefined
          : (failure ?? { code: "missing_result", retryable: true });
      const retry = outcome?.retryable === true && attempts < maxAttempts;
      const dispatch: TriggerDispatch =
        outcome === undefined
          ? terminal(current, claim.investigation.id, now, "completed")
          : retry
            ? Object.freeze({
                version: "trigger-dispatch.v1",
                triggerId: current.triggerId,
                investigationId: claim.investigation.id,
                status: "retry_wait",
                leaseVersion: current.leaseVersion,
                attempts,
                dueAt: addMinutes(now, retryDelayMinutes * Math.max(1, attempts)),
                failureCode: outcome.code,
                createdAt: current.createdAt,
                updatedAt: now,
              })
            : terminal(current, claim.investigation.id, now, "dead", outcome.code);
      if (dispatch.status === "dead") {
        const saved = await store.investigations.findById(claim.investigation.id);
        if (saved !== undefined)
          await stopUnownedInvestigation(store, saved, now, outcome?.code ?? "missing_result");
      }
      await saveFence(store, dispatch, current);
      return Object.freeze({
        status: dispatch.status as "completed" | "retry_wait" | "dead",
        dispatch,
      });
    });
  }
}

function terminal(
  value: TriggerDispatch,
  investigationId: string,
  now: string,
  status: "completed" | "dead",
  failureCode?: string,
): TriggerDispatch {
  return Object.freeze({
    version: "trigger-dispatch.v1",
    triggerId: value.triggerId,
    investigationId,
    status,
    leaseVersion: value.leaseVersion,
    attempts: value.attempts,
    dueAt: value.dueAt,
    createdAt: value.createdAt,
    updatedAt: now,
    completedAt: now,
    ...(failureCode === undefined ? {} : { failureCode }),
  });
}

async function stopUnownedInvestigation(
  store: TransactionContext,
  investigation: Investigation,
  now: string,
  code: string,
): Promise<void> {
  if (investigation.status !== "running" && investigation.status !== "requested") return;
  await store.investigations.save(
    failInvestigation(investigation, {
      completedAt: now,
      failure: { code, message: "Saved review could not be delivered", retryable: false },
    }),
  );
  if (investigation.executionAttemptId === undefined) return;
  const attempt = await store.investigations.findAttemptById(investigation.executionAttemptId);
  if (attempt?.status === "running")
    await store.investigations.saveAttempt(
      Object.freeze({
        ...attempt,
        status: "expired",
        completedAt: now,
        terminalReason: code,
        durationMs: Math.max(0, Date.parse(now) - Date.parse(attempt.startedAt)),
      }),
    );
}

async function saveFence(
  store: TransactionContext,
  next: TriggerDispatch,
  expected: TriggerDispatch,
): Promise<void> {
  if (!(await store.triggerDispatches.saveFenced(next, expected.leaseVersion, expected.status)))
    throw new ApplicationError("execution_lease_lost", "Dispatch lease changed", "leaseVersion");
}

function addMinutes(now: string, minutes: number): string {
  const date = new Date(Date.parse(now) + minutes * 60_000);
  if (!Number.isFinite(date.valueOf()))
    throw new DomainInvariantError(
      "out_of_range",
      "Dispatch deadline exceeds supported dates",
      "minutes",
    );
  return requireUtcTimestamp(date.toISOString(), "dueAt");
}

/** Fixed-size facts keep the execution prompt bounded; seeds are passed separately. */
function dispatchContext(trigger: TriggerQueueRecord): string {
  const full = JSON.stringify({
    triggerId: trigger.id,
    type: trigger.type,
    reason: trigger.reason,
    inputSummary: trigger.inputSummary,
  });
  return full.length <= 4_000
    ? full
    : JSON.stringify({
        triggerId: trigger.id,
        type: trigger.type,
        reason: trigger.reason.slice(0, 300),
        inputSummaryOmitted: true,
      });
}
