import { createHash } from "node:crypto";
import { realpath, stat, lstat } from "node:fs/promises";
import { resolve, sep, basename, dirname } from "node:path";
import {
  assertApprovedGitMetadata,
  containsPath,
  isNotFound,
  readGitMetadata,
} from "./gitSafety.js";
import {
  GitAdapterError,
  GitProcessError,
  NodeGitProcessRunner,
  type GitProcessRequest,
  type GitProcessResult,
  type GitProcessRunner,
  type GitReadCommand,
} from "./gitProcess.js";
import {
  RepositoryInspectionError,
  type RepositoryInspectionPort,
  type RepositoryRegistrationInspection,
  type RepositoryObservationCapture,
  type RepositoryObservationPort,
  RepositoryObservationCaptureError,
} from "../../core/repository/repositoryModel.js";
import { deriveGitEvidence } from "./gitEvidence.js";
export const DEFAULT_GIT_TIMEOUT_MS = 5_000;

export const DEFAULT_GIT_MAX_BUFFER_BYTES = 2 * 1024 * 1024;

export const DEFAULT_STATUS_PATH_LIMIT = 200;

export const MAX_STATUS_ENTRIES = 10_000;

export type {
  RepositoryObservationStatusPath as RepositoryStatusPath,
  RepositoryObservationStatus as RepositoryStatusSummary,
  RepositoryObservationSnapshot as RepositoryInspection,
} from "../../core/repository/repositoryModel.js";
import type {
  RepositoryObservationStatusPath as RepositoryStatusPath,
  RepositoryObservationStatus as RepositoryStatusSummary,
  RepositoryObservationSnapshot as RepositoryInspection,
} from "../../core/repository/repositoryModel.js";

export interface InspectRepositoryOptions {
  readonly runner?: GitProcessRunner;
  readonly timeoutMs?: number;
  readonly maxBufferBytes?: number;
  readonly statusPathLimit?: number;
  readonly approvedRoot?: string;
}

/** Reads worktree metadata without executing monitored code.
 * @param repositoryPath - Existing directory inside the approved worktree.
 * @returns A snapshot with bounded changed paths and a metadata digest.
 * @throws GitAdapterError when Git fails, times out, or returns unsafe metadata. */
export async function inspectRepository(
  repositoryPath: string,
  options: InspectRepositoryOptions = {},
): Promise<RepositoryInspection> {
  const requestedPath = await canonicalDirectory(repositoryPath);
  const runner = options.runner ?? new NodeGitProcessRunner();
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS, "timeoutMs");
  const maxBufferBytes = positiveInteger(
    options.maxBufferBytes ?? DEFAULT_GIT_MAX_BUFFER_BYTES,
    "maxBufferBytes",
  );
  const statusPathLimit = nonnegativeInteger(
    options.statusPathLimit ?? DEFAULT_STATUS_PATH_LIMIT,
    "statusPathLimit",
  );
  const deadline = Date.now() + timeoutMs;
  const request = (command: GitReadCommand): GitProcessRequest => {
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      throw new GitAdapterError("git_command_timeout", "Git inspection timed out");
    return {
      command,
      cwd: requestedPath,
      timeoutMs: remaining,
      maxBufferBytes,
      ...(options.approvedRoot === undefined ? {} : { approvedRoot: options.approvedRoot }),
    };
  };

  const worktree = await run(runner, request("worktree"), repositoryPath);
  if (worktree.exitCode !== 0 || worktree.stdout.trim() !== "true") {
    throw new GitAdapterError("not_git_worktree", "path is not a Git worktree");
  }
  const rootResult = requireSuccess(await run(runner, request("root"), repositoryPath), "root");
  const rootPath = await canonicalDirectory(rootResult.stdout.replace(/\n$/u, ""));
  assertWithinRoot(requestedPath, rootPath);

  const headResult = await run(runner, request("head"), repositoryPath);
  const branchResult = await run(runner, request("branch"), repositoryPath);
  if (branchResult.exitCode !== 0 && branchResult.exitCode !== 1)
    requireSuccess(branchResult, "branch");
  const branch = branchResult.exitCode === 1 ? null : nonemptyLine(branchResult.stdout, "branch");
  const unborn = headResult.exitCode === 1 && branch !== null;
  if (!unborn) requireSuccess(headResult, "head");
  const head = unborn ? "unborn" : headResult.stdout.trim();
  if (!unborn && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(head))
    throw new GitAdapterError("malformed_git_output", "Git returned an invalid HEAD object ID");
  const statusResult = requireSuccess(
    await run(runner, request("status"), repositoryPath),
    "status",
  );
  const parsed = parsePorcelainV2(statusResult.stdout);
  const status = summarizeStatus(parsed, statusPathLimit);
  const normalized = {
    version: 1,
    rootPath,
    head,
    branch,
    entries: parsed,
    porcelain: statusResult.stdout,
    fingerprints: await statusFingerprints(rootPath, parsed, Math.max(0, deadline - Date.now())),
  };
  const snapshotDigest = createHash("sha256")
    .update(JSON.stringify(normalized), "utf8")
    .digest("hex");
  return Object.freeze({
    rootPath,
    head,
    branch,
    detached: branch === null,
    status,
    snapshotDigest,
  });
}

