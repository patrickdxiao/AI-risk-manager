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
} from "../primitives.js";
import type { UnitOfWorkPort } from "../storageContracts.js";
import {
  assertExecutionOwnership,
  createAttemptAuthority,
  newAttemptToken,
} from "./attemptAuthority.js";
import { evidenceInScope, selectPlanningContext } from "./evidenceScope.js";
import {
  failInvestigation,
  normalizeInvestigationUsage,
  retryInvestigation,
  startInvestigation,
  type InvestigationAttempt,
  type InvestigationFailure,
  type InvestigationRuntimePort,
  type InvestigationRuntimeRun,
  type InvestigationUsage,
  type RunInvestigationInput,
} from "./investigationModel.js";
import type {
  InvestigationAcceptance,
  SubmitInvestigationResult,
} from "./submitInvestigationResult.js";

export const INVESTIGATION_TIMEOUT_MS = 10 * 60_000;
const FINALIZATION_GRACE_MS = 5_000;

export interface ExecuteInvestigationInput {
  readonly investigationId: string;
  readonly repositoryIds: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly context: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly dispatchLease?: { readonly triggerId: string; readonly leaseVersion: number };
}

export interface ExecuteInvestigationResult {
  readonly status: "submitted" | "existing";
  readonly acceptance: InvestigationAcceptance;
}

/** Safe failures carry retry policy, never provider error messages or credentials. */
export class InvestigationExecutionError extends ApplicationError {
  constructor(
    readonly failureCode: string,
    readonly retryable: boolean,
  ) {
    super(
      "investigation_execution_failed",
      `Investigation execution failed (${failureCode})`,
      "investigationId",
    );
  }
}

/** A runtime adapter can retain measured usage even when its run fails. */
export class InvestigationRuntimeError extends Error {
  constructor(
    readonly code: "runtime_unavailable" | "runtime_failure" | "invalid_runtime_result",
    readonly retryable: boolean,
    readonly usage?: InvestigationUsage,
  ) {
    super("Investigation runtime failed");
  }
}

/** Claim and reserve atomically, run outside storage, and accept only the current attempt. */
export class ExecuteInvestigation {
  constructor(
    private readonly store: UnitOfWorkPort,
    private readonly runtime: InvestigationRuntimePort,
    private readonly submit: Pick<SubmitInvestigationResult, "execute">,
    private readonly clock: ClockPort,
  ) {}

