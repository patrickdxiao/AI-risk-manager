import {
  PlanningEntityAlreadyExistsError,
  RepositoryConflictError,
  type PlanningStore,
  type RepositoryStore,
  type RepositoryObservationStore,
} from "../../core/storageContracts.js";
import { canonical, invariant } from "./validation.js";
import { type Records, limit } from "./records.js";
import * as codec from "./codecs.js";

export function planningStore(db: Records): PlanningStore {
  return {
    async listSprints() {
      return db.all(codec.sprint, "SELECT data FROM sprints ORDER BY start_at DESC, id DESC");
    },
    async findOpenTasks() {
      return db.all(codec.task, "SELECT data FROM tasks WHERE state != 'done' ORDER BY end_at, id");
    },
    async countOpenTasks() {
      return db.count("SELECT count(*) AS count FROM tasks WHERE state != 'done'");
    },
    async findActiveSprint() {
      return db.one(codec.sprint, "SELECT data FROM sprints WHERE state = 'active'");
    },
    async findSprintById(id) {
      return db.get("sprints", id, codec.sprint);
    },
    async findTaskById(id) {
      return db.get("tasks", id, codec.task);
    },
    async findTasksBySprintId(id) {
      return db.all(
        codec.task,
        "SELECT data FROM tasks WHERE sprint_id = ? ORDER BY end_at, id",
        id,
      );
    },
    async addSprint(value) {
      if (db.get("sprints", value.id, codec.sprint) !== undefined)
        throw new PlanningEntityAlreadyExistsError("sprint", value.id);
      db.add("sprints", value.id, value, codec.sprint);
    },
    async addTask(value) {
      if (db.get("tasks", value.id, codec.task) !== undefined)
        throw new PlanningEntityAlreadyExistsError("task", value.id);
      db.add("tasks", value.id, value, codec.task);
    },
    async saveSprint(value) {
      db.update("sprints", value.id, value, codec.sprint);
    },
    async saveTask(value) {
      const validated = codec.task(value);
      invariant(
        db.run(
          "UPDATE tasks SET data = ? WHERE id = ? AND version = ?",
          canonical(validated),
          value.id,
          value.version - 1,
        ) === 1,
        "Task version is stale or task is missing",
      );
    },
  };
}

export function repositoryStore(db: Records): RepositoryStore {
  return {
    async list() {
      return db.all(codec.repository, "SELECT data FROM repositories ORDER BY id");
    },
    async findById(id) {
      return db.get("repositories", id, codec.repository);
    },
    async add(value) {
      const validated = codec.repository(value);
      if (db.get("repositories", value.id, codec.repository) !== undefined)
        throw new RepositoryConflictError("id", value.id);
      if (
        db.one(
          codec.repository,
          "SELECT data FROM repositories WHERE canonical_path = ?",
          validated.canonicalPath,
        ) !== undefined
      )
        throw new RepositoryConflictError("canonical_path", validated.canonicalPath);
      db.add("repositories", value.id, validated, codec.repository);
    },
  };
}

export function observationStore(db: Records): RepositoryObservationStore {
  return {
    async findByRepositoryId(id) {
      return db.get("repository_observations", id, codec.observation);
    },
    async save(value) {
      const validated = codec.observation(value);
      const previous = db.get("repository_observations", value.repositoryId, codec.observation);
      if (previous === undefined)
        db.add("repository_observations", value.repositoryId, validated, codec.observation);
      else {
        invariant(
          canonical(previous) === canonical(validated) ||
            (previous.evaluatedSnapshotDigest === previous.snapshot.snapshotDigest &&
              value.observedAt > previous.observedAt),
          "Pending observations must be acknowledged before replacement",
        );
        db.update("repository_observations", value.repositoryId, validated, codec.observation);
      }
    },
    async listPendingEvaluation(count) {
      return db.all(
        codec.observation,
        "SELECT data FROM repository_observations WHERE evaluated_digest IS NULL ORDER BY observed_at, id LIMIT ?",
        limit(count),
      );
    },
    async markEvaluated(id, digest, observedAt) {
      return (
        db.run(
          "UPDATE repository_observations SET data = json_set(data, '$.evaluatedSnapshotDigest', ?) WHERE id = ? AND snapshot_digest = ? AND observed_at = ?",
          digest,
          id,
          digest,
          observedAt,
        ) === 1
      );
    },
  };
}
