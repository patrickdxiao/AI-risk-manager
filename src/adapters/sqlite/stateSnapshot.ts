import { chmodSync, linkSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import {
  inspectSQLiteFiles,
  openSQLiteDatabase,
  readSQLiteRepositoryPaths,
} from "./sqliteDatabase.js";

/** Save a consistent SQLite snapshot, including committed WAL pages, without overwriting files.
 * The same operation restores a snapshot into a fresh state directory; API tokens and session credential files are not copied. */
export async function snapshotState(sourcePath: string, destinationPath: string): Promise<void> {
  const suppliedSource = resolve(sourcePath);
  const destination = join(
    realpathSync(dirname(resolve(destinationPath))),
    basename(destinationPath),
  );
  if (!inspectSQLiteFiles(suppliedSource).has(""))
    throw new Error("Source database does not exist");
  if (inspectSQLiteFiles(destination).size !== 0) throw new Error("Destination already exists");
  const source = realpathSync(suppliedSource);
  // Even read-only SQLite can create sidecars. Inspect a private copy before opening
  // the source, then reject either path under a saved repository, including directory aliases.
  assertSnapshotPaths(source, destination, readSQLiteRepositoryPaths(source));
  const raw = new DatabaseSync(source, { readOnly: true });
  let temporary: string | undefined;
  try {
    temporary = mkdtempSync(join(dirname(destination), ".risk-snapshot-"));
    const staged = join(temporary, "state.sqlite");
    await backup(raw, staged);
    chmodSync(staged, 0o600);
    const checked = openSQLiteDatabase({ path: staged });
    try {
      if (
        checked.raw.prepare("PRAGMA quick_check").get()?.["quick_check"] !== "ok" ||
        checked.raw.prepare("PRAGMA foreign_key_check").all().length !== 0
      )
        throw new Error("Snapshot integrity check failed");
    } finally {
      checked.close();
    }
    assertSnapshotPaths(source, destination, readSQLiteRepositoryPaths(staged));
    // Exclusive publication cannot replace a file that appeared while SQLite was copying.
    if (inspectSQLiteFiles(destination).size !== 0) throw new Error("Destination already exists");
    linkSync(staged, destination);
  } finally {
    try {
      raw.close();
    } finally {
      if (temporary !== undefined) rmSync(temporary, { recursive: true, force: true });
    }
  }
}

function assertSnapshotPaths(source: string, destination: string, roots: readonly string[]): void {
  for (const root of roots) {
    for (const candidate of [source, destination]) {
      const path = relative(root, candidate);
      if (path === "" || (!path.startsWith("../") && path !== ".." && !isAbsolute(path)))
        throw new Error("Snapshot source and destination must stay outside monitored repositories");
    }
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(realpathSync(entrypoint)).href) {
  const [source, destination, extra] = process.argv.slice(2);
  if (source === undefined || destination === undefined || extra !== undefined) {
    process.stderr.write(
      "Usage: node dist/adapters/sqlite/stateSnapshot.js SOURCE.sqlite NEW.sqlite\n",
    );
    process.exitCode = 1;
  } else {
    try {
      await snapshotState(source, destination);
      process.stdout.write(
        "SQLite snapshot saved and verified. API tokens and session files were not copied.\n",
      );
    } catch {
      process.stderr.write(
        "Snapshot failed; use an existing application database and a new destination outside monitored repositories.\n",
      );
      process.exitCode = 1;
    }
  }
}