  async execute(input: ExecuteInvestigationInput): Promise<ExecuteInvestigationResult> {
    const investigationId = requireNonBlank(input.investigationId, "investigationId", 200);
    const repositoryIds = Object.freeze(
      [
        ...new Set(
          normalizeStringList(input.repositoryIds, "repositoryIds", MAX_REVIEW_REPOSITORIES, 200),
        ),
      ].sort(),
    );
    const evidenceIds = Object.freeze(
      [
        ...new Set(
          normalizeStringList(input.evidenceIds, "evidenceIds", MAX_REVIEW_SEED_EVIDENCE, 200),
        ),
      ].sort(),
    );
    const context = requireNonBlank(input.context, "context", 4_000);
    const timeoutMs = requireInteger(input.timeoutMs ?? INVESTIGATION_TIMEOUT_MS, "timeoutMs", 1);
    if (timeoutMs > INVESTIGATION_TIMEOUT_MS)
      throw new DomainInvariantError(
        "out_of_range",
        "Runtime timeout cannot exceed ten minutes",
        "timeoutMs",
      );
    const signal = input.signal;
    const dispatchLease =
      input.dispatchLease === undefined
        ? undefined
        : Object.freeze({
            triggerId: requireNonBlank(
              input.dispatchLease.triggerId,
              "dispatchLease.triggerId",
              200,
            ),
            leaseVersion: requireInteger(
              input.dispatchLease.leaseVersion,
              "dispatchLease.leaseVersion",
              1,
            ),
          });
    const loaded = await this.store.execute(async (store) => {
      const { investigations } = store;
      const current = await investigations.findById(investigationId);
      if (current === undefined)
        throw new ApplicationError(
          "investigation_not_found",
          "Investigation does not exist",
          "investigationId",
        );
      const receipt = await investigations.findSubmittedResult(investigationId);
      if (receipt !== undefined) {
        const completedAt = requireUtcTimestamp(
          receipt.investigation.completedAt ?? "",
          "completedAt",
        );
        return {
          acceptance: Object.freeze({
            investigationId,
            resultDigest: receipt.resultDigest,
            completedAt,
          }),
        };
      }
      if (signal?.aborted === true) throw cancelled(signal);
      const now = requireUtcTimestamp(this.clock.now(), "now");
      if ((await investigations.findActive(now)) !== undefined)
        throw new InvestigationExecutionError("execution_in_progress", true);
      const dispatch = await store.triggerDispatches.findByTriggerId(current.triggerId);
      let deadline = Date.parse(now) + timeoutMs + FINALIZATION_GRACE_MS;
      const seedDigests = new Map<string, string>();
      if (dispatch !== undefined || dispatchLease !== undefined) {
        if (
          dispatch?.status !== "leased" ||
          dispatch.investigationId !== current.id ||
          dispatch.triggerId !== dispatchLease?.triggerId ||
          dispatch.leaseVersion !== dispatchLease.leaseVersion
        )
          throw leaseLost();
        const queued = await store.triggerQueue.findById(dispatch.triggerId);
        if (
          queued === undefined ||
          queued.sprintId !== current.sprintId ||
          queued.taskId !== current.taskId ||
          JSON.stringify([...queued.repositoryIds].sort()) !== JSON.stringify(repositoryIds) ||
          JSON.stringify(queued.evidenceCitations.map((item) => item.evidenceId).sort()) !==
            JSON.stringify(evidenceIds)
        )
          throw new ApplicationError(
            "evidence_scope_mismatch",
            "Execution must retain the queued scope and seed evidence",
            "repositoryIds",
          );
        for (const citation of queued.evidenceCitations)
          seedDigests.set(citation.evidenceId, citation.digest);
        deadline = Math.min(
          deadline,
          Date.parse(requireUtcTimestamp(dispatch.leaseExpiresAt ?? "", "dispatch.leaseExpiresAt")),
        );
      }
      const runTimeoutMs = Math.min(timeoutMs, deadline - Date.parse(now) - FINALIZATION_GRACE_MS);
      if (runTimeoutMs <= 0) throw leaseLost();
      const running =
        current.status === "requested"
          ? startInvestigation(current, now)
          : current.status === "failed"
            ? retryInvestigation(current, now)
            : current;
      if (running.status !== "running")
        throw new DomainInvariantError(
          "invalid_transition",
          "Investigation cannot execute",
          "status",
        );
      await investigations.save(running);
      const claimed = await investigations.claimExecution(
        current.id,
        now,
        requireUtcTimestamp(new Date(deadline).toISOString(), "leaseUntil"),
      );
      if (
        claimed?.executionAttemptId === undefined ||
        claimed.executionVersion === undefined ||
        claimed.executionLeaseUntil === undefined
      )
        throw new InvestigationExecutionError("execution_in_progress", true);
      const token = newAttemptToken(claimed.executionAttemptId);
      const authority = await createAttemptAuthority(store, claimed, { token, repositoryIds, now });
      const attempt: InvestigationAttempt = Object.freeze({
        id: claimed.executionAttemptId,
        investigationId,
        version: claimed.executionVersion,
        status: "running",
        startedAt: now,
        leaseUntil: claimed.executionLeaseUntil,
        timeoutMs: runTimeoutMs,
        queueWaitMs: Date.parse(now) - Date.parse(current.requestedAt),
        promptVersion: "development-risk.investigator.v1",
        resultSchemaVersion: "1",
        authority,
        ...(dispatchLease === undefined
          ? {}
          : {
              dispatchTriggerId: dispatchLease.triggerId,
              dispatchLeaseVersion: dispatchLease.leaseVersion,
            }),
      });
      const plan = await selectPlanningContext(store, claimed);
      for (const id of evidenceIds) {
        const item = await store.evidence.findById(id);
        if (item?.id !== id)
          throw new ApplicationError(
            "evidence_not_found",
            "Seed evidence does not exist",
            "evidenceIds",
          );
        if (
          (dispatchLease !== undefined && seedDigests.get(id) !== item.digest) ||
          !evidenceInScope(item, claimed, attempt, plan)
        )
          throw new ApplicationError(
            "evidence_scope_mismatch",
            "Seed evidence is outside the attempt scope",
            "evidenceIds",
          );
        requireTimestampOrder(
          requireUtcTimestamp(item.occurredAt, "evidence.occurredAt"),
          now,
          "evidence.occurredAt",
        );
      }
      if (current.executionAttemptId !== undefined) {
        const previous = await investigations.findAttemptById(current.executionAttemptId);
        if (previous?.status === "running")
          await investigations.saveAttempt(
            Object.freeze({
              ...previous,
              status: "expired",
              completedAt: now,
              terminalReason: "lease_expired",
              durationMs: Date.parse(now) - Date.parse(previous.startedAt),
            }),
          );
      }
      await investigations.saveAttempt(attempt);
      await assertExecutionOwnership(store, claimed, attempt.id, now);
      const prompt = JSON.stringify({
        version: "development-risk.investigator.v1",
        investigation: {
          id: current.id,
          sprintId: current.sprintId,
          taskId: current.taskId ?? null,
          triggerId: current.triggerId,
        },
        repositoryIds,
        evidenceIds,
        context,
      });
      return { attempt, token, prompt };
    });
    if (loaded.acceptance !== undefined)
      return Object.freeze({ status: "existing", acceptance: loaded.acceptance });
    const { attempt, token, prompt } = loaded;
    let usage: InvestigationUsage | undefined;
    let phase: "runtime" | "validation" | "persistence" = "runtime";
    try {
      const remaining = Math.min(
        attempt.timeoutMs,
        Date.parse(attempt.leaseUntil) -
          Date.parse(requireUtcTimestamp(this.clock.now(), "now")) -
          FINALIZATION_GRACE_MS,
      );
      if (remaining <= 0) throw new InvestigationExecutionError("runtime_timeout", true);
      const runtime = await runBounded(
        this.runtime,
        { prompt, attemptId: attempt.id, attemptToken: token, timeoutMs: remaining },
        signal,
      );
      phase = "validation";
      usage = normalizeInvestigationUsage(runtime.usage);
      if (runtime.latencyMs !== undefined)
        usage = normalizeInvestigationUsage({ ...usage, latencyMs: runtime.latencyMs });
      const metadata = runtimeMetadata(runtime, token);
      phase = "persistence";
      await this.store.execute(async (store) => {
        const current = await store.investigations.findById(investigationId);
        if (current === undefined) throw leaseLost();
        const owned = await assertExecutionOwnership(store, current, attempt.id, this.clock.now());
        await store.investigations.saveAttempt(
          Object.freeze({ ...owned, ...metadata, ...(usage === undefined ? {} : { usage }) }),
        );
      });
      if (runtime.structuredResult === undefined)
        throw new InvestigationExecutionError("invalid_runtime_result", false);
      if (signal?.aborted === true) throw cancelled(signal);
      const acceptance = await this.submit.execute({
        token,
        result: runtime.structuredResult,
        ...(usage === undefined ? {} : { usage }),
      });
      return Object.freeze({ status: "submitted", acceptance });
    } catch (error) {
      if (error instanceof ApplicationError && error.code === "execution_lease_lost") throw error;
      const failure = runtimeFailure(error, phase);
      if (error instanceof InvestigationRuntimeError) {
        try {
          usage = normalizeInvestigationUsage(error.usage);
        } catch {
          /* Invalid usage remains unknown; it never clears the reservation. */
        }
      }
      await this.store
        .execute(async (store) => {
          const current = await store.investigations.findById(investigationId);
          if (current === undefined) throw leaseLost();
          const now = requireUtcTimestamp(this.clock.now(), "now");
          const owned = await assertExecutionOwnership(store, current, attempt.id, now);
          await store.investigations.save(
            failInvestigation(current, {
              completedAt: now,
              failure,
              ...(usage === undefined ? {} : { usage }),
            }),
          );
          await store.investigations.saveAttempt(
            Object.freeze({
              ...owned,
              status: failure.code === "execution_cancelled" ? "cancelled" : "failed",
              completedAt: now,
              terminalReason: failure.code,
              durationMs: Date.parse(now) - Date.parse(attempt.startedAt),
              ...(usage === undefined ? {} : { usage }),
            }),
          );
        })
        .catch((error: unknown) => {
          if (error instanceof ApplicationError && error.code === "execution_lease_lost")
            throw error;
          throw new InvestigationExecutionError("persistence_failure", true);
        });
      throw new InvestigationExecutionError(failure.code, failure.retryable);
    }
  }
}

