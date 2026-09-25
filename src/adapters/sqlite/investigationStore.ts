import {
  claimInvestigationExecution,
  type InvestigationAttempt,
} from "../../core/investigation/investigationModel.js";
import type { InvestigationStore } from "../../core/storageContracts.js";
import { canonical, invariant } from "./validation.js";
import { limit, type Records } from "./records.js";
import * as codec from "./codecs.js";

export function investigationStore(db: Records): InvestigationStore {
  const active = (now: string) =>
    db.one(
      codec.investigation,
      "SELECT data FROM investigations WHERE status = 'running' AND lease_until > ? ORDER BY lease_until, id LIMIT 1",
      now,
    );
  return {
    async listAttemptsSince(since) {
      return db.all(
        codec.attempt,
        "SELECT data FROM investigation_attempts WHERE started_at >= ? ORDER BY started_at, id",
        since,
      );
    },
    async listUnsettledAttempts() {
      return db.all(
        codec.attempt,
        "SELECT data FROM investigation_attempts WHERE status = 'running' OR total_tokens IS NULL ORDER BY started_at, id",
      );
    },
    async findRecentBySprintId(sprintId, now, count) {
      return db
        .all(
          codec.investigation,
          "SELECT data FROM investigations WHERE sprint_id = ? AND requested_at <= ? ORDER BY requested_at DESC, id DESC LIMIT ?",
          sprintId,
          now,
          limit(count),
        )
        .map((investigation) => {
          const latestAttempt = db.one(
            codec.attempt,
            "SELECT data FROM investigation_attempts WHERE investigation_id = ? ORDER BY version DESC LIMIT 1",
            investigation.id,
          );
          return Object.freeze({
            investigation,
            ...(latestAttempt === undefined ? {} : { latestAttempt }),
          });
        });
    },
    async findActive(now) {
      return active(now);
    },
    async findAttemptById(id) {
      return db.get("investigation_attempts", id, codec.attempt);
    },
    async findAttempts(id) {
      return db.all(
        codec.attempt,
        "SELECT data FROM investigation_attempts WHERE investigation_id = ? ORDER BY version",
        id,
      );
    },
    async saveAttempt(value) {
      const next = codec.attempt(value);
      const previous = db.get("investigation_attempts", value.id, codec.attempt);
      if (previous === undefined) {
        db.add("investigation_attempts", value.id, next, codec.attempt);
        return;
      }
      invariant(
        canonical(attemptIdentity(previous)) === canonical(attemptIdentity(next)),
        "Attempt identity and authority are immutable",
      );
      invariant(
        (next.authority?.toolCalls ?? 0) >= (previous.authority?.toolCalls ?? 0),
        "Attempt read usage cannot decrease",
      );
      invariant(
        previous.status === "running" || next.status === previous.status,
        "A terminal attempt cannot restart",
      );
      db.update("investigation_attempts", value.id, next, codec.attempt);
    },
    async findLatestSubmittedResult(sprintId, taskId) {
      return db.one(
        codec.receipt,
        "SELECT data FROM investigation_results WHERE sprint_id = ? AND task_id IS ? ORDER BY completed_at DESC, id DESC LIMIT 1",
        sprintId,
        taskId ?? null,
      );
    },
    async findByDedupKey(value) {
      return db.one(
        codec.investigation,
        "SELECT data FROM investigations WHERE sprint_id = ? AND coalesce(task_id, '') = ? AND trigger_id = ?",
        value.sprintId,
        value.taskId ?? "",
        value.triggerId,
      );
    },
    async findById(id) {
      return db.get("investigations", id, codec.investigation);
    },
    async claimExecution(id, now, leaseUntil) {
      if (active(now) !== undefined) return undefined;
      const previous = db.get("investigations", id, codec.investigation);
      if (previous?.status !== "running") return undefined;
      const claimed = claimInvestigationExecution(previous, { now, leaseUntil });
      db.update("investigations", id, claimed, codec.investigation);
      return claimed;
    },
    async findSubmittedResult(id) {
      return db.get("investigation_results", id, codec.receipt);
    },
    async add(value) {
      db.add("investigations", value.id, value, codec.investigation);
    },
    async save(value) {
      const previous = db.get("investigations", value.id, codec.investigation);
      invariant(previous !== undefined, "Cannot update a missing investigation");
      for (const field of ["sprintId", "taskId", "triggerId", "requestedAt"] as const)
        invariant(previous[field] === value[field], "Investigation scope is immutable");
      invariant(
        (value.executionVersion ?? 0) >= (previous.executionVersion ?? 0),
        "Execution version cannot decrease",
      );
      invariant(
        previous.status !== "completed" || canonical(value) === canonical(previous),
        "Accepted investigation is immutable",
      );
      db.update("investigations", value.id, value, codec.investigation);
    },
    async saveSubmittedResult(value) {
      invariant(
        canonical(db.get("investigations", value.investigation.id, codec.investigation)) ===
          canonical(value.investigation),
        "Receipt must match the saved completed investigation",
      );
      db.add("investigation_results", value.investigation.id, value, codec.receipt);
    },
  };
}

function attemptIdentity(value: InvestigationAttempt) {
  return {
    id: value.id,
    investigationId: value.investigationId,
    version: value.version,
    startedAt: value.startedAt,
    leaseUntil: value.leaseUntil,
    timeoutMs: value.timeoutMs,
    dispatchTriggerId: value.dispatchTriggerId,
    dispatchLeaseVersion: value.dispatchLeaseVersion,
    queueWaitMs: value.queueWaitMs,
    ...(value.authority === undefined
      ? {}
      : {
          authority: {
            credentialHash: value.authority.credentialHash,
            repositoryIds: value.authority.repositoryIds,
            planningDigest: value.authority.planningDigest,
            reservedTokens: value.authority.reservedTokens,
          },
        }),
  };
}