/** Resolves an existing directory to its canonical path. */
async function canonicalDirectory(input: string): Promise<string> {
  try {
    const canonical = await realpath(resolve(input));
    if (!(await stat(canonical)).isDirectory()) throw new Error("not a directory");
    return canonical;
  } catch (error) {
    throw new GitAdapterError(
      "invalid_repository_path",
      "repository path must identify an existing directory",
      error,
    );
  }
}

/** Maps process failures to repository inspection errors without exposing raw output. */
async function run(
  runner: GitProcessRunner,
  request: GitProcessRequest,
  repositoryPath: string,
): Promise<GitProcessResult> {
  try {
    return await runner.run(request);
  } catch (error) {
    if (error instanceof GitProcessError) {
      const code =
        error.code === "timeout"
          ? "git_command_timeout"
          : error.code === "max_buffer"
            ? "git_output_too_large"
            : error.code === "unsafe_configuration"
              ? "unsafe_git_configuration"
              : "git_command_failed";
      throw new GitAdapterError(code, `could not inspect repository ${repositoryPath}`, error);
    }
    throw new GitAdapterError(
      "git_command_failed",
      `could not inspect repository ${repositoryPath}`,
      error,
    );
  }
}

/** Rejects a failed Git command before reading its output. */
function requireSuccess(result: GitProcessResult, command: GitReadCommand): GitProcessResult {
  if (result.exitCode !== 0) {
    throw new GitAdapterError(
      "git_command_failed",
      `git ${command} failed with exit code ${String(result.exitCode)}`,
    );
  }
  return result;
}

/** Parses NUL-delimited status records, including paths with spaces. */
function parsePorcelainV2(output: string): readonly RepositoryStatusPath[] {
  if (output === "") return Object.freeze([]);
  const records = output.split("\0");
  if (records.at(-1) === "") records.pop();
  const entries: RepositoryStatusPath[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record === "") continue;
    if (entries.length >= MAX_STATUS_ENTRIES) {
      throw new GitAdapterError("git_output_too_large", "Git status contains too many entries");
    }
    const kind = record[0];
    if (kind === "?" && record.startsWith("? ")) {
      entries.push(statusPath(record.slice(2), false, false, true));
      continue;
    }
    if (kind === "!") continue;
    if (kind === "1" || kind === "2" || kind === "u") {
      const fieldCount = kind === "1" ? 9 : kind === "2" ? 10 : 11;
      const fields = splitFields(record, fieldCount);
      const xy = fields[1];
      const path = fields.at(-1);
      if (xy === undefined || xy.length !== 2 || path === undefined) malformedStatus();
      entries.push(statusPath(path, xy[0] !== ".", xy[1] !== ".", false));
      if (kind === "2") {
        index += 1;
        if (records[index] === undefined) malformedStatus();
      }
      continue;
    }
    malformedStatus();
  }
  return Object.freeze(
    entries.sort(
      (left, right) =>
        left.path.localeCompare(right.path) || flags(left).localeCompare(flags(right)),
    ),
  );
}

