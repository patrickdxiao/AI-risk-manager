import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { DiscoverRepositories } from "../../../src/adapters/git/discoverRepositories.js";
import { GitRepositoryInspectionAdapter } from "../../../src/adapters/git/inspectRepository.js";
import type { TransactionContext, UnitOfWorkPort } from "../../../src/core/storageContracts.js";
import type { Repository } from "../../../src/core/repository/repositoryModel.js";
function repositoryStore(): UnitOfWorkPort {
  const records: Repository[] = [];
  return {
    execute: (work) =>
      work({
        repositories: {
          list: () => Promise.resolve([...records]),
          findById: (id: string) => Promise.resolve(records.find((record) => record.id === id)),
          add: (record: Repository) => {
            records.push(record);
            return Promise.resolve();
          },
        },
      } as unknown as TransactionContext),
  };
}
const fixtureClock = { now: () => "2026-09-24T01:00:00.000Z" };
function fixtureIds() {
  let id = 0;
  return { next: () => `id-${String(++id)}` };
}

const run = promisify(execFile);
async function repository(path: string) {
  await mkdir(path, { recursive: true });
  await run("git", ["init", "--quiet", path]);
  await writeFile(join(path, "file.txt"), "fixture\n");
  await run("git", ["-C", path, "add", "file.txt"]);
  await run("git", [
    "-C",
    path,
    "-c",
    "user.email=fixture@example.test",
    "-c",
    "user.name=Fixture",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
}

describe("approved repository discovery", () => {
  it("finds multiple repositories, skips exclusions and links, and rejects outside Git pointers", async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "risk-discovery-")));
    try {
      const root = join(temporary, "approved");
      await repository(join(root, "first"));
      await repository(join(root, "nested", "second"));
      await repository(join(root, "node_modules", "excluded"));
      await repository(join(root, "private", "excluded"));
      const outside = join(temporary, "outside");
      await repository(outside);
      await symlink(outside, join(root, "linked"));
      await mkdir(join(root, "escaped"));
      await writeFile(join(root, "escaped", ".git"), `gitdir: ${join(outside, ".git")}\n`);
      const uow = repositoryStore();
      const ids = fixtureIds();
      const discovery = new DiscoverRepositories(
        uow,
        new GitRepositoryInspectionAdapter(),
        ids,
        fixtureClock,
        join(temporary, "state"),
      );
      const input = { roots: [root], exclusions: ["private"] };
      const result = await discovery.execute(input);
      expect(result.repositories.map((value) => value.canonicalPath).sort()).toEqual([
        join(root, "first"),
        join(root, "nested", "second"),
      ]);
      expect(result.repositories.every((value) => value.approvedRoot === root)).toBe(true);
      expect(result.incomplete).toBe(true);
      expect(result.issues).toEqual([`Could not safely inspect: ${join(root, "escaped")}`]);
      expect((await discovery.execute(input)).repositories).toHaveLength(2);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("returns an incomplete result when the directory entry bound is reached", async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "risk-discovery-limit-")));
    try {
      await Promise.all(
        Array.from({ length: 2_005 }, (_, i) =>
          writeFile(join(temporary, `file-${String(i)}`), ""),
        ),
      );
      const uow = repositoryStore();
      const ids = fixtureIds();
      const result = await new DiscoverRepositories(
        uow,
        new GitRepositoryInspectionAdapter(),
        ids,
        fixtureClock,
        "/outside-state",
      ).execute({ roots: [temporary] });
      expect(result).toMatchObject({ repositories: [], incomplete: true });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});

describe("discovery limits and explicit scope", () => {
  it("returns only this scan's discoveries and preserves trailing spaces through real capture", async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "risk-discovery-scope-")));
    try {
      const root = join(temporary, "approved");
      const first = join(root, "first ");
      await repository(first);
      await repository(join(temporary, "other"));
      const store = repositoryStore();
      const discovery = new DiscoverRepositories(
        store,
        new GitRepositoryInspectionAdapter(),
        fixtureIds(),
        fixtureClock,
        join(temporary, "state"),
      );
      await discovery.execute({ roots: [join(temporary, "other")] });
      const result = await discovery.execute({ roots: [root, root] });
      expect(result.repositories).toHaveLength(1);
      expect(result.repositories[0]?.canonicalPath).toBe(first);
      expect(result.incomplete).toBe(false);
      const registered = result.repositories[0];
      if (registered === undefined) throw new Error("registration missing");
      const { repositoryCaptureFixture } = await import(
        "../../fixtures/repositoryCaptureFixture.js"
      );
      const { ReconcileRepository } = await import(
        "../../../src/core/repository/repositoryCapture.js"
      );
      const { GitRepositoryObservationAdapter } = await import(
        "../../../src/adapters/git/inspectRepository.js"
      );
      const fixture = repositoryCaptureFixture({ repository: registered });
      const capture = await new ReconcileRepository(
        fixture.store,
        new GitRepositoryObservationAdapter(),
        fixtureIds(),
        fixtureClock,
      ).execute({ repositoryId: registered.id });
      expect(capture.evidence).toHaveLength(1);
      expect(capture.evidence[0]).toMatchObject({
        repositoryId: registered.id,
        source: "git",
        privacyMode: "metadata_only",
      });
      expect(capture.evidence[0]).not.toHaveProperty("sprintId");
      expect(JSON.stringify(capture.evidence)).not.toContain(first);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("stops at the repository and depth limits without silently claiming complete coverage", async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "risk-discovery-bounds-")));
    try {
      await repository(join(temporary, "one"));
      await repository(join(temporary, "two"));
      const discovery = (limits: { repositories?: number; depth?: number }) =>
        new DiscoverRepositories(
          repositoryStore(),
          new GitRepositoryInspectionAdapter(),
          fixtureIds(),
          fixtureClock,
          "/outside-state",
          limits,
        );
      expect(await discovery({ repositories: 1 }).execute({ roots: [temporary] })).toMatchObject({
        repositories: [expect.objectContaining({ approvedRoot: temporary })],
        incomplete: true,
      });
      expect(await discovery({ depth: 0 }).execute({ roots: [temporary] })).toMatchObject({
        repositories: [],
        incomplete: true,
      });
      expect(await discovery({}).execute({ roots: [join(temporary, "missing")] })).toMatchObject({
        repositories: [],
        incomplete: true,
        issues: [`Folder unavailable: ${join(temporary, "missing")}`],
      });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("snapshots approved roots before asynchronous discovery and rejects oversized settings", async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "risk-discovery-input-")));
    try {
      await repository(temporary);
      const discovery = new DiscoverRepositories(
        repositoryStore(),
        new GitRepositoryInspectionAdapter(),
        fixtureIds(),
        fixtureClock,
        "/outside-state",
      );
      const input = { roots: [temporary] };
      const pending = discovery.execute(input);
      input.roots[0] = "/";
      expect((await pending).repositories).toHaveLength(1);
      await expect(discovery.execute({ roots: [] })).rejects.toMatchObject({
        code: "out_of_range",
      });
      await expect(
        discovery.execute({ roots: [temporary], exclusions: ["../escape"] }),
      ).rejects.toMatchObject({ code: "invalid_value" });
      expect(
        () =>
          new DiscoverRepositories(
            repositoryStore(),
            new GitRepositoryInspectionAdapter(),
            fixtureIds(),
            fixtureClock,
            "/state",
            { entries: 2_001 },
          ),
      ).toThrow();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
