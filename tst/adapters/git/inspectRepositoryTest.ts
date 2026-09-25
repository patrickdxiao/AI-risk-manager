import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type {
  GitProcessRequest,
  GitProcessResult,
  GitProcessRunner,
} from "../../../src/adapters/git/gitProcess.js";
import { GitProcessError, NodeGitProcessRunner } from "../../../src/adapters/git/gitProcess.js";
import {
  GitRepositoryInspectionAdapter,
  GitRepositoryObservationAdapter,
  inspectRepository,
  MAX_STATUS_ENTRIES,
} from "../../../src/adapters/git/inspectRepository.js";
import { createRepository } from "../../../src/core/repository/repositoryModel.js";

describe("inspect-repository", () => {
  const runFile = promisify(execFile);

  async function git(cwd: string, args: readonly string[]): Promise<void> {
    await runFile("git", args, {
      cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
      shell: false,
    });
  }

  async function repository(name = "repository"): Promise<string> {
    const parent = await import("node:fs/promises").then(({ mkdtemp }) =>
      mkdtemp(join(tmpdir(), "development-risk-git-")),
    );
    const root = join(parent, name);
    await mkdir(root);
    await git(root, ["init", "--quiet"]);
    await git(root, ["config", "user.email", "fixture@example.test"]);
    await git(root, ["config", "user.name", "Fixture"]);
    await writeFile(join(root, "tracked.txt"), "initial\n", "utf8");
    await git(root, ["add", "tracked.txt"]);
    await git(root, ["commit", "--quiet", "-m", "initial"]);
    return realpath(root);
  }

  describe("inspectRepository", () => {
    it("records successive same-size edits to an already dirty path without repository writes", async () => {
      const root = await repository();
      await writeFile(join(root, "tracked.txt"), "firstxx\n");
      const first = await inspectRepository(root);
      await writeFile(join(root, "tracked.txt"), "secondx\n");
      const before = await contentSnapshot(root);
      const second = await inspectRepository(root);
      expect(second.status).toEqual(first.status);
      expect(second.snapshotDigest).not.toBe(first.snapshotDigest);
      expect(await contentSnapshot(root)).toEqual(before);
    });

    it.each(["clean", "process"])(
      "rejects a configured %s filter without executing it for a same-size edit",
      async (driver) => {
        const root = await repository();
        const marker = join(root, "filter-executed");
        await writeFile(join(root, ".gitattributes"), "tracked.txt filter=audit\n");
        await git(root, ["add", ".gitattributes"]);
        await git(root, ["commit", "--quiet", "-m", "attributes fixture"]);
        await git(root, ["config", `filter.audit.${driver}`, `echo executed > '${marker}'; cat`]);
        await writeFile(join(root, "tracked.txt"), "changed\n");
        const before = await contentSnapshot(root);

        await expect(inspectRepository(root)).rejects.toMatchObject({
          code: "unsafe_git_configuration",
        });

        await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await contentSnapshot(root)).toEqual(before);
      },
    );

    it("rejects included filter configuration without inspecting worktree content", async () => {
      const root = await repository();
      const marker = join(root, "filter-executed");
      await writeFile(join(root, ".git", "info", "attributes"), "tracked.txt filter=audit\n");
      await writeFile(
        join(root, ".git", "filter.config"),
        `[filter "audit"]\nclean = "echo executed > '${marker}'; cat"\nrequired = true\n`,
      );
      await git(root, ["config", "include.path", "filter.config"]);
      await writeFile(join(root, "tracked.txt"), "changed\n");

      await expect(inspectRepository(root)).rejects.toMatchObject({
        code: "unsafe_git_configuration",
      });
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("preserves dirty submodule detection and rejects its external filters", async () => {
      const root = await repository();
      const component = join(root, "component");
      await mkdir(component);
      await git(component, ["init", "--quiet"]);
      await git(component, ["config", "user.email", "fixture@example.test"]);
      await git(component, ["config", "user.name", "Fixture"]);
      await writeFile(join(component, "tracked.txt"), "initial\n");
      await writeFile(join(component, ".gitattributes"), "tracked.txt filter=audit\n");
      await git(component, ["add", "."]);
      await git(component, ["commit", "--quiet", "-m", "component fixture"]);
      await git(root, ["add", "component"]);
      await git(root, ["commit", "--quiet", "-m", "gitlink fixture"]);
      await writeFile(join(component, "tracked.txt"), "changed\n");
      await mkdir(join(root, "nested"));

      expect((await inspectRepository(join(root, "nested"))).status.paths).toContainEqual({
        path: "component",
        staged: false,
        unstaged: true,
        untracked: false,
      });

      const marker = join(component, "filter-executed");
      await git(component, ["config", "filter.audit.process", `echo executed > '${marker}'; cat`]);
      const before = await contentSnapshot(root);
      await expect(inspectRepository(root)).rejects.toMatchObject({
        code: "unsafe_git_configuration",
      });
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await contentSnapshot(root)).toEqual(before);
    });
    it("returns a stable clean snapshot without changing repository content or Git metadata", async () => {
      const root = await repository();
      const before = await contentSnapshot(root);
      const first = await inspectRepository(root);
      const second = await inspectRepository(root);
      const after = await contentSnapshot(root);

      expect(first.rootPath).toBe(root);
      expect(first.head).toMatch(/^[0-9a-f]{40,64}$/);
      expect(first.branch).toBeTypeOf("string");
      expect(first.detached).toBe(false);
      expect(first.status).toEqual({
        clean: true,
        stagedCount: 0,
        unstagedCount: 0,
        untrackedCount: 0,
        totalPathCount: 0,
        paths: [],
        pathsTruncated: false,
      });
      expect(second.snapshotDigest).toBe(first.snapshotDigest);
      expect(after).toEqual(before);
    });

    it("summarizes modified, staged, and untracked paths deterministically with a bound", async () => {
      const root = await repository();
      const clean = await inspectRepository(root);
      await writeFile(join(root, "tracked.txt"), "modified\n", "utf8");
      await writeFile(join(root, "staged.txt"), "staged\n", "utf8");
      await git(root, ["add", "staged.txt"]);
      await writeFile(join(root, "untracked.txt"), "untracked\n", "utf8");

      const inspection = await inspectRepository(root, { statusPathLimit: 2 });
      expect(inspection.status).toMatchObject({
        clean: false,
        stagedCount: 1,
        unstagedCount: 1,
        untrackedCount: 1,
        totalPathCount: 3,
        pathsTruncated: true,
      });
      expect(inspection.status.paths).toEqual([
        { path: "staged.txt", staged: true, unstaged: false, untracked: false },
        { path: "tracked.txt", staged: false, unstaged: true, untracked: false },
      ]);
      expect(inspection.snapshotDigest).not.toBe(clean.snapshotDigest);
      expect((await inspectRepository(root, { statusPathLimit: 2 })).snapshotDigest).toBe(
        inspection.snapshotDigest,
      );
    });

    it("reports a detached HEAD", async () => {
      const root = await repository();
      await git(root, ["checkout", "--quiet", "--detach", "HEAD"]);
      const inspection = await inspectRepository(root);
      expect(inspection.branch).toBeNull();
      expect(inspection.detached).toBe(true);
    });

    it("treats a dash-prefixed path with spaces only as cwd", async () => {
      const root = await repository("--repository with spaces");
      const inspection = await inspectRepository(root);
      expect(inspection.rootPath).toBe(root);
      expect(inspection.status.clean).toBe(true);
    });

    it("rejects non-Git and missing paths with typed errors", async () => {
      const parent = await import("node:fs/promises").then(({ mkdtemp }) =>
        mkdtemp(join(tmpdir(), "development-risk-not-git-")),
      );
      await expect(inspectRepository(parent)).rejects.toMatchObject({
        code: "not_git_worktree",
      });
      await expect(inspectRepository(join(parent, "missing"))).rejects.toMatchObject({
        code: "invalid_repository_path",
      });
    });

    it.each([
      ["timeout", new GitProcessError("timeout", "timed out"), "git_command_timeout"],
      ["large output", new GitProcessError("max_buffer", "too large"), "git_output_too_large"],
      ["spawn error", new GitProcessError("spawn_failed", "failed"), "git_command_failed"],
      ["unknown error", new Error("unknown"), "git_command_failed"],
    ])("maps %s runner failures", async (_case, error, code) => {
      const root = await repository();
      const runner: GitProcessRunner = { run: () => Promise.reject(error) };
      await expect(inspectRepository(root, { runner, timeoutMs: 1 })).rejects.toMatchObject({
        code,
      });
    });

    it("uses only fixed read commands and rejects command/status errors", async () => {
      const root = await repository();
      const commands: string[] = [];
      const responses: Record<string, GitProcessResult> = {
        worktree: { exitCode: 0, stdout: "true\n", stderr: "" },
        root: { exitCode: 0, stdout: `${root}\n`, stderr: "" },
        head: { exitCode: 0, stdout: `${"a".repeat(40)}\n`, stderr: "" },
        branch: { exitCode: 0, stdout: "main\n", stderr: "" },
        status: { exitCode: 2, stdout: "", stderr: "failure" },
      };
      const runner: GitProcessRunner = {
        run: (request: GitProcessRequest) => {
          commands.push(request.command);
          const result = responses[request.command];
          if (result === undefined) throw new Error("unexpected command");
          expect(request.cwd).toBe(root);
          return Promise.resolve(result);
        },
      };
      await expect(inspectRepository(root, { runner })).rejects.toMatchObject({
        code: "git_command_failed",
      });
      expect(commands).toEqual(["worktree", "root", "head", "branch", "status"]);
    });

    it("handles a staged rename and a zero returned-path bound", async () => {
      const root = await repository();
      const before = await inspectRepository(root);
      await git(root, ["mv", "tracked.txt", "renamed.txt"]);
      const renamed = await inspectRepository(root, { statusPathLimit: 0 });
      expect(renamed.status).toMatchObject({
        stagedCount: 1,
        unstagedCount: 0,
        untrackedCount: 0,
        totalPathCount: 1,
        paths: [],
        pathsTruncated: true,
      });
      expect(renamed.snapshotDigest).not.toBe(before.snapshotDigest);
    });

    it("parses unmerged entries and ignores ignored-path records", async () => {
      const root = await repository();
      const status =
        "u UU N... 100644 100644 100644 100644 aaaaaaa bbbbbbb ccccccc conflict.txt\0? conflict.txt\0! ignored.txt\0";
      const inspection = await inspectRepository(root, { runner: cannedRunner(root, { status }) });
      expect(inspection.status).toMatchObject({
        stagedCount: 1,
        unstagedCount: 1,
        untrackedCount: 1,
        totalPathCount: 2,
      });
      expect(inspection.status.paths[0]?.path).toBe("conflict.txt");
    });

    it.each([
      ["unknown record", "x invalid\0", "malformed_git_output"],
      ["short ordinary record", "1 bad\0", "malformed_git_output"],
      [
        "rename missing source path",
        "2 R. N... 100644 100644 100644 aaaaaaa bbbbbbb R100 renamed.txt\0",
        "malformed_git_output",
      ],
      ["empty untracked path", "? \0", "malformed_git_output"],
      ["oversized path", `? ${"a".repeat(16_385)}\0`, "malformed_git_output"],
      [
        "too many records",
        `${Array.from({ length: MAX_STATUS_ENTRIES + 1 }, (_, index) => `? ${String(index)}`).join("\0")}\0`,
        "git_output_too_large",
      ],
    ])("rejects %s porcelain output", async (_case, status, code) => {
      const root = await repository();
      await expect(
        inspectRepository(root, { runner: cannedRunner(root, { status }) }),
      ).rejects.toMatchObject({ code });
    });

    it("rejects malformed head, branch, and unrelated root responses", async () => {
      const root = await repository();
      await expect(
        inspectRepository(root, { runner: cannedRunner(root, { head: "not-an-object\n" }) }),
      ).rejects.toMatchObject({ code: "malformed_git_output" });
      await expect(
        inspectRepository(root, { runner: cannedRunner(root, { branch: "\n" }) }),
      ).rejects.toMatchObject({ code: "malformed_git_output" });
      await expect(
        inspectRepository(root, { runner: cannedRunner(root, { branchExitCode: 2 }) }),
      ).rejects.toMatchObject({ code: "git_command_failed" });

      const unrelated = await mkdtemp(join(tmpdir(), "development-risk-unrelated-"));
      await expect(
        inspectRepository(root, { runner: cannedRunner(unrelated) }),
      ).rejects.toMatchObject({ code: "malformed_git_output" });
    });

    it("validates operational bounds and non-directory paths", async () => {
      const root = await repository();
      await expect(inspectRepository(root, { timeoutMs: 0 })).rejects.toThrow(RangeError);
      await expect(inspectRepository(root, { timeoutMs: 1.5 })).rejects.toThrow(RangeError);
      await expect(inspectRepository(root, { maxBufferBytes: 0 })).rejects.toThrow(RangeError);
      await expect(inspectRepository(root, { statusPathLimit: -1 })).rejects.toThrow(RangeError);
      await expect(inspectRepository(root, { statusPathLimit: 1.5 })).rejects.toThrow(RangeError);
      await expect(
        inspectRepository(root, { statusPathLimit: MAX_STATUS_ENTRIES + 1 }),
      ).rejects.toThrow(RangeError);
      await expect(inspectRepository(join(root, "tracked.txt"))).rejects.toMatchObject({
        code: "invalid_repository_path",
      });
    });

    it("enforces runner timeout and output bounds and returns nonzero stderr", async () => {
      const root = await repository();
      const runner = new NodeGitProcessRunner();
      const success = await runner.run({
        command: "worktree",
        cwd: root,
        timeoutMs: 5_000,
        maxBufferBytes: 1_024,
      });
      expect(success).toMatchObject({ exitCode: 0, stdout: "true\n", stderr: "" });

      await writeFile(join(root, "untracked.txt"), "content\n", "utf8");
      await expect(
        runner.run({ command: "status", cwd: root, timeoutMs: 5_000, maxBufferBytes: 1 }),
      ).rejects.toMatchObject({ code: "max_buffer" });
      await expect(
        runner.run({ command: "status", cwd: root, timeoutMs: 0, maxBufferBytes: 1_024 }),
      ).rejects.toMatchObject({ code: "timeout" });

      const nonGit = await mkdtemp(join(tmpdir(), "development-risk-runner-error-"));
      const failed = await runner.run({
        command: "worktree",
        cwd: nonGit,
        timeoutMs: 5_000,
        maxBufferBytes: 4_096,
      });
      expect(failed.exitCode).not.toBe(0);
      expect(failed.stderr).not.toBe("");
      await expect(
        runner.run({
          command: "worktree",
          cwd: join(nonGit, "missing"),
          timeoutMs: 5_000,
          maxBufferBytes: 4_096,
        }),
      ).rejects.toMatchObject({ code: "spawn_failed", cause: { code: "ENOENT" } });
    });
  });

  function cannedRunner(
    root: string,
    overrides: {
      readonly status?: string;
      readonly head?: string;
      readonly branch?: string;
      readonly branchExitCode?: number;
    } = {},
  ): GitProcessRunner {
    const responses: Readonly<Record<string, GitProcessResult>> = {
      worktree: { exitCode: 0, stdout: "true\n", stderr: "" },
      root: { exitCode: 0, stdout: `${root}\n`, stderr: "" },
      head: { exitCode: 0, stdout: overrides.head ?? `${"a".repeat(40)}\n`, stderr: "" },
      branch: {
        exitCode: overrides.branchExitCode ?? 0,
        stdout: overrides.branch ?? "main\n",
        stderr: "",
      },
      status: { exitCode: 0, stdout: overrides.status ?? "", stderr: "" },
    };
    return {
      run: (request) => {
        const response = responses[request.command];
        if (response === undefined) throw new Error("unexpected command");
        return Promise.resolve(response);
      },
    };
  }

  async function contentSnapshot(root: string): Promise<Readonly<Record<string, string>>> {
    const result: Record<string, string> = {};
    await walk(root, async (path) => {
      const details = await stat(path);
      if (!details.isFile()) return;
      const content = await readFile(path);
      result[relative(root, path)] =
        `${(details.mode & 0o777).toString(8)}:${createHash("sha256").update(content).digest("hex")}`;
    });
    return Object.freeze(result);
  }

  async function walk(root: string, visit: (path: string) => Promise<void>): Promise<void> {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) await walk(path, visit);
      else await visit(path);
    }
  }
});

