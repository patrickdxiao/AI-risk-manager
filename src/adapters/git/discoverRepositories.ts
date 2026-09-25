import { lstat, opendir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  DomainInvariantError,
  requireInteger,
  type ClockPort,
  type IdGeneratorPort,
} from "../../core/primitives.js";
import type { UnitOfWorkPort } from "../../core/storageContracts.js";
import type {
  RepositoryInspectionPort,
  Repository,
} from "../../core/repository/repositoryModel.js";
import { RegisterRepository } from "../../core/repository/repositoryService.js";

export interface DiscoveryInput {
  readonly roots: readonly string[];
  /** Directory basenames omitted at every depth. */
  readonly exclusions?: readonly string[];
}
export interface DiscoveryResult {
  readonly repositories: readonly Repository[];
  readonly incomplete: boolean;
  readonly issues: readonly string[];
}
export interface DiscoveryLimits {
  readonly entries?: number;
  readonly depth?: number;
  readonly repositories?: number;
  readonly timeoutMs?: number;
}

/** Explicitly approved folders; registration retains identity, never an implicit project. */
export class DiscoverRepositories {
  private readonly register: RegisterRepository;
  private readonly limits: Required<DiscoveryLimits>;
  constructor(
    store: UnitOfWorkPort,
    inspector: RepositoryInspectionPort,
    ids: IdGeneratorPort,
    clock: ClockPort,
    private readonly stateDirectory: string,
    limits: DiscoveryLimits = {},
  ) {
    this.register = new RegisterRepository(store, inspector, ids, clock);
    this.limits = Object.freeze({
      entries: bound(limits.entries ?? 2_000, "entries", 2_000),
      depth: bound(limits.depth ?? 8, "depth", 8, 0),
      repositories: bound(limits.repositories ?? 50, "repositories", 50),
      timeoutMs: bound(limits.timeoutMs ?? 10_000, "timeoutMs", 10_000),
    });
  }
  /** Filesystem calls and one in-flight registration may finish after the scan deadline. */
  async execute(input: DiscoveryInput): Promise<DiscoveryResult> {
    if (
      !Array.isArray(input.roots) ||
      input.roots.length < 1 ||
      input.roots.length > 8 ||
      (input.exclusions?.length ?? 0) > 100
    )
      throw new DomainInvariantError(
        "out_of_range",
        "Approve between one and eight folders",
        "roots",
      );
    const roots = input.roots.map((root: string) => {
      if (root.trim() === "" || root.length > 4_096 || root.includes("\0"))
        throw new DomainInvariantError("invalid_value", "Invalid approved folder", "roots");
      return root;
    });
    const exclusions = (input.exclusions ?? []).map((name) => {
      if (name === "" || name.length > 255 || /[\\/\0]/u.test(name))
        throw new DomainInvariantError(
          "invalid_value",
          "Exclusions must be directory names",
          "exclusions",
        );
      return name;
    });
    const excluded = new Set([
      ".git",
      "node_modules",
      "vendor",
      "build",
      "dist",
      ".cache",
      ...exclusions,
    ]);
    const issues: string[] = [];
    const seen = new Set<string>();
    const repositories = new Map<string, Repository>();
    let incomplete = false;
    let entries = 0;
    const deadline = performance.now() + this.limits.timeoutMs;
    const exhausted = () =>
      entries >= this.limits.entries ||
      repositories.size >= this.limits.repositories ||
      performance.now() >= deadline;
    for (const inputRoot of roots) {
      if (exhausted()) {
        incomplete = true;
        break;
      }
      let root: string;
      try {
        if (!(await lstat(inputRoot)).isDirectory()) throw new Error("Not a directory");
        root = await realpath(inputRoot);
      } catch {
        issues.push(`Folder unavailable: ${inputRoot}`);
        incomplete = true;
        continue;
      }
      const pending = [{ path: root, depth: 0 }];
      while (pending.length > 0) {
        if (exhausted()) {
          incomplete = true;
          break;
        }
        const current = pending.shift();
        if (current === undefined) break;
        if (seen.has(current.path)) continue;
        seen.add(current.path);
        try {
          if (
            (await lstat(current.path)).isSymbolicLink() ||
            (await realpath(current.path)) !== current.path
          )
            throw new Error("Directory changed during discovery");
          const git = await lstat(join(current.path, ".git")).catch((error: unknown) => {
            if (error instanceof Error && "code" in error && error.code === "ENOENT")
              return undefined;
            throw error;
          });
          if (git !== undefined) {
            if (git.isSymbolicLink()) throw new Error("Git metadata is a link");
            const saved = await this.register.execute({
              path: current.path,
              approvedRoot: root,
              stateDirectory: this.stateDirectory,
            });
            repositories.set(saved.id, saved);
            continue;
          }
          const directory = await opendir(current.path);
          for await (const entry of directory) {
            entries += 1;
            if (exhausted()) {
              incomplete = true;
              break;
            }
            if (!entry.isDirectory() || entry.isSymbolicLink() || excluded.has(entry.name))
              continue;
            if (current.depth >= this.limits.depth) {
              incomplete = true;
              continue;
            }
            pending.push({ path: join(current.path, entry.name), depth: current.depth + 1 });
          }
        } catch {
          incomplete = true;
          issues.push(`Could not safely inspect: ${current.path}`);
        }
      }
    }
    return Object.freeze({
      repositories: Object.freeze([...repositories.values()]),
      incomplete,
      issues: Object.freeze(issues),
    });
  }
}
function bound(value: number, field: string, maximum: number, minimum = 1): number {
  requireInteger(value, field, minimum);
  if (value > maximum)
    throw new DomainInvariantError("out_of_range", `${field} exceeds its scan limit`, field);
  return value;
}
