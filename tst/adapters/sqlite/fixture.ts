import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import {
  openSQLiteDatabase,
  createSQLiteUnitOfWork,
  type SQLiteDatabaseHandle,
} from "../../../src/adapters/sqlite/sqliteDatabase.js";
import { before, now, sprint, task, repository, evidence } from "../../fixtures/riskFixture.js";
import {
  createInvestigation,
  startInvestigation,
  type InvestigationAttempt,
} from "../../../src/core/investigation/investigationModel.js";
import type { RepositoryObservation } from "../../../src/core/repository/repositoryModel.js";
import type { TriggerQueueRecord } from "../../../src/core/triggers/triggerModel.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const action of cleanup.splice(0).reverse()) action();
});

export function temporaryDirectory() {
  const path = mkdtempSync(join(tmpdir(), "risk-sqlite-test-"));
  cleanup.push(() => {
    rmSync(path, { recursive: true, force: true });
  });
  return path;
}
export function database(path = join(temporaryDirectory(), "state.sqlite")) {
  const handle: SQLiteDatabaseHandle = openSQLiteDatabase({ path });
  cleanup.push(() => {
    if (handle.raw.isOpen) handle.close();
  });
  return { ...handle, path, store: createSQLiteUnitOfWork(handle.raw) };
}
export async function seeded() {
  const db = database();
  await db.store.execute(async (tx) => {
    await tx.planning.addSprint(sprint("sprint", { reviewCadenceMinutes: 180 }));
    await tx.planning.addTask(task());
    await tx.repositories.add(repository);
    await tx.evidence.add(evidence);
  });
  return db;
}
export function investigation(id = "investigation", taskId?: string) {
  return startInvestigation(
    createInvestigation({
      id,
      sprintId: "sprint",
      ...(taskId === undefined ? {} : { taskId }),
      triggerId: `trigger-${id}`,
      requestedAt: before,
    }),
    now,
  );
}
export function attempt(overrides: Partial<InvestigationAttempt> = {}): InvestigationAttempt {
  return {
    id: "investigation:attempt:1",
    investigationId: "investigation",
    version: 1,
    status: "running",
    startedAt: now,
    leaseUntil: "2026-09-24T02:01:00.000Z",
    timeoutMs: 60_000,
    queueWaitMs: 100,
    promptVersion: "1",
    resultSchemaVersion: "1",
    authority: {
      credentialHash: "a".repeat(64),
      repositoryIds: [repository.id],
      planningDigest: "plan",
      toolCalls: 0,
      reservedTokens: 20_000,
    },
    ...overrides,
  };
}
export function observation(overrides: Partial<RepositoryObservation> = {}): RepositoryObservation {
  return {
    repositoryId: repository.id,
    observedAt: now,
    evidenceIds: [evidence.id],
    snapshot: {
      rootPath: repository.canonicalPath,
      head: "head",
      branch: "main",
      detached: false,
      snapshotDigest: "snapshot",
      status: {
        clean: true,
        stagedCount: 0,
        unstagedCount: 0,
        untrackedCount: 0,
        totalPathCount: 0,
        paths: [],
        pathsTruncated: false,
      },
    },
    ...overrides,
  };
}
export function trigger(
  id = "trigger",
  overrides: Partial<TriggerQueueRecord> = {},
): TriggerQueueRecord {
  return {
    version: "trigger-queue-record.v1",
    id,
    type: "manual_review",
    sprintId: "sprint",
    repositoryIds: [repository.id],
    dedupKey: `dedup-${id}`,
    reason: "Review now",
    inputSummary: {},
    evidenceDigests: [],
    evidenceCitations: [],
    observedAt: now,
    cooldownUntil: now,
    ...overrides,
  };
}
