import { realpath, lstat, stat, open, opendir } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, relative, isAbsolute, sep, dirname } from "node:path";
import { RepositoryInspectionError } from "../../core/repository/repositoryModel.js";

/** Validate admin pointers before invoking Git or reading outside the approved folder. */
export async function assertApprovedGitMetadata(path: string, approvedRoot: string): Promise<void> {
  const root = await realpath(approvedRoot);
  const worktree = await realpath(path);
  const check = async (candidate: string): Promise<string> => {
    if (!containsPath(root, resolve(candidate)))
      throw new RepositoryInspectionError(
        "invalid_repository_path",
        "Git metadata is outside the approved folder",
      );
    const canonical = await realpath(candidate);
    if (!containsPath(root, canonical))
      throw new RepositoryInspectionError(
        "invalid_repository_path",
        "Git metadata follows an out-of-scope link",
      );
    return canonical;
  };
  await check(worktree);
  let git = await check(resolve(worktree, ".git"));
  const pointer = async (file: string): Promise<string> => {
    const safe = await check(file);
    return (await readGitMetadata(safe, 4096)).replace(/\n$/u, "");
  };
  if (!(await stat(git)).isDirectory()) {
    const value = await pointer(git);
    if (!value.startsWith("gitdir: "))
      throw new RepositoryInspectionError(
        "invalid_repository_path",
        "Git metadata pointer is invalid",
      );
    git = await check(resolve(dirname(git), value.slice(8)));
  }
  let common = git;
  try {
    common = await check(resolve(git, await pointer(resolve(git, "commondir"))));
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  let entries = 0;
  const deadline = performance.now() + 5_000;
  const inspectTree = async (directory: string, depth = 0): Promise<void> => {
    if (depth > 32 || performance.now() >= deadline)
      throw new RepositoryInspectionError(
        "invalid_repository_path",
        "Git metadata traversal exceeds its bound",
      );
    const stream = await opendir(directory);
    for await (const entry of stream) {
      if (++entries > 10_000 || performance.now() >= deadline)
        throw new RepositoryInspectionError(
          "invalid_repository_path",
          "Git metadata traversal exceeds its bound",
        );
      const child = resolve(directory, entry.name);
      const info = await lstat(child);
      if (info.isDirectory()) await inspectTree(child, depth + 1);
      else if (!info.isFile())
        throw new RepositoryInspectionError(
          "invalid_repository_path",
          "Git administrative trees contain unsupported links or file types",
        );
    }
  };
  for (const directory of new Set([git, common])) {
    for (const name of [
      "config",
      "config.worktree",
      "HEAD",
      "index",
      "packed-refs",
      "info",
      "info/attributes",
      "info/exclude",
      "shallow",
      "rebase-apply",
      "rebase-merge",
      "refs",
      "reftable",
      "objects",
      "objects/info",
      "objects/info/alternates",
      "objects/info/http-alternates",
    ]) {
      const candidate = resolve(directory, name);
      const info = await lstat(candidate).catch((error: unknown) => {
        if (isNotFound(error)) return undefined;
        throw error;
      });
      if (info === undefined) continue;
      if ((!info.isFile() && !info.isDirectory()) || name.endsWith("alternates"))
        throw new RepositoryInspectionError(
          "invalid_repository_path",
          "Git administrative links and object alternates require a separate integration",
        );
      if (
        info.isDirectory() &&
        ["refs", "objects", "reftable", "info", "rebase-apply", "rebase-merge"].includes(name)
      )
        await inspectTree(candidate);
      if (name === "config" || name === "config.worktree") {
        if (!info.isFile() || info.size > 65_536)
          throw new RepositoryInspectionError(
            "invalid_repository_path",
            "Git configuration exceeds the inspection bound",
          );
        const config = await readGitMetadata(candidate, 65_536);
        if (/^\s*\[\s*include(?:if)?(?:\s|\])/im.test(config))
          throw new RepositoryInspectionError(
            "invalid_repository_path",
            "Git config includes are outside the approved metadata contract",
          );
      }
    }
  }
}

/** Checks whether a path is inside or equal to the parent directory. */
export function containsPath(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return (
    pathFromParent === "" ||
    (pathFromParent !== ".." &&
      !pathFromParent.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromParent))
  );
}

/** Recognizes a missing filesystem entry without swallowing other failures. */
export function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Bound bytes on the same non-following descriptor that supplies the file type. */
export async function readGitMetadata(path: string, limit: number): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > limit)
      throw new RepositoryInspectionError(
        "invalid_repository_path",
        "Git metadata exceeds its file bound",
      );
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(limit + 1), 0, limit + 1, 0);
    if (bytesRead > limit)
      throw new RepositoryInspectionError(
        "invalid_repository_path",
        "Git metadata grew beyond its file bound",
      );
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}
