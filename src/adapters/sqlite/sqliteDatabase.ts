import {
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  rmSync,
  type Stats,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import type { TransactionContext, UnitOfWorkPort } from "../../core/storageContracts.js";
import { Records } from "./records.js";
import { planningStore, repositoryStore, observationStore } from "./planningStore.js";
import { evidenceStore } from "./evidenceStore.js";
import { investigationStore } from "./investigationStore.js";
import { findingStore, feedbackStore, riskStore } from "./findingStore.js";
import { queueStore, dispatchStore } from "./triggerStore.js";
import { migrations } from "./migrations.js";

export interface OpenSQLiteDatabaseOptions {
  readonly path: string;
}

export interface SQLiteDatabaseHandle {
  readonly raw: DatabaseSync;
  close(): void;
}

/** Reports unsafe or inconsistent local database files. */
export class SQLiteStateError extends Error {
  override readonly name = "SQLiteStateError";

  constructor(
    readonly code:
      | "database_file_not_regular"
      | "database_changed"
      | "database_invalid"
      | "database_unsupported",
  ) {
    super(
      code === "database_unsupported"
        ? "Unsupported prototype migration journal; use a new state directory"
        : "Local database state could not be safely opened",
    );
  }
}

const SQLITE_FILE_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;

/** Rejects nonregular, symbolic, or hard-linked database and journal files. */
export function inspectSQLiteFiles(path: string): Map<string, Stats> {
  const files = new Map<string, Stats>();
  for (const suffix of SQLITE_FILE_SUFFIXES) {
    const filename = path + suffix;
    let stats: Stats;
    try {
      stats = lstatSync(filename);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
      throw new SQLiteStateError("database_file_not_regular");
    }
    files.set(suffix, stats);
  }
  return files;
}

/** Inspect saved registration before migrations, recovery, or credential publication. */
export function readSQLiteRepositoryPaths(path: string): readonly string[] {
  if (path === ":memory:") return [];
  const databasePath = resolve(path);
  const before = inspectSQLiteFiles(databasePath);
  if (!before.has("")) return [];
  const temporary = mkdtempSync(join(tmpdir(), "development-risk-state-check-"));
  let raw: DatabaseSync | undefined;
  try {
    const snapshotPath = join(temporary, "state.sqlite");
    // Even a read-only SQLite connection can create WAL/SHM files. Inspect a private
    // snapshot, retaining an uncheckpointed WAL, so rejected state remains untouched.
    for (const suffix of ["", "-wal", "-journal"]) {
      if (before.has(suffix)) {
        copyFileSync(databasePath + suffix, snapshotPath + suffix, constants.COPYFILE_FICLONE);
      }
    }
    const after = inspectSQLiteFiles(databasePath);
    for (const suffix of SQLITE_FILE_SUFFIXES) {
      const original = before.get(suffix);
      const current = after.get(suffix);
      if (
        original?.dev !== current?.dev ||
        original?.ino !== current?.ino ||
        original?.size !== current?.size ||
        original?.mtimeMs !== current?.mtimeMs ||
        original?.ctimeMs !== current?.ctimeMs
      ) {
        throw new SQLiteStateError("database_changed");
      }
    }
    raw = new DatabaseSync(snapshotPath, { readOnly: true });
    if (
      raw
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'repositories'")
        .get() === undefined
    ) {
      return [];
    }
    return raw
      .prepare("SELECT canonical_path FROM repositories")
      .all()
      .map((row) => {
        const root = row["canonical_path"];
        if (typeof root !== "string" || !isAbsolute(root)) {
          throw new SQLiteStateError("database_invalid");
        }
        return root;
      });
  } finally {
    try {
      raw?.close();
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
}

/** Opens local state with foreign keys, WAL, and checked migrations.
 * @param options - Database path; migrations are bundled with the adapter.
 * @throws SQLiteStateError when a database file could reference unrelated data. */
export function openSQLiteDatabase(options: OpenSQLiteDatabaseOptions): SQLiteDatabaseHandle {
  const path = options.path === ":memory:" ? options.path : resolve(options.path);
  if (path !== ":memory:") {
    const files = inspectSQLiteFiles(path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (!files.has("")) {
      // Exclusive creation cannot follow an already present link and keeps local state private.
      closeSync(openSync(path, "wx", 0o600));
    }
    inspectSQLiteFiles(path);
  }
  const raw = new DatabaseSync(path);
  try {
    if (raw.prepare("SELECT 1 FROM sqlite_master WHERE name = '__drizzle_migrations'").get()) {
      throw new SQLiteStateError("database_unsupported");
    }
    raw.exec("PRAGMA foreign_keys = ON");
    raw.exec("PRAGMA journal_mode = WAL");
    raw.exec("PRAGMA busy_timeout = 5000");
    applyMigrations(raw);
    return Object.freeze({
      raw,
      close: () => {
        raw.close();
      },
    });
  } catch (error) {
    raw.close();
    throw error;
  }
}

/** Checks recorded checksums and applies pending migrations in one transaction. */
function applyMigrations(raw: DatabaseSync): void {
  const checked = migrations.map((migration) => ({
    ...migration,
    hash: createHash("sha256").update(migration.sql).digest("hex"),
  }));
  raw.exec("BEGIN IMMEDIATE");
  try {
    raw.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, hash TEXT NOT NULL) STRICT",
    );
    const applied = raw.prepare("SELECT name, hash FROM schema_migrations ORDER BY name").all();
    for (const [index, row] of applied.entries()) {
      const migration = checked[index];
      if (
        migration === undefined ||
        row["hash"] !== migration.hash ||
        row["name"] !== migration.name
      ) {
        throw new Error("Database migration history does not match this build");
      }
    }
    const record = raw.prepare("INSERT INTO schema_migrations (name, hash) VALUES (?, ?)");
    for (const migration of checked.slice(applied.length)) {
      raw.exec(migration.sql);
      record.run(migration.name, migration.hash);
    }
    raw.exec("COMMIT");
  } catch (error) {
    raw.exec("ROLLBACK");
    throw error;
  }
}

interface TransactionQueue {
  tail: Promise<void>;
}
const fileQueues = new Map<string, TransactionQueue>();
const memoryQueues = new WeakMap<DatabaseSync, TransactionQueue>();

/** Connections to the same local file share the callback queue, avoiding event-loop lock waits. */
function queueFor(raw: DatabaseSync): TransactionQueue {
  const path = raw.location();
  const existing = path === null ? memoryQueues.get(raw) : fileQueues.get(path);
  if (existing !== undefined) return existing;
  const queue = { tail: Promise.resolve() };
  if (path === null) memoryQueues.set(raw, queue);
  else fileQueues.set(path, queue);
  return queue;
}

export class SqliteUnitOfWork implements UnitOfWorkPort {
  private readonly queue: TransactionQueue;
  constructor(private readonly raw: DatabaseSync) {
    this.queue = queueFor(raw);
  }

  execute<T>(work: (context: TransactionContext) => Promise<T>): Promise<T> {
    const operation = this.queue.tail.then(() => this.transaction(work));
    this.queue.tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async transaction<T>(work: (context: TransactionContext) => Promise<T>): Promise<T> {
    this.raw.exec("BEGIN IMMEDIATE");
    let active = true;
    const records = new Records(this.raw, () => {
      if (!active) throw new Error("Transaction context is no longer active");
    });
    const context: TransactionContext = Object.freeze({
      planning: planningStore(records),
      repositories: repositoryStore(records),
      repositoryObservations: observationStore(records),
      evidence: evidenceStore(records),
      investigations: investigationStore(records),
      findings: findingStore(records),
      findingFeedback: feedbackStore(records),
      risks: riskStore(records),
      triggerQueue: queueStore(records),
      triggerDispatches: dispatchStore(records),
    });
    try {
      const result = await work(context);
      this.raw.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.raw.exec("ROLLBACK");
      } catch {
        /* Preserve the original failure. */
      }
      throw error;
    } finally {
      active = false;
    }
  }
}

export const createSQLiteUnitOfWork = (raw: DatabaseSync): UnitOfWorkPort =>
  new SqliteUnitOfWork(raw);
