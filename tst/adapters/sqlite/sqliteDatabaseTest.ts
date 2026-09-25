import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import {
  createSQLiteUnitOfWork,
  openSQLiteDatabase,
  readSQLiteRepositoryPaths,
} from "../../../src/adapters/sqlite/sqliteDatabase.js";
import { sprint, repository } from "../../fixtures/riskFixture.js";
import { database, seeded, temporaryDirectory } from "./fixture.js";

describe("durable SQLite transaction boundary", () => {
  it("rolls back every write and allows a queued transaction to proceed after failure", async () => {
    const db = database();
    const error = new Error("failed callback");
    const failed = db.store.execute(async (tx) => {
      await tx.planning.addSprint(sprint());
      await tx.repositories.add(repository);
      throw error;
    });
    const next = db.store.execute(async (tx) => {
      expect(await tx.planning.findSprintById("sprint")).toBeUndefined();
      expect(await tx.repositories.list()).toEqual([]);
      await tx.planning.addSprint(sprint());
    });
    await expect(failed).rejects.toBe(error);
    await next;
    expect(await db.store.execute((tx) => tx.planning.listSprints())).toHaveLength(1);
  });

  it("serializes awaited admission reads across UOWs and connections to one file", async () => {
    const first = database();
    const second = database(first.path);
    const sameConnection = createSQLiteUnitOfWork(first.raw);
    const order: string[] = [];
    const gate = deferred();
    const started = deferred();
    const write = first.store.execute(async (tx) => {
      order.push("started");
      started.resolve();
      await gate.promise;
      await tx.planning.addSprint(sprint());
      order.push("committed");
    });
    await started.promise;
    const read = second.store.execute(async (tx) => {
      expect(await tx.planning.findActiveSprint()).toMatchObject({ id: "sprint" });
      order.push("second");
    });
    const third = sameConnection.execute(async (tx) => {
      expect(await tx.planning.listSprints()).toHaveLength(1);
      order.push("third");
    });
    await Promise.resolve();
    expect(order).toEqual(["started"]);
    gate.resolve();
    await Promise.all([write, read, third]);
    expect(order).toEqual(["started", "committed", "second", "third"]);
  });

  it("expires leaked transaction contexts and detaches immutable returned values", async () => {
    const db = await seeded();
    const tx = await db.store.execute((context) => Promise.resolve(context));
    await expect(tx.planning.findActiveSprint()).rejects.toThrow("no longer active");
    const value = await db.store.execute((context) => context.planning.findTaskById("task"));
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value?.dependencyIds)).toBe(true);
  });

  it("reopens committed state with WAL, foreign keys, a busy timeout and checked migrations", async () => {
    const db = await seeded();
    expect(db.raw.prepare("PRAGMA journal_mode").get()?.["journal_mode"]).toBe("wal");
    expect(db.raw.prepare("PRAGMA foreign_keys").get()?.["foreign_keys"]).toBe(1);
    expect(db.raw.prepare("PRAGMA busy_timeout").get()?.["timeout"]).toBe(5_000);
    expect(lstatSync(db.path).mode & 0o777).toBe(0o600);
    db.close();
    const reopened = database(db.path);
    expect(await reopened.store.execute((tx) => tx.evidence.findById("evidence"))).toMatchObject({
      id: "evidence",
    });
    expect(
      reopened.raw.prepare("SELECT count(*) AS count FROM schema_migrations").get()?.["count"],
    ).toBe(1);
    reopened.raw.exec("UPDATE schema_migrations SET hash = 'modified'");
    reopened.close();
    expect(() => openSQLiteDatabase({ path: db.path })).toThrow("migration history");
  });

  it("rejects incomplete or unknown migration history rather than creating a second schema", () => {
    for (const sql of [
      "INSERT INTO schema_migrations VALUES ('999-unknown', 'bad')",
      "UPDATE schema_migrations SET name = '001-other'",
    ]) {
      const db = database();
      db.raw.exec(sql);
      db.close();
      expect(() => openSQLiteDatabase({ path: db.path })).toThrow("migration history");
    }
    const path = join(temporaryDirectory(), "legacy.sqlite");
    const raw = new DatabaseSync(path);
    raw.exec("CREATE TABLE __drizzle_migrations(id INTEGER)");
    raw.close();
    expect(() => openSQLiteDatabase({ path })).toThrow("Unsupported prototype");
  });

  it("keeps independent in-memory connections separate and serializes UOWs sharing one", async () => {
    const db = database(":memory:");
    const other = database(":memory:");
    const same = createSQLiteUnitOfWork(db.raw);
    await db.store.execute((tx) => tx.planning.addSprint(sprint()));
    expect(await same.execute((tx) => tx.planning.listSprints())).toHaveLength(1);
    expect(await other.store.execute((tx) => tx.planning.listSprints())).toEqual([]);
  });
});

describe("SQLite file safety and pre-open registration inspection", () => {
  it("rejects symbolic and hard links, directories, and linked sidecars without changing targets", () => {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      const directory = temporaryDirectory();
      const path = join(directory, "state.sqlite");
      const target = join(directory, "unrelated");
      writeFileSync(target, "preserve");
      symlinkSync(target, path + suffix);
      expect(() => openSQLiteDatabase({ path })).toThrow("safely opened");
      expect(() => readSQLiteRepositoryPaths(path)).toThrow("safely opened");
      expect(readFileSync(target, "utf8")).toBe("preserve");
    }
    const directory = temporaryDirectory();
    const path = join(directory, "state.sqlite");
    writeFileSync(path, "preserve");
    linkSync(path, join(directory, "other"));
    expect(() => openSQLiteDatabase({ path })).toThrow("safely opened");
    const folder = join(directory, "folder");
    mkdirSync(folder);
    expect(() => openSQLiteDatabase({ path: folder })).toThrow("safely opened");
  });

  it("reads registrations from a private WAL snapshot without writing original state", async () => {
    const db = await seeded();
    db.raw.exec("PRAGMA wal_autocheckpoint = 0");
    const before = readdirSync(join(db.path, "..")).map((name) => [
      name,
      readFileSync(join(db.path, "..", name)),
    ]);
    expect(readSQLiteRepositoryPaths(db.path)).toEqual([repository.canonicalPath]);
    const after = readdirSync(join(db.path, "..")).map((name) => [
      name,
      readFileSync(join(db.path, "..", name)),
    ]);
    expect(after).toEqual(before);
    expect(readSQLiteRepositoryPaths(":memory:")).toEqual([]);
    expect(readSQLiteRepositoryPaths(join(temporaryDirectory(), "missing.sqlite"))).toEqual([]);
  });

  it("handles an empty database and rejects invalid persisted repository paths", () => {
    const path = join(temporaryDirectory(), "state.sqlite");
    const raw = new DatabaseSync(path);
    raw.exec("CREATE TABLE unrelated (id INTEGER)");
    expect(readSQLiteRepositoryPaths(path)).toEqual([]);
    raw.exec(
      "CREATE TABLE repositories(canonical_path TEXT); INSERT INTO repositories VALUES ('relative')",
    );
    expect(() => readSQLiteRepositoryPaths(path)).toThrow("safely opened");
    raw.close();
  });
});

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