/** Separates fixed metadata fields while preserving the remaining path. */
function splitFields(record: string, count: number): readonly string[] {
  const fields: string[] = [];
  let remainder = record;
  for (let index = 1; index < count; index += 1) {
    const separator = remainder.indexOf(" ");
    if (separator < 0) malformedStatus();
    fields.push(remainder.slice(0, separator));
    remainder = remainder.slice(separator + 1);
  }
  fields.push(remainder);
  return fields;
}

/** Rejects empty or oversized paths and normalizes platform separators. */
function statusPath(
  path: string,
  staged: boolean,
  unstaged: boolean,
  untracked: boolean,
): RepositoryStatusPath {
  if (path.length === 0 || path.length > 4_096) malformedStatus();
  return Object.freeze({ path: path.split(sep).join("/"), staged, unstaged, untracked });
}

/** Counts all changes while retaining only the requested number of paths. */
function summarizeStatus(
  entries: readonly RepositoryStatusPath[],
  limit: number,
): RepositoryStatusSummary {
  const stagedCount = entries.filter((entry) => entry.staged).length;
  const unstagedCount = entries.filter((entry) => entry.unstaged).length;
  const untrackedCount = entries.filter((entry) => entry.untracked).length;
  return Object.freeze({
    clean: entries.length === 0,
    stagedCount,
    unstagedCount,
    untrackedCount,
    totalPathCount: entries.length,
    paths: Object.freeze(entries.slice(0, limit)),
    pathsTruncated: entries.length > limit,
  });
}

/** Creates a stable ordering key for path change flags. */
function flags(entry: RepositoryStatusPath): string {
  return `${String(Number(entry.staged))}${String(Number(entry.unstaged))}${String(Number(entry.untracked))}`;
}

/** Requires a single nonblank line from Git. */
function nonemptyLine(value: string, field: string): string {
  const line = value.trim();
  if (line === "" || line.includes("\n") || line.includes("\0")) {
    throw new GitAdapterError("malformed_git_output", `Git returned an invalid ${field}`);
  }
  return line;
}

