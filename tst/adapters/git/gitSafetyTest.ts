import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertApprovedGitMetadata, readGitMetadata } from "../../../src/adapters/git/gitSafety.js";
import {
  GitRepositoryInspectionAdapter,
  GitRepositoryObservationAdapter,
} from "../../../src/adapters/git/inspectRepository.js";

const run = promisify(execFile);
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "risk-git-safety-")));
  temporary.push(parent);
  const root = join(parent, "repo");
  await mkdir(root);
  await run("git", ["init", "--quiet", root]);
  return { parent, root };
}

describe("approved Git metadata", () => {
  it("rejects FIFO metadata without blocking for a writer", async () => {
    if (process.platform === "win32") return;
    const { parent } = await fixture();
    const fifo = join(parent, "metadata-fifo");
    await run("mkfifo", [fifo]);
    await expect(readGitMetadata(fifo, 4096)).rejects.toMatchObject({
      code: "invalid_repository_path",
    });
  });

  it("registers and captures an unborn repository without inventing a commit", async () => {
    const { root, parent } = await fixture();
    const inspected = await new GitRepositoryInspectionAdapter().inspectRegistration({
      path: root,
      stateDirectory: join(parent, "state"),
    });
    let id = 0;
    const captured = await new GitRepositoryObservationAdapter().capture({
      repository: {
        id: "repo",
        canonicalPath: root,
        gitRoot: root,
        identityDigest: inspected.identityDigest,
        registeredAt: "2026-09-24T00:00:00.000Z",
      },
      observedAt: "2026-09-24T01:00:00.000Z",
      nextEvidenceId: () => `e-${String(++id)}`,
      nextEventId: () => `event-${String(id)}`,
    });
    expect(captured.snapshot).toMatchObject({
      head: "unborn",
      detached: false,
      status: { clean: true },
    });
    expect(captured.evidenceItems.map((item) => item.kind)).toEqual(["repository_snapshot"]);
  });

  it("allows linked worktree metadata only when the shared parent was explicitly approved", async () => {
    const { root, parent } = await fixture();
    await run("git", [
      "-C",
      root,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "--quiet",
      "-m",
      "fixture",
    ]);
    const linked = join(parent, "linked");
    await run("git", ["-C", root, "worktree", "add", "--quiet", "--detach", linked]);
    const inspector = new GitRepositoryInspectionAdapter();
    await expect(
      inspector.inspectRegistration({ path: linked, stateDirectory: join(parent, "state") }),
    ).rejects.toMatchObject({ code: "invalid_repository_path" });
    const result = await inspector.inspectRegistration({
      path: linked,
      approvedRoot: parent,
      stateDirectory: join(parent, "state"),
    });
    expect(result.canonicalRoot).toBe(linked);
  });

  it.each(["config", "info/attributes", "info/exclude", "objects", "refs"])(
    "rejects administrative symlinks at %s",
    async (name) => {
      const { root, parent } = await fixture();
      const outside = join(parent, "outside");
      await writeFile(outside, "private metadata");
      const target = join(root, ".git", name);
      await rm(target, { recursive: true, force: true });
      await symlink(outside, target);
      await expect(assertApprovedGitMetadata(root, root)).rejects.toMatchObject({
        code: "invalid_repository_path",
      });
    },
  );

  it.each([
    "refs/heads/private",
    "objects/aa",
    "objects/pack/private.pack",
    "reftable/private.ref",
  ])("rejects nested metadata links at %s before registration runs Git", async (name) => {
    const { root, parent } = await fixture();
    const outside = join(parent, "outside");
    await mkdir(outside);
    const target = join(root, ".git", name);
    await mkdir(join(target, ".."), { recursive: true });
    await symlink(outside, target);
    const runner = { run: vi.fn() };
    await expect(
      new GitRepositoryInspectionAdapter({ runner }).inspectRegistration({
        path: root,
        stateDirectory: join(parent, "state"),
      }),
    ).rejects.toMatchObject({ code: "invalid_repository_path" });
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("rejects excessively deep administrative trees without following an unbounded scan", async () => {
    const { root } = await fixture();
    await mkdir(join(root, ".git", "refs", ...Array.from({ length: 34 }, () => "a")), {
      recursive: true,
    });
    await expect(assertApprovedGitMetadata(root, root)).rejects.toMatchObject({
      code: "invalid_repository_path",
    });
  });

  it.each(["objects/info/alternates", "objects/info/http-alternates"])(
    "rejects implicit object storage at %s",
    async (name) => {
      const { root } = await fixture();
      await writeFile(join(root, ".git", name), "/outside-approval/objects\n");
      await expect(assertApprovedGitMetadata(root, root)).rejects.toMatchObject({
        code: "invalid_repository_path",
      });
    },
  );

  it("rejects oversized configuration and metadata pointers without running Git", async () => {
    const { root, parent } = await fixture();
    await writeFile(join(root, ".git", "config"), "x".repeat(65_537));
    await expect(assertApprovedGitMetadata(root, root)).rejects.toMatchObject({
      code: "invalid_repository_path",
    });
    const pointer = join(parent, "pointer");
    await mkdir(pointer);
    await writeFile(join(pointer, ".git"), "x".repeat(4_097));
    await expect(assertApprovedGitMetadata(pointer, parent)).rejects.toMatchObject({
      code: "invalid_repository_path",
    });
    await writeFile(join(pointer, ".git"), "not a gitdir pointer");
    await expect(assertApprovedGitMetadata(pointer, parent)).rejects.toMatchObject({
      code: "invalid_repository_path",
    });
  });

  it("does not run fsmonitor or read an external excludes file configured in the repository", async () => {
    const { root, parent } = await fixture();
    const marker = join(parent, "executed");
    const helper = join(parent, "monitor");
    await writeFile(helper, `#!/bin/sh\necho invoked > '${marker}'\n`, { mode: 0o755 });
    const excludes = join(parent, "exclude");
    await writeFile(excludes, "visible.txt\n");
    await writeFile(join(root, "visible.txt"), "visible");
    await run("git", ["-C", root, "config", "core.fsmonitor", helper]);
    await run("git", ["-C", root, "config", "core.excludesFile", excludes]);
    await new GitRepositoryInspectionAdapter().inspectRegistration({
      path: root,
      stateDirectory: join(parent, "state"),
    });
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    const { inspectRepository } = await import("../../../src/adapters/git/inspectRepository.js");
    expect((await inspectRepository(root)).status.paths.map((item) => item.path)).toContain(
      "visible.txt",
    );
  });
});
