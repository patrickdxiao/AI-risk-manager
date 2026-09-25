import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertLocalStateOutsideRepositories,
  ensureLocalStateDirectory,
  ensureLocalToken,
  LOCAL_TOKEN_FILE,
} from "../../src/api/apiToken.js";

describe("local-token", () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });
  async function temporaryDirectory(prefix: string) {
    const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
    directories.push(directory);
    return directory;
  }

  async function temporaryStateDir(): Promise<string> {
    const parent = await temporaryDirectory("development-risk-api-");
    return join(parent, "state");
  }

  it("allows a private state directory beneath a non-repository working directory", async () => {
    const parent = await temporaryDirectory("risk-non-repository-");
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(parent);
    try {
      await expect(ensureLocalToken(join(parent, "state"))).resolves.toMatch(/^[A-Za-z0-9_-]{43}$/);
    } finally {
      cwd.mockRestore();
    }
  });

  it("rejects an oversized token with a bounded read", async () => {
    const directory = await temporaryStateDir();
    await mkdir(directory, { mode: 0o700 });
    await writeFile(join(directory, LOCAL_TOKEN_FILE), "x".repeat(257), { mode: 0o600 });
    await expect(ensureLocalToken(directory)).rejects.toMatchObject({
      code: "token_file_malformed",
    });
  });

  it("rejects a FIFO credential without waiting for a writer", async () => {
    if (process.platform === "win32") return;
    const directory = await temporaryStateDir();
    await mkdir(directory, { mode: 0o700 });
    execFileSync("mkfifo", [join(directory, LOCAL_TOKEN_FILE)]);
    await expect(ensureLocalToken(directory)).rejects.toMatchObject({
      code: "token_file_not_regular",
    });
  });

  it("rejects state beneath any registered repository or its canonical alias", async () => {
    const repository = await temporaryDirectory("risk-repository-");
    await expect(
      assertLocalStateOutsideRepositories(join(repository, "state"), [repository]),
    ).rejects.toMatchObject({ code: "state_directory_inside_repository" });
    const outside = await temporaryDirectory("risk-private-state-");
    await expect(
      assertLocalStateOutsideRepositories(outside, [repository, join(repository, "missing")]),
    ).resolves.toBeUndefined();
    if (process.platform !== "win32") {
      const alias = join(outside, "alias");
      await symlink(repository, alias, "dir");
      await expect(
        assertLocalStateOutsideRepositories(join(repository, "state"), [alias]),
      ).rejects.toMatchObject({ code: "state_directory_inside_repository" });
    }
  });

  describe("ensureLocalToken", () => {
    it.each(["..state", "...", "..state/nested"])(
      "rejects repository-local %s directories before creating them",
      async (name) => {
        const repository = await temporaryDirectory("development-risk-state-containment-");
        await mkdir(join(repository, ".git"));
        const cwd = vi.spyOn(process, "cwd").mockReturnValue(repository);
        const stateDir = join(repository, name);
        try {
          await expect(ensureLocalStateDirectory(stateDir)).rejects.toMatchObject({
            code: "state_directory_inside_repository",
          });
          await expect(lstat(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
        } finally {
          cwd.mockRestore();
        }
      },
    );
    it("creates private state and token files, then reuses the token", async () => {
      const stateDir = await temporaryStateDir();
      const first = await ensureLocalToken(stateDir);
      const second = await ensureLocalToken(stateDir);

      expect(second).toBe(first);
      expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect((await readFile(join(stateDir, LOCAL_TOKEN_FILE), "utf8")).trim()).toBe(first);
      if (process.platform !== "win32") {
        expect((await lstat(stateDir)).mode & 0o777).toBe(0o700);
        expect((await lstat(join(stateDir, LOCAL_TOKEN_FILE))).mode & 0o777).toBe(0o600);
      }
    });

    it("publishes one token when starters race", async () => {
      const stateDir = await temporaryStateDir();
      const tokens = await Promise.all(
        Array.from({ length: 8 }, async () => ensureLocalToken(stateDir)),
      );
      expect(new Set(tokens)).toEqual(new Set([tokens[0]]));
    });

    it("rejects malformed, insecure, and symbolic-link token files without leaking content", async () => {
      const malformedDir = await temporaryStateDir();
      await mkdir(malformedDir, { recursive: true, mode: 0o700 });
      const malformedPath = join(malformedDir, LOCAL_TOKEN_FILE);
      await writeFile(malformedPath, "secret-that-must-not-leak\n", { mode: 0o600 });
      await expect(ensureLocalToken(malformedDir)).rejects.toMatchObject({
        code: "token_file_malformed",
      });
      await expect(ensureLocalToken(malformedDir)).rejects.not.toThrow("secret-that-must-not-leak");

      if (process.platform !== "win32") {
        await chmod(malformedPath, 0o644);
        await expect(ensureLocalToken(malformedDir)).rejects.toMatchObject({
          code: "token_file_not_private",
        });

        const linkedDir = await temporaryStateDir();
        await mkdir(linkedDir, { recursive: true, mode: 0o700 });
        await symlink(malformedPath, join(linkedDir, LOCAL_TOKEN_FILE));
        await expect(ensureLocalToken(linkedDir)).rejects.toMatchObject({
          code: "token_file_not_regular",
        });
      }
    });

    it.each(["short", ` ${"a".repeat(43)}`, `${"a".repeat(42)}!`])(
      "rejects invalid token content %j",
      async (content) => {
        const stateDir = await temporaryStateDir();
        await mkdir(stateDir, { recursive: true, mode: 0o700 });
        await writeFile(join(stateDir, LOCAL_TOKEN_FILE), `${content}\n`, { mode: 0o600 });
        await expect(ensureLocalToken(stateDir)).rejects.toMatchObject({
          code: "token_file_malformed",
        });
      },
    );

    it("rejects repository-local and insecure state directories", async () => {
      await expect(
        ensureLocalToken(join(process.cwd(), ".api-state-not-created")),
      ).rejects.toMatchObject({ code: "state_directory_inside_repository" });

      if (process.platform !== "win32") {
        const stateDir = await temporaryStateDir();
        await mkdir(stateDir, { recursive: true, mode: 0o700 });
        await chmod(stateDir, 0o755);
        await expect(ensureLocalToken(stateDir)).rejects.toMatchObject({
          code: "state_directory_not_private",
        });
      }
    });

    it("rejects a symbolic-link state directory", async () => {
      if (process.platform === "win32") return;
      const target = await temporaryStateDir();
      await mkdir(target, { recursive: true, mode: 0o700 });
      const linkedState = await temporaryStateDir();
      await symlink(target, linkedState);
      await expect(ensureLocalToken(linkedState)).rejects.toMatchObject({
        code: "state_directory_not_directory",
      });
    });

    it("rejects an ancestor symlink that resolves into the repository", async () => {
      if (process.platform === "win32") return;
      const parent = await temporaryDirectory("development-risk-state-link-");
      const repositoryLink = join(parent, "repository-link");
      await symlink(process.cwd(), repositoryLink, "dir");

      await expect(ensureLocalToken(join(repositoryLink, "state"))).rejects.toMatchObject({
        code: "state_directory_inside_repository",
      });
    });

    it("rejects when an atomically published token vanishes before verification", async () => {
      vi.resetModules();
      const actual = await import("node:fs/promises");
      let tokenReads = 0;
      vi.doMock("node:fs/promises", () => ({
        ...actual,
        open: async (...args: Parameters<typeof actual.open>) => {
          const path = args[0];
          if (String(path).endsWith(`/${LOCAL_TOKEN_FILE}`)) {
            tokenReads += 1;
            if (tokenReads === 2) {
              throw Object.assign(new Error("simulated disappearance"), { code: "ENOENT" });
            }
          }
          return actual.open(...args);
        },
      }));
      try {
        const isolated = await import("../../src/api/apiToken.js");
        await expect(isolated.ensureLocalToken(await temporaryStateDir())).rejects.toMatchObject({
          code: "token_file_malformed",
        });
      } finally {
        vi.doUnmock("node:fs/promises");
        vi.resetModules();
      }
    });
  });
});
