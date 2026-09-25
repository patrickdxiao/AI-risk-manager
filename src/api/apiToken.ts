import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
export const LOCAL_TOKEN_FILE = "api-token";
export const LOCAL_TOKEN_BYTES = 32;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export type LocalTokenErrorCode =
  | "state_directory_inside_repository"
  | "state_directory_not_private"
  | "state_directory_not_directory"
  | "token_file_not_private"
  | "token_file_not_regular"
  | "token_file_malformed";

/** Reports an unsafe local credential or state path without exposing its contents. */
export class LocalTokenError extends Error {
  override readonly name = "LocalTokenError";

  constructor(
    readonly code: LocalTokenErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Create or reuse the private API credential.
 * @throws LocalTokenError when the state directory or stored credential is unsafe.
 */
export async function ensureLocalToken(stateDir: string): Promise<string> {
  const directory = await ensureLocalStateDirectory(stateDir);

  const tokenPath = resolve(directory, LOCAL_TOKEN_FILE);
  const existing = await readTokenIfPresent(tokenPath);
  if (existing !== undefined) return existing;

  const token = randomBytes(LOCAL_TOKEN_BYTES).toString("base64url");
  const temporaryPath = resolve(
    directory,
    `.${LOCAL_TOKEN_FILE}.${String(process.pid)}.${randomBytes(12).toString("hex")}.tmp`,
  );
  const handle = await open(
    temporaryPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    PRIVATE_FILE_MODE,
  );
  try {
    try {
      await handle.writeFile(`${token}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporaryPath, tokenPath);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
  return (await readTokenIfPresent(tokenPath)) ?? failMissingPublishedToken();
}

/** Read an existing owner's credential without creating state or changing file permissions. */
export async function readLocalToken(stateDir: string): Promise<string> {
  const directory = resolve(stateDir);
  await assertPrivateDirectory(directory);
  await assertOutsideRepository(await realpath(directory));
  return (
    (await readTokenIfPresent(resolve(directory, LOCAL_TOKEN_FILE))) ?? failMissingPublishedToken()
  );
}

/** Create private state outside repositories, even when the caller supplies its own token. */
export async function ensureLocalStateDirectory(stateDir: string): Promise<string> {
  const requestedDirectory = resolve(stateDir);
  await rejectSymlinkOrNonDirectory(requestedDirectory);

  const canonicalCandidate = await canonicalizeStateDirectory(requestedDirectory);
  await assertOutsideRepository(canonicalCandidate);
  await mkdir(requestedDirectory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await assertPrivateDirectory(requestedDirectory);

  const canonicalDirectory = await realpath(requestedDirectory);
  await assertOutsideRepository(canonicalDirectory);
  return canonicalDirectory;
}

/** Read a private regular credential file, or return undefined when it is absent. */
async function readTokenIfPresent(tokenPath: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(
      tokenPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (isNotFound(error)) return undefined;
    if (isNodeError(error) && error.code === "ELOOP")
      throw new LocalTokenError("token_file_not_regular", "local API token must be a regular file");
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile())
      throw new LocalTokenError("token_file_not_regular", "local API token must be a regular file");
    if (process.platform !== "win32" && (stats.mode & 0o777) !== PRIVATE_FILE_MODE)
      throw new LocalTokenError("token_file_not_private", "local API token file mode must be 0600");
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(257), 0, 257, 0);
    const value = buffer.subarray(0, bytesRead).toString("utf8").trimEnd();
    if (bytesRead > 256 || !TOKEN_PATTERN.test(value))
      throw new LocalTokenError("token_file_malformed", "local API token file is malformed");
    return value;
  } finally {
    await handle.close();
  }
}

/** Reject state directories that other local users can read. */
async function assertPrivateDirectory(directory: string): Promise<void> {
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new LocalTokenError(
      "state_directory_not_directory",
      "local API state path must be a directory",
    );
  }
  if (process.platform !== "win32" && (stats.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
    throw new LocalTokenError(
      "state_directory_not_private",
      "local API state directory mode must be 0700",
    );
  }
}

/** Check ancestor Git markers without executing Git or assuming the caller's cwd is a repository. */
async function assertOutsideRepository(directory: string): Promise<void> {
  let candidate = directory;
  for (;;) {
    try {
      await lstat(resolve(candidate, ".git"));
      throw new LocalTokenError(
        "state_directory_inside_repository",
        "local API state directory must be outside repositories",
      );
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    const parent = resolve(candidate, "..");
    if (parent === candidate) return;
    candidate = parent;
  }
}

/** Reject state beneath a saved repository path or its current canonical location. */
export async function assertLocalStateOutsideRepositories(
  directory: string,
  repositoryPaths: readonly string[],
): Promise<void> {
  for (const repository of repositoryPaths) {
    assertOutsidePath(directory, resolve(repository));
    try {
      assertOutsidePath(directory, await realpath(repository));
    } catch (error) {
      // Offline or removed worktrees remain registered; their saved path still applies.
      if (!isNotFound(error)) throw error;
    }
  }
}

/** Reject a state path inside the supplied repository root. */
function assertOutsidePath(directory: string, repository: string): void {
  const pathFromRepository = relative(repository, directory);
  if (
    pathFromRepository === "" ||
    (pathFromRepository !== ".." &&
      !pathFromRepository.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromRepository))
  ) {
    throw new LocalTokenError(
      "state_directory_inside_repository",
      "local API state directory must be outside the monitored repository",
    );
  }
}

/** Allow a missing path, but reject an existing link or non-directory. */
async function rejectSymlinkOrNonDirectory(directory: string): Promise<void> {
  try {
    const stats = await lstat(directory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new LocalTokenError(
        "state_directory_not_directory",
        "local API state path must be a directory",
      );
    }
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
}

/** Resolve existing ancestors before checking a not-yet-created state directory. */
async function canonicalizeStateDirectory(input: string): Promise<string> {
  let candidate = input;
  const missingSegments: string[] = [];
  for (;;) {
    try {
      const canonicalParent = await realpath(candidate);
      return resolve(canonicalParent, ...missingSegments.reverse());
    } catch (error) {
      if (!isNotFound(error)) {
        throw new LocalTokenError(
          "state_directory_not_directory",
          "local API state path could not be resolved",
        );
      }
      const parent = resolve(candidate, "..");
      if (parent === candidate) {
        throw new LocalTokenError(
          "state_directory_not_directory",
          "local API state path could not be resolved",
        );
      }
      missingSegments.push(basename(candidate));
      candidate = parent;
    }
  }
}

/** Recognize a missing filesystem entry. */
function isNotFound(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

/** Recognize an atomic-create collision. */
function isAlreadyExists(error: unknown): boolean {
  return isNodeError(error) && error.code === "EEXIST";
}

/** Recognize a filesystem error with a machine-readable code. */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

/** Report a credential that disappeared during publication. */
function failMissingPublishedToken(): never {
  throw new LocalTokenError("token_file_malformed", "local API token was not published");
}
