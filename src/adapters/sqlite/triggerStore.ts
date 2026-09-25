import type { TriggerDispatchStore, TriggerQueueStore } from "../../core/triggers/triggerModel.js";
import { canonical, invariant } from "./validation.js";
import { limit, type Records } from "./records.js";
import * as codec from "./codecs.js";

export function queueStore(db: Records): TriggerQueueStore {
  return {
    async findById(id) {
      return db.get("trigger_queue", id, codec.queue);
    },
    async findByDedupKey(key) {
      return db.one(codec.queue, "SELECT data FROM trigger_queue WHERE dedup_key = ?", key);
    },
    async findLatestByCooldownScope(scope) {
      return db.one(
        codec.queue,
        "SELECT data FROM trigger_queue WHERE type = ? AND sprint_id = ? AND task_id IS ? AND repository_ids = ? ORDER BY observed_at DESC, id DESC LIMIT 1",
        scope.type,
        scope.sprintId,
        scope.taskId ?? null,
        JSON.stringify([...new Set(scope.repositoryIds)].sort()),
      );
    },
    async listPendingBySprintId(sprintId, count) {
      return db.all(
        codec.queue,
        "SELECT q.data FROM trigger_queue q JOIN trigger_dispatches d ON d.id = q.id WHERE q.sprint_id = ? AND d.status IN ('pending', 'leased', 'retry_wait') ORDER BY q.observed_at, q.id LIMIT ?",
        sprintId,
        limit(count),
      );
    },
    async add(value) {
      db.add("trigger_queue", value.id, value, codec.queue);
    },
  };
}
export function dispatchStore(db: Records): TriggerDispatchStore {
  return {
    async countPending() {
      return db.count(
        "SELECT count(*) AS count FROM trigger_dispatches WHERE status IN ('pending', 'leased', 'retry_wait')",
      );
    },
    async findByTriggerId(id) {
      return db.get("trigger_dispatches", id, codec.dispatch);
    },
    async findByInvestigationId(id) {
      return db.one(
        codec.dispatch,
        "SELECT data FROM trigger_dispatches WHERE investigation_id = ?",
        id,
      );
    },
    async findNextDue(now) {
      return db.one(
        codec.dispatch,
        "SELECT data FROM trigger_dispatches WHERE (status IN ('pending', 'retry_wait') AND due_at <= ?) OR (status = 'leased' AND lease_expires_at <= ?) ORDER BY due_at, id LIMIT 1",
        now,
        now,
      );
    },
    async add(value) {
      db.add("trigger_dispatches", value.triggerId, value, codec.dispatch);
    },
    async saveFenced(value, version, status) {
      const next = codec.dispatch(value);
      const previous = db.get("trigger_dispatches", value.triggerId, codec.dispatch);
      if (previous?.leaseVersion !== version || previous.status !== status) return false;
      invariant(
        previous.createdAt === next.createdAt && next.leaseVersion >= previous.leaseVersion,
        "Dispatch identity cannot change",
      );
      invariant(
        previous.investigationId === undefined || previous.investigationId === next.investigationId,
        "Dispatch investigation cannot change",
      );
      invariant(
        previous.status !== "completed" && previous.status !== "dead",
        "Terminal dispatch is immutable",
      );
      return (
        db.run(
          "UPDATE trigger_dispatches SET data = ? WHERE id = ? AND lease_version = ? AND status = ?",
          canonical(next),
          value.triggerId,
          version,
          status,
        ) === 1
      );
    },
  };
}
