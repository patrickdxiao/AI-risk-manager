/** Embedded SQL ships with the emitted build; edits to an applied migration fail its checksum. */
export const migrations = [
  {
    name: "001-project-free-state",
    sql: `
CREATE TABLE sprints (
  id TEXT PRIMARY KEY NOT NULL,
  data TEXT NOT NULL CHECK(json_valid(data) AND json_extract(data, '$.id') = id),
  state TEXT GENERATED ALWAYS AS (json_extract(data, '$.state')) VIRTUAL NOT NULL,
  start_at TEXT GENERATED ALWAYS AS (json_extract(data, '$.startAt')) VIRTUAL NOT NULL
) STRICT;
CREATE UNIQUE INDEX one_active_sprint ON sprints(state) WHERE state = 'active';
CREATE INDEX sprint_order ON sprints(start_at DESC, id DESC);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY NOT NULL,
  data TEXT NOT NULL CHECK(json_valid(data) AND json_extract(data, '$.id') = id),
  sprint_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.sprintId')) VIRTUAL NOT NULL REFERENCES sprints(id),
  state TEXT GENERATED ALWAYS AS (json_extract(data, '$.state')) VIRTUAL NOT NULL,
  end_at TEXT GENERATED ALWAYS AS (json_extract(data, '$.endAt')) VIRTUAL NOT NULL,
  version INTEGER GENERATED ALWAYS AS (json_extract(data, '$.version')) VIRTUAL NOT NULL
) STRICT;
CREATE INDEX task_sprint ON tasks(sprint_id, end_at, id);
CREATE INDEX open_tasks ON tasks(end_at, id) WHERE state != 'done';
CREATE TABLE repositories (
  id TEXT PRIMARY KEY NOT NULL,
  data TEXT NOT NULL CHECK(json_valid(data) AND json_extract(data, '$.id') = id),
  canonical_path TEXT GENERATED ALWAYS AS (json_extract(data, '$.canonicalPath')) VIRTUAL NOT NULL UNIQUE
) STRICT;
CREATE TABLE repository_observations (
  id TEXT PRIMARY KEY NOT NULL REFERENCES repositories(id),
  data TEXT NOT NULL CHECK(json_valid(data) AND json_extract(data, '$.repositoryId') = id),
  observed_at TEXT GENERATED ALWAYS AS (json_extract(data, '$.observedAt')) VIRTUAL NOT NULL,
  snapshot_digest TEXT GENERATED ALWAYS AS (json_extract(data, '$.snapshot.snapshotDigest')) VIRTUAL NOT NULL,
  evaluated_digest TEXT GENERATED ALWAYS AS (json_extract(data, '$.evaluatedSnapshotDigest')) VIRTUAL
) STRICT;
CREATE INDEX pending_observations ON repository_observations(observed_at, id) WHERE evaluated_digest IS NULL;
CREATE TABLE evidence (
  id TEXT PRIMARY KEY NOT NULL,
  data TEXT NOT NULL CHECK(json_valid(data) AND json_extract(data, '$.id') = id),
  repository_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.repositoryId')) VIRTUAL REFERENCES repositories(id),
  sprint_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.sprintId')) VIRTUAL REFERENCES sprints(id),
  task_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.taskId')) VIRTUAL REFERENCES tasks(id),
  source TEXT GENERATED ALWAYS AS (json_extract(data, '$.source')) VIRTUAL NOT NULL,
  kind TEXT GENERATED ALWAYS AS (json_extract(data, '$.kind')) VIRTUAL NOT NULL,
  digest TEXT GENERATED ALWAYS AS (json_extract(data, '$.digest')) VIRTUAL NOT NULL,
  occurred_at TEXT GENERATED ALWAYS AS (json_extract(data, '$.occurredAt')) VIRTUAL NOT NULL
) STRICT;
CREATE UNIQUE INDEX evidence_identity ON evidence(coalesce(repository_id, ''), coalesce(sprint_id, ''), coalesce(task_id, ''), source, kind, digest);
CREATE INDEX evidence_time ON evidence(occurred_at DESC, id DESC);
CREATE INDEX evidence_repository ON evidence(repository_id, occurred_at DESC, id DESC);
CREATE INDEX evidence_sprint ON evidence(sprint_id, occurred_at DESC, id DESC);
CREATE INDEX evidence_task ON evidence(task_id, occurred_at DESC, id DESC);
CREATE TABLE investigations (
  id TEXT PRIMARY KEY NOT NULL,
  data TEXT NOT NULL CHECK(json_valid(data) AND json_extract(data, '$.id') = id),
  sprint_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.sprintId')) VIRTUAL NOT NULL REFERENCES sprints(id),
  task_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.taskId')) VIRTUAL REFERENCES tasks(id),
  trigger_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.triggerId')) VIRTUAL NOT NULL,
  status TEXT GENERATED ALWAYS AS (json_extract(data, '$.status')) VIRTUAL NOT NULL,
  requested_at TEXT GENERATED ALWAYS AS (json_extract(data, '$.requestedAt')) VIRTUAL NOT NULL,
  lease_until TEXT GENERATED ALWAYS AS (json_extract(data, '$.executionLeaseUntil')) VIRTUAL
) STRICT;
CREATE UNIQUE INDEX investigation_dedup ON investigations(sprint_id, coalesce(task_id, ''), trigger_id);
CREATE INDEX investigation_active ON investigations(lease_until) WHERE status = 'running';
CREATE INDEX investigation_recent ON investigations(sprint_id, requested_at DESC, id DESC);
CREATE TABLE investigation_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  data TEXT NOT NULL CHECK(json_valid(data) AND json_extract(data, '$.id') = id),
  investigation_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.investigationId')) VIRTUAL NOT NULL REFERENCES investigations(id),
  version INTEGER GENERATED ALWAYS AS (json_extract(data, '$.version')) VIRTUAL NOT NULL,
  started_at TEXT GENERATED ALWAYS AS (json_extract(data, '$.startedAt')) VIRTUAL NOT NULL,
  status TEXT GENERATED ALWAYS AS (json_extract(data, '$.status')) VIRTUAL NOT NULL,
  total_tokens INTEGER GENERATED ALWAYS AS (json_extract(data, '$.usage.totalTokens')) VIRTUAL,
  UNIQUE(investigation_id, version)
) STRICT;
CREATE INDEX attempt_time ON investigation_attempts(started_at, id);
CREATE INDEX attempt_unsettled ON investigation_attempts(started_at, id) WHERE status = 'running' OR total_tokens IS NULL;
CREATE TABLE investigation_results (
  id TEXT PRIMARY KEY NOT NULL REFERENCES investigations(id),
  data TEXT NOT NULL CHECK(json_valid(data) AND json_extract(data, '$.investigation.id') = id),
  sprint_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.investigation.sprintId')) VIRTUAL NOT NULL REFERENCES sprints(id),
  task_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.investigation.taskId')) VIRTUAL REFERENCES tasks(id),
  completed_at TEXT GENERATED ALWAYS AS (json_extract(data, '$.investigation.completedAt')) VIRTUAL NOT NULL
) STRICT;
CREATE INDEX result_scope ON investigation_results(sprint_id, task_id, completed_at DESC, id DESC);
CREATE TABLE findings (
  id TEXT PRIMARY KEY NOT NULL,
  data TEXT NOT NULL CHECK(json_valid(data) AND json_extract(data, '$.id') = id),
  investigation_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.investigationId')) VIRTUAL NOT NULL REFERENCES investigations(id),
  sprint_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.sprintId')) VIRTUAL NOT NULL REFERENCES sprints(id),
  task_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.taskId')) VIRTUAL REFERENCES tasks(id)
) STRICT;
CREATE TABLE finding_evidence (
  id TEXT PRIMARY KEY NOT NULL,
  data TEXT NOT NULL CHECK(json_valid(data)),
  finding_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.findingId')) VIRTUAL NOT NULL REFERENCES findings(id),
  evidence_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.evidenceId')) VIRTUAL NOT NULL REFERENCES evidence(id),
  UNIQUE(finding_id, evidence_id)
) STRICT;
CREATE TABLE finding_feedback (
  id TEXT PRIMARY KEY NOT NULL,
  data TEXT NOT NULL CHECK(json_valid(data) AND json_extract(data, '$.id') = id),
  finding_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.findingId')) VIRTUAL NOT NULL REFERENCES findings(id),
  kind TEXT GENERATED ALWAYS AS (json_extract(data, '$.kind')) VIRTUAL NOT NULL,
  created_at TEXT GENERATED ALWAYS AS (json_extract(data, '$.createdAt')) VIRTUAL NOT NULL
) STRICT;
CREATE INDEX feedback_finding ON finding_feedback(finding_id, created_at DESC, id DESC);
CREATE TABLE risk_snapshots (
  id TEXT PRIMARY KEY NOT NULL,
  data TEXT NOT NULL CHECK(json_valid(data) AND json_extract(data, '$.id') = id),
  sprint_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.sprintId')) VIRTUAL NOT NULL REFERENCES sprints(id),
  task_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.taskId')) VIRTUAL REFERENCES tasks(id),
  finding_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.findingId')) VIRTUAL REFERENCES findings(id),
  created_at TEXT GENERATED ALWAYS AS (json_extract(data, '$.createdAt')) VIRTUAL NOT NULL
) STRICT;
CREATE INDEX risk_scope ON risk_snapshots(sprint_id, task_id, created_at DESC, id DESC);
CREATE TABLE risk_transitions (
  id TEXT PRIMARY KEY NOT NULL,
  data TEXT NOT NULL CHECK(json_valid(data) AND json_extract(data, '$.id') = id),
  sprint_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.sprintId')) VIRTUAL NOT NULL REFERENCES sprints(id),
  task_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.taskId')) VIRTUAL REFERENCES tasks(id)
) STRICT;
CREATE TABLE trigger_queue (
  id TEXT PRIMARY KEY NOT NULL,
  data TEXT NOT NULL CHECK(json_valid(data) AND json_extract(data, '$.id') = id),
  type TEXT GENERATED ALWAYS AS (json_extract(data, '$.type')) VIRTUAL NOT NULL,
  sprint_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.sprintId')) VIRTUAL NOT NULL REFERENCES sprints(id),
  task_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.taskId')) VIRTUAL REFERENCES tasks(id),
  repository_ids TEXT GENERATED ALWAYS AS (json_extract(data, '$.repositoryIds')) VIRTUAL NOT NULL,
  dedup_key TEXT GENERATED ALWAYS AS (json_extract(data, '$.dedupKey')) VIRTUAL NOT NULL UNIQUE,
  observed_at TEXT GENERATED ALWAYS AS (json_extract(data, '$.observedAt')) VIRTUAL NOT NULL
) STRICT;
CREATE INDEX queue_cooldown ON trigger_queue(type, sprint_id, task_id, repository_ids, observed_at DESC, id DESC);
CREATE INDEX queue_sprint ON trigger_queue(sprint_id, observed_at, id);
CREATE TABLE trigger_dispatches (
  id TEXT PRIMARY KEY NOT NULL REFERENCES trigger_queue(id),
  data TEXT NOT NULL CHECK(json_valid(data) AND json_extract(data, '$.triggerId') = id),
  investigation_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.investigationId')) VIRTUAL REFERENCES investigations(id),
  status TEXT GENERATED ALWAYS AS (json_extract(data, '$.status')) VIRTUAL NOT NULL,
  lease_version INTEGER GENERATED ALWAYS AS (json_extract(data, '$.leaseVersion')) VIRTUAL NOT NULL,
  due_at TEXT GENERATED ALWAYS AS (json_extract(data, '$.dueAt')) VIRTUAL NOT NULL,
  lease_expires_at TEXT GENERATED ALWAYS AS (json_extract(data, '$.leaseExpiresAt')) VIRTUAL
) STRICT;
CREATE UNIQUE INDEX dispatch_investigation ON trigger_dispatches(investigation_id) WHERE investigation_id IS NOT NULL;
CREATE INDEX dispatch_due ON trigger_dispatches(due_at, id) WHERE status IN ('pending', 'retry_wait', 'leased');
${["evidence", "findings", "finding_evidence", "finding_feedback", "risk_snapshots", "risk_transitions", "investigation_results", "trigger_queue"].map((table) => ["UPDATE", "DELETE"].map((operation) => `CREATE TRIGGER immutable_${table}_${operation.toLowerCase()} BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT, 'immutable record'); END;`).join("\n")).join("\n")}
`,
  },
] as const;