/** Rejects values outside the positive integer range. */
function positiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive integer`);
  }
  return value;
}

/** Checks the requested path limit against the inspection bound. */
function nonnegativeInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0 || value > DEFAULT_STATUS_PATH_LIMIT) {
    throw new RangeError(
      `${field} must be an integer from 0 through ${String(DEFAULT_STATUS_PATH_LIMIT)}`,
    );
  }
  return value;
}

/** Records changed-file identity and timestamps without reading file contents. */
async function statusFingerprints(
  root: string,
  paths: readonly RepositoryStatusPath[],
  timeoutMs: number,
): Promise<readonly string[]> {
  const deadline = Date.now() + timeoutMs;
  const result: string[] = [];
  for (const entry of paths) {
    if (Date.now() > deadline)
      throw new GitAdapterError("git_command_timeout", "Worktree metadata scan timed out");
    const path = resolve(root, entry.path);
    assertWithinRoot(path, root);
    try {
      // Parent validation prevents following a directory symlink outside the worktree.
      const parent = await realpath(dirname(path));
      assertWithinRoot(parent, root);
      const value = await lstat(path, { bigint: true });
      result.push(
        `${entry.path}\0${String(value.dev)}:${String(value.ino)}:${String(value.mode)}:${String(value.size)}:${String(value.mtimeNs)}:${String(value.ctimeNs)}`,
      );
    } catch (error) {
      if (!isNotFound(error)) throw error;
      result.push(`${entry.path}\0missing`);
    }
  }
  return result;
}

/** Rejects paths outside the selected worktree. */
function assertWithinRoot(path: string, root: string): void {
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    throw new GitAdapterError("malformed_git_output", "Git returned an unrelated worktree root");
  }
}

/** Reports an unsupported or malformed Git status record. */
function malformedStatus(): never {
  throw new GitAdapterError("malformed_git_output", "Git returned malformed porcelain-v2 status");
}

/** Validates repository registration and keeps application state outside the worktree. */
export class GitRepositoryInspectionAdapter implements RepositoryInspectionPort {
  constructor(private readonly options: InspectRepositoryOptions = {}) {}

  /** Checks approved metadata and returns the canonical repository identity. */
  async inspectRegistration(input: {
    readonly path: string;
    readonly stateDirectory: string;
    readonly approvedRoot?: string;
  }): Promise<RepositoryRegistrationInspection> {
    try {
      await assertApprovedGitMetadata(input.path, input.approvedRoot ?? input.path);
    } catch (error) {
      if (error instanceof RepositoryInspectionError) throw error;
      const exists = await stat(input.path).catch(() => undefined);
      throw new RepositoryInspectionError(
        exists?.isDirectory() ? "not_git_repository" : "invalid_repository_path",
        "Repository metadata is unavailable",
        error,
      );
    }
    const approvedRoot = input.approvedRoot ?? input.path;
    const identity = await repositoryIdentityDigest(await realpath(input.path));
    const repository = await inspectForRegistration(input.path, { ...this.options, approvedRoot });
    await assertApprovedGitMetadata(repository.rootPath, approvedRoot);
    if (identity !== (await repositoryIdentityDigest(repository.rootPath)))
      throw new RepositoryInspectionError(
        "invalid_repository_path",
        "Repository changed during inspection",
      );
    const stateDirectory = await canonicalizeStateDirectory(input.stateDirectory);
    if (containsPath(repository.rootPath, stateDirectory)) {
      throw new RepositoryInspectionError(
        "state_directory_inside_repository",
        "application state directory must be outside the monitored repository",
      );
    }

    return Object.freeze({
      canonicalRoot: repository.rootPath,
      identityDigest: identity,
    });
  }
}

/** Binds a registration to its canonical Git directory and filesystem identity. */
async function repositoryIdentityDigest(rootPath: string): Promise<string> {
  const identity = await inspectGitIdentity(rootPath);
  const root = await lstat(rootPath, { bigint: true });
  return createHash("sha256")
    .update(
      `git-worktree\0${rootPath}\0${identity.path}\0${identity.device}\0${identity.inode}\0${String(root.dev)}\0${String(root.ino)}\0${identity.worktree}`,
      "utf8",
    )
    .digest("hex");
}

/** Resolves the Git common directory used to identify a worktree. */
async function inspectGitIdentity(rootPath: string): Promise<{
  readonly path: string;
  readonly device: string;
  readonly inode: string;
  readonly worktree: string;
}> {
  const gitEntry = resolve(rootPath, ".git");
  let gitDirectory = gitEntry;
  const gitStats = await lstat(gitEntry);
  if (!gitStats.isDirectory()) {
    const gitFile = await readGitMetadata(gitEntry, 4_096);
    const match = /^gitdir: (.+)$/u.exec(gitFile.replace(/\n$/u, ""));
    if (match === null || match[1] === undefined) {
      throw new RepositoryInspectionError(
        "invalid_repository_path",
        "Git worktree metadata is malformed",
      );
    }
    gitDirectory = resolve(dirname(gitEntry), match[1]);
  }

  let commonDirectory = gitDirectory;
  try {
    const commonDirectoryFile = await readGitMetadata(resolve(gitDirectory, "commondir"), 4_096);
    const commonPath = commonDirectoryFile.replace(/\n$/u, "");
    if (commonPath.length > 0) commonDirectory = resolve(gitDirectory, commonPath);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  const canonicalPath = await realpath(commonDirectory);
  const identity = await stat(canonicalPath);
  if (!identity.isDirectory()) {
    throw new RepositoryInspectionError(
      "invalid_repository_path",
      "Git common directory is not a directory",
    );
  }
  return Object.freeze({
    path: canonicalPath,
    device: String(identity.dev),
    inode: String(identity.ino),
    worktree: await realpath(gitDirectory),
  });
}

/** Maps Git inspection failures to repository registration errors. */
async function inspectForRegistration(path: string, options: InspectRepositoryOptions) {
  try {
    return await inspectRepository(path, options);
  } catch (error) {
    if (error instanceof GitAdapterError && error.code === "not_git_worktree") {
      throw new RepositoryInspectionError("not_git_repository", "path is not a Git repository");
    }
    if (error instanceof GitAdapterError && error.code === "invalid_repository_path") {
      throw new RepositoryInspectionError(
        "invalid_repository_path",
        "repository path must identify an existing directory",
      );
    }
    throw new RepositoryInspectionError(
      "invalid_repository_path",
      "repository could not be inspected",
      error,
    );
  }
}

/** Resolves existing parent links even before the state directory exists. */
async function canonicalizeStateDirectory(input: string): Promise<string> {
  if (input.length === 0 || input.trim() !== input) {
    throw new RepositoryInspectionError(
      "invalid_repository_path",
      "state directory path must be non-blank and trimmed",
    );
  }

  let candidate = resolve(input);
  const missingSegments: string[] = [];
  for (;;) {
    try {
      const canonicalParent = await realpath(candidate);
      return resolve(canonicalParent, ...missingSegments.reverse());
    } catch (error) {
      if (!isNotFound(error)) {
        throw new RepositoryInspectionError(
          "invalid_repository_path",
          "state directory path could not be resolved",
        );
      }
      const parent = dirname(candidate);
      if (parent === candidate) {
        throw new RepositoryInspectionError(
          "invalid_repository_path",
          "state directory path could not be resolved",
        );
      }
      missingSegments.push(basename(candidate));
      candidate = parent;
    }
  }
}

/** Captures metadata only while the approved repository identity remains unchanged. */
export class GitRepositoryObservationAdapter implements RepositoryObservationPort {
  constructor(private readonly options: InspectRepositoryOptions = {}) {}

  /** Checks identity before and after capture, then derives immutable evidence. */
  async capture(
    input: Parameters<RepositoryObservationPort["capture"]>[0],
  ): Promise<RepositoryObservationCapture> {
    let snapshot;
    try {
      const root = await realpath(input.repository.gitRoot);
      await assertApprovedGitMetadata(
        root,
        input.repository.approvedRoot ?? input.repository.canonicalPath,
      );
      if (
        root !== input.repository.canonicalPath ||
        (await repositoryIdentityDigest(root)) !== input.repository.identityDigest
      ) {
        throw new RepositoryObservationCaptureError();
      }
      snapshot = await inspectRepository(input.repository.gitRoot, {
        ...this.options,
        approvedRoot: input.repository.approvedRoot ?? input.repository.canonicalPath,
      });
      await assertApprovedGitMetadata(
        root,
        input.repository.approvedRoot ?? input.repository.canonicalPath,
      );
      if (
        snapshot.rootPath !== root ||
        (await repositoryIdentityDigest(root)) !== input.repository.identityDigest
      ) {
        throw new RepositoryObservationCaptureError();
      }
    } catch {
      throw new RepositoryObservationCaptureError();
    }
    const evidenceItems = deriveGitEvidence({
      ...(input.previous === undefined ? {} : { previous: input.previous }),
      current: snapshot,
      repositoryId: input.repository.id,
      observedAt: input.observedAt,
      idFactory: {
        next: () => ({
          evidenceItemId: input.nextEvidenceId(),
          eventId: input.nextEventId(),
        }),
      },
    });
    return Object.freeze({ snapshot, evidenceItems });
  }
}
