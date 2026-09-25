import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  GitAdapterError,
  GitProcessError,
  NodeGitProcessRunner,
} from "../../../src/adapters/git/gitProcess.js";

describe("errors", () => {
  describe("Git adapter errors", () => {
    it("retain sanitized codes and optional causes", () => {
      const cause = new Error("low level");
      const adapter = new GitAdapterError("git_command_failed", "Git inspection failed", cause);
      const process = new GitProcessError("spawn_failed", "could not start git", cause);

      expect(adapter).toMatchObject({ name: "GitAdapterError", code: "git_command_failed", cause });
      expect(process).toMatchObject({ name: "GitProcessError", code: "spawn_failed", cause });
      expect(new GitProcessError("timeout", "timed out").cause).toBeUndefined();
    });
  });
});

describe("git-process-runner", () => {
  const run = promisify(execFile);
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  describe("NodeGitProcessRunner", () => {
    it("reports a missing executable as a typed spawn failure", async () => {
      const runner = new NodeGitProcessRunner({ executable: "/missing-risk-test/git" });
      await expect(
        runner.run({
          command: "worktree",
          cwd: tmpdir(),
          timeoutMs: 1_000,
          maxBufferBytes: 128,
        }),
      ).rejects.toMatchObject({ name: "GitProcessError", code: "spawn_failed" });
    });
    it("runs only the bounded read command and enforces its output limit", async () => {
      const directory = await mkdtemp(join(tmpdir(), "risk-git-runner-"));
      directories.push(directory);
      await run("git", ["init", "-q"], { cwd: directory });
      const runner = new NodeGitProcessRunner();

      await expect(
        runner.run({ command: "worktree", cwd: directory, timeoutMs: 1_000, maxBufferBytes: 128 }),
      ).resolves.toMatchObject({ exitCode: 0, stdout: "true\n", stderr: "" });

      await writeFile(join(directory, "untracked-file-with-a-long-name.txt"), "content");
      await expect(
        runner.run({ command: "status", cwd: directory, timeoutMs: 1_000, maxBufferBytes: 1 }),
      ).rejects.toMatchObject({ code: "max_buffer" });
    });
  });
});
