import type { SQLInputValue } from "node:sqlite";
import type { EvidenceStore } from "../../core/storageContracts.js";
import * as codec from "./codecs.js";
import { limit, type Records } from "./records.js";

export function evidenceStore(db: Records): EvidenceStore {
  return {
    async findById(id) {
      return db.get("evidence", id, codec.evidence);
    },
    async findByIdentity(value) {
      return db.one(
        codec.evidence,
        "SELECT data FROM evidence WHERE coalesce(repository_id, '') = ? AND coalesce(sprint_id, '') = ? AND coalesce(task_id, '') = ? AND source = ? AND kind = ? AND digest = ?",
        value.repositoryId ?? "",
        value.sprintId ?? "",
        value.taskId ?? "",
        value.source,
        value.kind,
        value.digest,
      );
    },
    async findScoped(query) {
      const clauses: string[] = [];
      const args: SQLInputValue[] = [];
      for (const [column, value] of [
        ["repository_id", query.repositoryId],
        ["sprint_id", query.sprintId],
        ["task_id", query.taskId],
        ["source", query.source],
      ] as const) {
        if (value === undefined) continue;
        clauses.push(`${column} IS ?`);
        args.push(value);
      }
      for (const [operator, value] of [
        [">=", query.occurredSince],
        ["<=", query.occurredThrough],
      ] as const) {
        if (value === undefined) continue;
        clauses.push(`occurred_at ${operator} ?`);
        args.push(value);
      }
      const count = limit(query.limit);
      if (query.kinds !== undefined) {
        if (query.kinds.length === 0) return [];
        clauses.push(`kind IN (${query.kinds.map(() => "?").join(",")})`);
        args.push(...query.kinds);
      }
      return db.all(
        codec.evidence,
        `SELECT data FROM evidence ${clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`} ORDER BY occurred_at DESC, id DESC LIMIT ?`,
        ...args,
        count,
      );
    },
    async add(value) {
      db.add("evidence", value.id, value, codec.evidence);
    },
  };
}
