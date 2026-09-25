import { assertApprovedGitMetadata } from "./gitSafety.js";
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
export type GitAdapterErrorCode =
  | "invalid_repository_path"
  | "not_git_worktree"
  | "git_command_failed"
  | "git_command_timeout"
  | "git_output_too_large"
  | "unsafe_git_configuration"
  | "malformed_git_output";

/** Reports a repository inspection failure without exposing command output. */
export class GitAdapterError extends Error {
  override readonly name = "GitAdapterError";

  constructor(
    readonly code: GitAdapterErrorCode,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

export type GitProcessErrorCode =
  | "timeout"
  | "max_buffer"
  | "spawn_failed"
  | "unsafe_configuration";

/** Reports why a bounded Git process could not finish. */
export class GitProcessError extends Error {
  override readonly name = "GitProcessError";

  constructor(
    readonly code: GitProcessErrorCode,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

export type GitReadCommand = "worktree" | "root" | "head" | "branch" | "status";

export interface GitProcessRequest {
  readonly command: GitReadCommand;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxBufferBytes: number;
  readonly approvedRoot?: string;
}

export interface GitProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitProcessRunner {
  run(request: GitProcessRequest): Promise<GitProcessResult>;
}

export interface NodeGitProcessRunnerOptions {
  readonly executable?: string;
}

type InternalGitCommand = GitReadCommand | "filters" | "submodules";

type CommandRequest = Omit<GitProcessRequest, "command"> & {
  readonly command: InternalGitCommand;
};

const COMMAND_ARGUMENTS: Readonly<Record<InternalGitCommand, readonly string[]>> = Object.freeze({
  worktree: Object.freeze(["rev-parse", "--is-inside-work-tree"]),
  root: Object.freeze(["rev-parse", "--show-toplevel"]),
  head: Object.freeze(["rev-parse", "--verify", "--quiet", "HEAD"]),
  branch: Object.freeze(["symbolic-ref", "--short", "-q", "HEAD"]),
  status: Object.freeze(["status", "--porcelain=v2", "-z", "--untracked-files=all"]),
  filters: Object.freeze(["config", "--null", "--get-regexp", "^filter\\..*\\.(clean|process)$"]),
  submodules: Object.freeze(["ls-files", "--stage", "-z"]),
});

const SAFE_GIT_PATH =
  process.platform === "win32"
    ? "C:\\Windows\\System32;C:\\Windows;C:\\Program Files\\Git\\cmd"
    : "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin";

const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";

const READ_ONLY_CONFIG_ARGUMENTS = Object.freeze([
  "-c",
  `core.hooksPath=${NULL_DEVICE}`,
  "-c",
  "core.fsmonitor=false",
  "-c",
  `core.attributesFile=${NULL_DEVICE}`,
  "-c",
  `core.excludesFile=${NULL_DEVICE}`,
]);

/** Runs allowlisted Git reads with hooks, prompts, and lazy fetches disabled. */
export class NodeGitProcessRunner implements GitProcessRunner {
  private readonly executable: string;

  constructor(options: NodeGitProcessRunnerOptions = {}) {
    this.executable = options.executable ?? findTrustedGitExecutable();
    if (!isAbsolute(this.executable)) {
      throw new GitProcessError("spawn_failed", "git executable must be an absolute path");
    }
  }

  /** Runs a read command after checking filters and submodules when status needs them. */
  async run(request: GitProcessRequest): Promise<GitProcessResult> {
    if (request.command !== "status") return this.runCommand(request);
    const deadline = Date.now() + request.timeoutMs;
    const root = await this.runCommand(
      withRemainingTime({ ...request, command: "root" }, deadline),
    );
    if (root.exitCode !== 0) return root;
    await this.assertSafeWorktree(
      {
        ...request,
        cwd: root.stdout.replace(/\n$/u, ""),
        approvedRoot: request.approvedRoot ?? root.stdout.replace(/\n$/u, ""),
      },
      deadline,
      new Set(),
    );
    return this.runCommand(withRemainingTime(request, deadline));
  }

  /** Rejects content filters that Git status could execute, including in submodules. */
  private async assertSafeWorktree(
    request: GitProcessRequest,
    deadline: number,
    visited: Set<string>,
  ): Promise<void> {
    const cwd = await realpath(request.cwd);
    if (visited.has(cwd)) return;
    if (visited.size >= 100) {
      throw new GitProcessError("max_buffer", "Git inspection contains too many submodules");
    }
    visited.add(cwd);
    try {
      await assertApprovedGitMetadata(cwd, request.approvedRoot ?? cwd);
    } catch (error) {
      throw new GitProcessError(
        "unsafe_configuration",
        "Git metadata is outside the inspection contract",
        error,
      );
    }
    const filters = await this.runCommand(
      withRemainingTime({ ...request, cwd, command: "filters" }, deadline),
    );
    if (filters.exitCode !== 0 && filters.exitCode !== 1) {
      throw new GitProcessError(
        "unsafe_configuration",
        "Git filter configuration could not be verified",
      );
    }
    // Status can run clean/process drivers to hash same-size edits. Disabling them would
    // change normalization and invent dirty paths, so filtered worktrees fail closed.
    if (
      filters.stdout.split("\0").some((entry) => {
        if (entry === "") return false;
        const separator = entry.indexOf("\n");
        return separator === -1 || entry.slice(separator + 1) !== "";
      })
    ) {
      throw new GitProcessError(
        "unsafe_configuration",
        "Git status requires an external content filter",
      );
    }
    // Status recursively inspects initialized gitlinks with their own configuration.
    // Discover them from index metadata without reading or executing their source.
    const submodules = await this.runCommand(
      withRemainingTime({ ...request, cwd, command: "submodules" }, deadline),
    );
    if (submodules.exitCode !== 0) {
      throw new GitProcessError(
        "unsafe_configuration",
        "Git submodule configuration could not be verified",
      );
    }
    for (const entry of submodules.stdout.split("\0")) {
      if (entry === "") continue;
      if (!entry.startsWith("160000 ")) continue;
      const match = /^160000 [0-9a-f]{40,64} [0-3]\t(.+)$/su.exec(entry);
      if (match?.[1] === undefined) {
        throw new GitProcessError("unsafe_configuration", "Git submodule metadata is malformed");
      }
      const submodulePath = resolve(cwd, match[1]);
      const pathFromRoot = relative(cwd, submodulePath);
      if (
        pathFromRoot === "" ||
        pathFromRoot === ".." ||
        pathFromRoot.startsWith(`..${sep}`) ||
        isAbsolute(pathFromRoot)
      ) {
        throw new GitProcessError(
          "unsafe_configuration",
          "Git submodule path is outside its worktree",
        );
      }
      try {
        await lstat(join(submodulePath, ".git"));
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
        throw new GitProcessError("unsafe_configuration", "Git submodule metadata is unavailable");
      }
      try {
        await assertApprovedGitMetadata(submodulePath, request.approvedRoot ?? cwd);
      } catch (error) {
        throw new GitProcessError(
          "unsafe_configuration",
          "Git submodule metadata is outside the approved folder",
          error,
        );
      }
      const submoduleRoot = await this.runCommand(
        withRemainingTime({ ...request, cwd: submodulePath, command: "root" }, deadline),
      );
      if (
        submoduleRoot.exitCode !== 0 ||
        (await realpath(submoduleRoot.stdout.replace(/\n$/u, ""))) !==
          (await realpath(submodulePath))
      ) {
        throw new GitProcessError("unsafe_configuration", "Git submodule worktree is unrelated");
      }
      await this.assertSafeWorktree({ ...request, cwd: submodulePath }, deadline, visited);
    }
  }

  /** Collects bounded output and stops the process on timeout or overflow. */
  private async runCommand(request: CommandRequest): Promise<GitProcessResult> {
    const child = spawn(
      this.executable,
      [...READ_ONLY_CONFIG_ARGUMENTS, ...COMMAND_ARGUMENTS[request.command]],
      {
        cwd: request.cwd,
        env: {
          PATH: SAFE_GIT_PATH,
          LANG: "C",
          LC_ALL: "C",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_SYSTEM: NULL_DEVICE,
          GIT_CONFIG_GLOBAL: NULL_DEVICE,
          GCM_INTERACTIVE: "Never",
          GIT_ASKPASS: "",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0",
          GIT_NO_LAZY_FETCH: "1",
        },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bufferedBytes = 0;
    let terminalError: GitProcessError | undefined;

    const timeout = setTimeout(() => {
      terminalError = new GitProcessError(
        "timeout",
        `git ${request.command} exceeded ${String(request.timeoutMs)}ms`,
      );
      child.kill("SIGKILL");
    }, request.timeoutMs);
    timeout.unref();

    const capture = (destination: Buffer[]) => (chunk: Buffer) => {
      bufferedBytes += chunk.length;
      if (bufferedBytes > request.maxBufferBytes) {
        terminalError = new GitProcessError(
          "max_buffer",
          `git ${request.command} exceeded its output limit`,
        );
        child.kill("SIGKILL");
        return;
      }
      destination.push(chunk);
    };
    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));

    child.once("error", (error) => {
      terminalError = new GitProcessError("spawn_failed", "could not start git", error);
    });
    const exitCode = await new Promise<number | null>((resolve) => child.once("close", resolve));
    clearTimeout(timeout);
    if (terminalError !== undefined) throw terminalError;
    return Object.freeze({
      exitCode: exitCode ?? 1,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    });
  }
}

/** Keeps each command within the shared inspection deadline. */
function withRemainingTime(request: CommandRequest, deadline: number): CommandRequest {
  const timeoutMs = deadline - Date.now();
  if (timeoutMs <= 0) throw new GitProcessError("timeout", "Git status exceeded its time limit");
  return { ...request, timeoutMs };
}

/** Finds Git in known installation paths instead of the caller’s PATH. */
function findTrustedGitExecutable(): string {
  const candidates =
    process.platform === "win32"
      ? [
          "C:\\Program Files\\Git\\cmd\\git.exe",
          "C:\\Program Files\\Git\\bin\\git.exe",
          "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
        ]
      : ["/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git"];
  const executable = candidates.find((candidate) => {
    try {
      return existsSync(candidate) && statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
  if (executable === undefined) {
    throw new GitProcessError("spawn_failed", "could not locate a trusted git executable");
  }
  return executable;
}