function runtimeMetadata(runtime: InvestigationRuntimeRun, token: string) {
  if (typeof runtime.runId !== "string" || typeof runtime.sessionId !== "string")
    throw new InvestigationExecutionError("invalid_runtime_result", false);
  const values = {
    runtimeRunId: runtime.runId,
    runtimeSessionId: runtime.sessionId,
    runtimeSessionKey: runtime.sessionKey,
    runtimeVersion: runtime.runtimeVersion,
    provider: runtime.provider,
    model: runtime.model,
  };
  const result: Partial<Record<keyof typeof values, string>> = {};
  for (const [field, value] of Object.entries(values)) {
    if (value === undefined) continue;
    const text = requireNonBlank(value, field, 512);
    if (text.includes(token))
      throw new InvestigationExecutionError("invalid_runtime_result", false);
    result[field as keyof typeof values] = text;
  }
  return Object.freeze(result);
}

function runtimeFailure(
  error: unknown,
  phase: "runtime" | "validation" | "persistence",
): InvestigationFailure {
  const known =
    error instanceof InvestigationExecutionError || error instanceof InvestigationRuntimeError;
  const code =
    error instanceof InvestigationExecutionError
      ? error.failureCode
      : error instanceof InvestigationRuntimeError
        ? error.code
        : error instanceof DomainInvariantError
          ? "invalid_runtime_result"
          : error instanceof ApplicationError
            ? "result_rejected"
            : phase === "runtime"
              ? "runtime_failure"
              : phase === "validation"
                ? "invalid_runtime_result"
                : "persistence_failure";
  return Object.freeze({
    code,
    retryable: known
      ? error.retryable
      : phase !== "validation" &&
        !(error instanceof DomainInvariantError || error instanceof ApplicationError),
    message: `Investigation execution failed (${code})`,
  });
}

