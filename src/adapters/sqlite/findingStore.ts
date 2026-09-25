import type { FindingFeedbackStore, FindingStore, RiskStore } from "../../core/storageContracts.js";
import { limit, type Records } from "./records.js";
import * as codec from "./codecs.js";

export function findingStore(db: Records): FindingStore {
  return {
    async findById(id) {
      return db.get("findings", id, codec.finding);
    },
    async findEvidenceByFindingId(id) {
      return db.all(
        codec.citation,
        "SELECT data FROM finding_evidence WHERE finding_id = ? ORDER BY evidence_id",
        id,
      );
    },
    async add(value) {
      db.add("findings", value.id, value, codec.finding);
    },
    async addEvidence(value) {
      db.add(
        "finding_evidence",
        JSON.stringify([value.findingId, value.evidenceId]),
        value,
        codec.citation,
      );
    },
  };
}
export function feedbackStore(db: Records): FindingFeedbackStore {
  return {
    async findById(id) {
      return db.get("finding_feedback", id, codec.feedback);
    },
    async findByFindingId(id, count) {
      return db.all(
        codec.feedback,
        "SELECT data FROM finding_feedback WHERE finding_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
        id,
        limit(count),
      );
    },
    async findCurrentByFindingId(id) {
      return db.all(
        codec.feedback,
        `SELECT data FROM (
        SELECT data, created_at, id, row_number() OVER (PARTITION BY kind = 'correct' ORDER BY created_at DESC, id DESC) AS position
        FROM finding_feedback WHERE finding_id = ?
      ) WHERE position = 1 ORDER BY created_at DESC, id DESC`,
        id,
      );
    },
    async add(value) {
      db.add("finding_feedback", value.id, value, codec.feedback);
    },
  };
}
export function riskStore(db: Records): RiskStore {
  return {
    async findLatestSnapshot(sprintId, taskId) {
      return db.one(
        codec.riskSnapshot,
        "SELECT data FROM risk_snapshots WHERE sprint_id = ? AND task_id IS ? ORDER BY created_at DESC, id DESC LIMIT 1",
        sprintId,
        taskId ?? null,
      );
    },
    async addSnapshot(value) {
      db.add("risk_snapshots", value.id, value, codec.riskSnapshot);
    },
    async addTransition(value) {
      db.add("risk_transitions", value.id, value, codec.riskTransition);
    },
  };
}
