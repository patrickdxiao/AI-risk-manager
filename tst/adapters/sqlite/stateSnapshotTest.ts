import { execFileSync } from "node:child_process";
import { compiledPath } from "./compiledFixture.js";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { snapshotState } from "../../../src/adapters/sqlite/stateSnapshot.js";
import { repository, evidence, task } from "../../fixtures/riskFixture.js";
import { database, seeded, temporaryDirectory } from "./fixture.js";

describe("snapshot publication boundaries", () => {
  it("refuses missing sources, existing destinations and sidecars without overwriting them", async () => {
    const directory = temporaryDirectory();
    const destination = join(directory, "snapshot.sqlite");
    await expect(snapshotState(join(directory, "missing.sqlite"), destination)).rejects.toThrow(
      "does not exist",
    );
    expect(readdirSync(directory)).toEqual([]);
    const source = await seeded();
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      const path = join(temporaryDirectory(), "snapshot.sqlite");
      writeFileSync(path + suffix, "preserve");
      await expect(snapshotState(source.path, path)).rejects.toThrow("already exists");
      expect(readFileSync(path + suffix, "utf8")).toBe("preserve");
    }
    await expect(snapshotState(source.path, source.path)).rejects.toThrow("already exists");
  });

  it("rejects linked source databases, journals and destinations", async () => {
    const source = await seeded();
    const directory = temporaryDirectory();
    const destination = join(directory, "snapshot.sqlite");
    const linked = join(directory, "linked.sqlite");
    symlinkSync(source.path, linked);
    await expect(snapshotState(linked, destination)).rejects.toThrow("safely opened");
    symlinkSync(source.path, destination);
    await expect(snapshotState(source.path, destination)).rejects.toThrow("safely opened");
    const hardLink = join(directory, "hard.sqlite");
    linkSync(source.path, hardLink);
    await expect(snapshotState(source.path, join(directory, "new.sqlite"))).rejects.toThrow(
      "safely opened",
    );
    const other = database();
    other.close();
    symlinkSync(source.path, `${other.path}-wal`);
    await expect(snapshotState(other.path, join(directory, "new.sqlite"))).rejects.toThrow(
      "safely opened",
    );
  });

  it("rejects an output inside a saved repository even through a directory alias", async () => {
    const source = database();
    const directory = temporaryDirectory();
    const monitored = join(directory, "monitored");
    mkdirSync(monitored);
    await source.store.execute((tx) =>
      tx.repositories.add({
        ...repository,
        canonicalPath: realpathSync(monitored),
        gitRoot: realpathSync(monitored),
      }),
    );
    const alias = join(directory, "alias");
    symlinkSync(monitored, alias);
    await expect(snapshotState(source.path, join(alias, "snapshot.sqlite"))).rejects.toThrow(
      "outside monitored",
    );
    expect(readdirSync(monitored)).toEqual([]);
  });

  it("rejects a source within its registered repository before SQLite can create sidecars", async () => {
    const directory = temporaryDirectory();
    const monitored = join(directory, "monitored");
    mkdirSync(monitored);
    const source = database(join(monitored, "state.sqlite"));
    await source.store.execute((tx) =>
      tx.repositories.add({
        ...repository,
        canonicalPath: realpathSync(monitored),
        gitRoot: realpathSync(monitored),
      }),
    );
    source.close();
    expect(readdirSync(monitored)).toEqual(["state.sqlite"]);
    const original = readFileSync(source.path);
    const alias = join(directory, "alias");
    symlinkSync(monitored, alias);
    for (const path of [source.path, join(alias, "state.sqlite")]) {
      const destination = join(directory, "backup.sqlite");
      await expect(snapshotState(path, destination)).rejects.toThrow("outside monitored");
      expect(() => snapshotCommand(path, destination)).toThrow();
      expect(readdirSync(monitored)).toEqual(["state.sqlite"]);
      expect(readFileSync(source.path)).toEqual(original);
      expect(existsSync(destination)).toBe(false);
    }
  });

  it.each([
    "UPDATE schema_migrations SET hash = 'invalid'",
    "PRAGMA foreign_keys = OFF; UPDATE tasks SET data = json_set(data, '$.sprintId', 'missing')",
  ])("removes staging output when validation fails: %s", async (corrupt) => {
    const source = await seeded();
    source.raw.exec(corrupt);
    source.close();
    const directory = temporaryDirectory();
    const destination = join(directory, "snapshot.sqlite");
    expect(() => snapshotCommand(source.path, destination)).toThrow();
    expect(existsSync(destination)).toBe(false);
    expect(readdirSync(directory)).toEqual([]);
  });
});

describe("restoring a consistent SQLite snapshot", () => {
  it("restores saved plans and evidence with a live WAL, independently of later mutations", async () => {
    const source = await seeded();
    source.raw.exec("PRAGMA wal_autocheckpoint = 0");
    await source.store.execute((tx) => tx.planning.addTask(task("before-backup")));
    expect(statSync(`${source.path}-wal`).size).toBeGreaterThan(0);
    const snapshot = join(temporaryDirectory(), "backup.sqlite");
    expect(snapshotCommand(source.path, snapshot)).toContain("SQLite snapshot saved and verified");
    expect(statSync(snapshot).mode & 0o777).toBe(0o600);
    await source.store.execute((tx) => tx.planning.addTask(task("after-backup")));
    const restoredPath = join(temporaryDirectory(), "state.sqlite");
    snapshotCommand(snapshot, restoredPath);
    const restored = database(restoredPath);
    expect(await restored.store.execute((tx) => tx.planning.findTaskById("before-backup"))).toEqual(
      task("before-backup"),
    );
    expect(
      await restored.store.execute((tx) => tx.planning.findTaskById("after-backup")),
    ).toBeUndefined();
    expect(await restored.store.execute((tx) => tx.evidence.findById(evidence.id))).toEqual(
      evidence,
    );
    expect(await restored.store.execute((tx) => tx.repositories.list())).toEqual([repository]);
    expect(restored.raw.prepare("PRAGMA integrity_check").get()?.["integrity_check"]).toBe("ok");
  });
});

function snapshotCommand(source: string, destination: string): string {
  return execFileSync(
    process.execPath,
    [compiledPath("adapters/sqlite/stateSnapshot.js"), source, destination],
    { encoding: "utf8", stdio: "pipe" },
  );
}