function leaseLost(): ApplicationError {
  return new ApplicationError(
    "execution_lease_lost",
    "Investigation execution ownership changed",
    "executionAttemptId",
  );
}

/** Stop local waiting; aborting does not imply remote work stopped or settled its usage. */
async function runBounded(
  runtime: InvestigationRuntimePort,
  input: Omit<RunInvestigationInput, "signal">,
  signal?: AbortSignal,
): Promise<InvestigationRuntimeRun> {
  const controller = new AbortController();
  let rejectStop: ((error: Error) => void) | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    rejectStop = reject;
  });
  const stop = (code: string, retryable: boolean) => {
    rejectStop?.(new InvestigationExecutionError(code, retryable));
    controller.abort();
  };
  const onCancel = () => {
    const error = cancelled(signal);
    stop(error.failureCode, error.retryable);
  };
  const timer = setTimeout(() => {
    stop("runtime_timeout", true);
  }, input.timeoutMs);
  signal?.addEventListener("abort", onCancel, { once: true });
  try {
    if (signal?.aborted === true) {
      onCancel();
      return await stopped;
    }
    return await Promise.race([
      Promise.resolve().then(() =>
        controller.signal.aborted
          ? stopped
          : runtime.runInvestigation({ ...input, signal: controller.signal }),
      ),
      stopped,
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onCancel);
  }
}

function cancelled(signal: AbortSignal | undefined): InvestigationExecutionError {
  return new InvestigationExecutionError(
    signal?.reason === "shutdown" ? "runtime_shutdown" : "execution_cancelled",
    signal?.reason === "shutdown",
  );
}