describe("repository-inspection", () => {
  const repositoryInspectionRunFile = promisify(execFile);

  describe("GitRepositoryInspectionAdapter", () => {
    it("registers an outside state directory deterministically without mutating the repository", async () => {
      const root = await repositoryInspectionRepository();
      const stateDirectory = await mkdtemp(join(tmpdir(), "development-risk-state-"));
      const before = await repositorySnapshot(root);
      const adapter = new GitRepositoryInspectionAdapter();

      const first = await adapter.inspectRegistration({ path: root, stateDirectory });
      const second = await adapter.inspectRegistration({ path: root, stateDirectory });

      expect(first).toEqual(second);
      expect(first.canonicalRoot).toBe(root);
      expect(first.identityDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(await repositorySnapshot(root)).toEqual(before);
    });

    it("rejects state paths equal to or below the canonical repository root", async () => {
      const root = await repositoryInspectionRepository();
      const existingChild = join(root, "state");
      await mkdir(existingChild);
      const adapter = new GitRepositoryInspectionAdapter();

      for (const stateDirectory of [root, existingChild, join(root, "future", "nested")]) {
        await expect(
          adapter.inspectRegistration({ path: root, stateDirectory }),
        ).rejects.toMatchObject({ code: "state_directory_inside_repository" });
      }
    });

    it("accepts a similar-prefix sibling because containment is path-segment aware", async () => {
      const root = await repositoryInspectionRepository("repo");
      const stateDirectory = join(dirname(root), "repo-state");
      await mkdir(stateDirectory);

      await expect(
        new GitRepositoryInspectionAdapter().inspectRegistration({ path: root, stateDirectory }),
      ).resolves.toMatchObject({ canonicalRoot: root });
    });

    it("canonicalizes repository and state symlinks plus nonexistent state descendants", async () => {
      const root = await repositoryInspectionRepository();
      const links = await mkdtemp(join(tmpdir(), "development-risk-links-"));
      const repositoryLink = join(links, "repository-link");
      await symlink(root, repositoryLink, "dir");
      const realStateParent = await mkdtemp(join(tmpdir(), "development-risk-real-state-"));
      const stateLink = join(links, "state-link");
      await symlink(realStateParent, stateLink, "dir");
      const adapter = new GitRepositoryInspectionAdapter();

      const existing = await adapter.inspectRegistration({
        path: repositoryLink,
        stateDirectory: stateLink,
      });
      const prospective = await adapter.inspectRegistration({
        path: repositoryLink,
        stateDirectory: join(stateLink, "future", "nested"),
      });

      expect(existing.canonicalRoot).toBe(await realpath(root));
      expect(prospective).toEqual(existing);
    });

    it("changes identity when a different Git repository replaces the same path", async () => {
      const root = await repositoryInspectionRepository();
      const stateDirectory = await mkdtemp(join(tmpdir(), "development-risk-state-"));
      const adapter = new GitRepositoryInspectionAdapter();
      const first = await adapter.inspectRegistration({ path: root, stateDirectory });
      const oldRoot = `${root}-old`;
      await rename(root, oldRoot);
      await mkdir(root);
      await repositoryInspectionGit(root, ["init", "--quiet"]);
      await repositoryInspectionGit(root, ["config", "user.email", "fixture@example.test"]);
      await repositoryInspectionGit(root, ["config", "user.name", "Fixture"]);
      await writeFile(join(root, "replacement.txt"), "replacement\n", "utf8");
      await repositoryInspectionGit(root, ["add", "replacement.txt"]);
      await repositoryInspectionGit(root, ["commit", "--quiet", "-m", "replacement"]);

      const replacement = await adapter.inspectRegistration({ path: root, stateDirectory });
      expect(replacement.identityDigest).not.toBe(first.identityDigest);
    });

    it("maps non-Git, missing, and malformed state paths to application inspection errors", async () => {
      const nonGit = await mkdtemp(join(tmpdir(), "development-risk-non-git-"));
      const stateDirectory = await mkdtemp(join(tmpdir(), "development-risk-state-"));
      const adapter = new GitRepositoryInspectionAdapter();

      await expect(
        adapter.inspectRegistration({ path: nonGit, stateDirectory }),
      ).rejects.toMatchObject({ code: "not_git_repository" });
      await expect(
        adapter.inspectRegistration({ path: join(nonGit, "missing"), stateDirectory }),
      ).rejects.toMatchObject({ code: "invalid_repository_path" });

      const root = await repositoryInspectionRepository();
      await expect(
        adapter.inspectRegistration({ path: root, stateDirectory: " " }),
      ).rejects.toMatchObject({ code: "invalid_repository_path" });
    });

    it.each([
      ["timeout", new GitProcessError("timeout", "secret timeout command")],
      ["process", new GitProcessError("spawn_failed", "secret process command")],
      ["unknown", new Error("secret unexpected failure")],
    ])("sanitizes %s failures as typed inspection errors", async (_case, failure) => {
      const root = await repositoryInspectionRepository();
      const stateDirectory = await mkdtemp(join(tmpdir(), "development-risk-state-"));
      const runner: GitProcessRunner = { run: () => Promise.reject(failure) };

      try {
        await new GitRepositoryInspectionAdapter({ runner }).inspectRegistration({
          path: root,
          stateDirectory,
        });
      } catch (error) {
        expect(error).toMatchObject({ code: "invalid_repository_path" });
        expect(error).toMatchObject({ cause: { cause: failure } });
        expect(String(error)).not.toContain("secret");
        expect(String(error)).not.toContain("git ");
        return;
      }
      throw new Error("expected inspection to fail");
    });
  });

  async function repositoryInspectionRepository(name = "repository"): Promise<string> {
    const parent = await mkdtemp(join(tmpdir(), "development-risk-registration-git-"));
    const root = join(parent, name);
    await mkdir(root);
    await repositoryInspectionGit(root, ["init", "--quiet"]);
    await repositoryInspectionGit(root, ["config", "user.email", "fixture@example.test"]);
    await repositoryInspectionGit(root, ["config", "user.name", "Fixture"]);
    await writeFile(join(root, "tracked.txt"), "initial\n", "utf8");
    await repositoryInspectionGit(root, ["add", "tracked.txt"]);
    await repositoryInspectionGit(root, ["commit", "--quiet", "-m", "initial"]);
    return realpath(root);
  }

  async function repositoryInspectionGit(cwd: string, args: readonly string[]): Promise<void> {
    await repositoryInspectionRunFile("git", args, {
      cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
      shell: false,
    });
  }

  async function repositorySnapshot(root: string): Promise<readonly string[]> {
    const [{ stdout: head }, { stdout: status }, content] = await Promise.all([
      repositoryInspectionRunFile("git", ["rev-parse", "HEAD"], { cwd: root }),
      repositoryInspectionRunFile("git", ["status", "--porcelain=v2", "-z"], {
        cwd: root,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
      }),
      readFile(join(root, "tracked.txt"), "utf8"),
    ]);
    return Object.freeze([head, status, content]);
  }
});

describe("repository-observation", () => {
  const run = promisify(execFile);
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true })));
  });

  describe("GitRepositoryObservationAdapter", () => {
    it.each(["before first capture", "between captures", "during capture"])(
      "rejects repository replacement %s before deriving evidence",
      async (phase) => {
        const root = await gitFixture();
        const replacement = await gitFixture();
        const identity = await new GitRepositoryInspectionAdapter().inspectRegistration({
          path: root,
          stateDirectory: join(dirname(root), "state"),
        });
        const repository = createRepository({
          id: "repository-1",
          canonicalPath: identity.canonicalRoot,
          gitRoot: identity.canonicalRoot,
          identityDigest: identity.identityDigest,
          registeredAt: "2026-08-31T08:00:00Z",
        });
        let issuedIds = 0;
        const input = {
          repository,
          observedAt: "2026-08-31T09:00:00Z",
          nextEvidenceId: () => `evidence-${String(++issuedIds)}`,
          nextEventId: () => `event-${String(issuedIds)}`,
        };
        const replaceMetadata = async () => {
          await rename(join(root, ".git"), join(root, ".git-original"));
          await rename(join(replacement, ".git"), join(root, ".git"));
        };
        const runner = new NodeGitProcessRunner();
        const adapter = new GitRepositoryObservationAdapter({
          runner: {
            async run(request) {
              const result = await runner.run(request);
              if (phase === "during capture" && request.command === "status") {
                await replaceMetadata();
              }
              return result;
            },
          },
        });
        const previous =
          phase === "between captures" ? (await adapter.capture(input)).snapshot : undefined;
        if (phase !== "during capture") await replaceMetadata();
        const before = issuedIds;
        await expect(
          adapter.capture({ ...input, ...(previous === undefined ? {} : { previous }) }),
        ).rejects.toMatchObject({ name: "RepositoryObservationCaptureError" });
        expect(issuedIds).toBe(before);
      },
    );
    it("maps real snapshots, commits, and worktree changes without mutating the repository", async () => {
      const root = await gitFixture();
      const adapter = new GitRepositoryObservationAdapter();
      const identity = await new GitRepositoryInspectionAdapter().inspectRegistration({
        path: root,
        stateDirectory: join(dirname(root), "state"),
      });
      const repository = createRepository({
        id: "repository-1",
        canonicalPath: identity.canonicalRoot,
        gitRoot: identity.canonicalRoot,
        identityDigest: identity.identityDigest,
        registeredAt: "2026-08-31T08:00:00Z",
      });
      let sequence = 0;
      const ids = {
        nextEvidenceId: () => `evidence-${String(++sequence)}`,
        nextEventId: () => `event-${String(sequence)}`,
      };

      const initial = await adapter.capture({
        repository,
        observedAt: "2026-08-31T09:00:00Z",
        ...ids,
      });
      expect(initial.evidenceItems.map((item) => item.kind)).toEqual(["repository_snapshot"]);

      await writeFile(join(root, "tracked.txt"), "changed\n", "utf8");
      const before = await repositoryObservationGit(root, ["status", "--porcelain"]);
      const worktree = await adapter.capture({
        repository,
        previous: initial.snapshot,
        observedAt: "2026-08-31T09:05:00Z",
        ...ids,
      });
      expect(worktree.evidenceItems.map((item) => item.kind)).toEqual(["worktree_change"]);
      expect(await repositoryObservationGit(root, ["status", "--porcelain"])).toBe(before);

      await repositoryObservationGit(root, ["add", "tracked.txt"]);
      await repositoryObservationGit(root, ["commit", "-m", "second"]);
      const committed = await adapter.capture({
        repository,
        previous: worktree.snapshot,
        observedAt: "2026-08-31T09:10:00Z",
        ...ids,
      });
      expect(committed.evidenceItems.map((item) => item.kind)).toEqual([
        "commit",
        "worktree_change",
      ]);
      expect((await repositoryObservationGit(root, ["status", "--porcelain"])).trim()).toBe("");
    });
  });

  async function gitFixture(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "development-risk-observation-"));
    temporaryRoots.push(root);
    await repositoryObservationGit(root, ["init", "--initial-branch=main"]);
    await repositoryObservationGit(root, ["config", "user.email", "test@example.invalid"]);
    await repositoryObservationGit(root, ["config", "user.name", "Test User"]);
    await writeFile(join(root, "tracked.txt"), "initial\n", "utf8");
    await repositoryObservationGit(root, ["add", "tracked.txt"]);
    await repositoryObservationGit(root, ["commit", "-m", "initial"]);
    return root;
  }

  async function repositoryObservationGit(root: string, argv: readonly string[]): Promise<string> {
    const result = await run("git", ["-C", root, ...argv], { encoding: "utf8" });
    return result.stdout;
  }
});
