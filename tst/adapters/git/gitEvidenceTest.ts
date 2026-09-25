import { describe, expect, it, vi } from "vitest";
import type {
  DerivedGitEvidenceKind,
  GitEvidenceIdFactory,
} from "../../../src/adapters/git/gitEvidence.js";
import {
  deriveGitEvidence,
  GIT_EVIDENCE_PATH_LIMIT,
} from "../../../src/adapters/git/gitEvidence.js";
import type {
  RepositoryInspection,
  RepositoryStatusPath,
  RepositoryStatusSummary,
} from "../../../src/adapters/git/inspectRepository.js";

describe("derive-git-evidence", () => {
  const OBSERVED_AT = "2026-08-31T18:00:00.000Z";
  const OLD_HEAD = "a".repeat(40);
  const NEW_HEAD = "b".repeat(40);

  function ids(): GitEvidenceIdFactory {
    return {
      next: (kind) => ({ eventId: `${kind}-event`, evidenceItemId: `${kind}-item` }),
    };
  }

  function status(paths: readonly RepositoryStatusPath[] = []): RepositoryStatusSummary {
    return {
      clean: paths.length === 0,
      stagedCount: paths.filter((path) => path.staged).length,
      unstagedCount: paths.filter((path) => path.unstaged).length,
      untrackedCount: paths.filter((path) => path.untracked).length,
      totalPathCount: paths.length,
      paths,
      pathsTruncated: false,
    };
  }

  function snapshot(overrides: Partial<RepositoryInspection> = {}): RepositoryInspection {
    return {
      rootPath: "/private/project",
      head: OLD_HEAD,
      branch: "main",
      detached: false,
      status: status(),
      snapshotDigest: "snapshot-old",
      ...overrides,
    };
  }

  function derive(
    current: RepositoryInspection,
    previous?: RepositoryInspection,
    idFactory: GitEvidenceIdFactory = ids(),
  ) {
    return deriveGitEvidence({
      ...(previous === undefined ? {} : { previous }),
      current,
      repositoryId: "repository-1",
      observedAt: OBSERVED_AT,
      idFactory,
    });
  }

  describe("deriveGitEvidence", () => {
    it("derives one immutable metadata-only initial snapshot", () => {
      const [item] = derive(snapshot());
      expect(item).toMatchObject({
        id: "repository_snapshot-item",
        eventId: "repository_snapshot-event",
        source: "git",
        kind: "repository_snapshot",
        occurredAt: OBSERVED_AT,
        locator: "git:repository-1",
        privacyMode: "metadata_only",
        metadata: {
          repositoryId: "repository-1",
          head: OLD_HEAD,
          branch: "main",
          detached: false,
        },
      });
      expect(item?.selectedContent).toBeUndefined();
      expect(item?.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(Object.isFrozen(item)).toBe(true);
    });

    it("coalesces an identical snapshot without allocating IDs", () => {
      const next = vi.fn<GitEvidenceIdFactory["next"]>();
      const current = snapshot();
      expect(derive(current, snapshot(), { next })).toEqual([]);
      expect(next).not.toHaveBeenCalled();
    });

    it.each<{
      name: string;
      previous: RepositoryInspection;
      current: RepositoryInspection;
      expected: DerivedGitEvidenceKind;
    }>([
      {
        name: "HEAD",
        previous: snapshot(),
        current: snapshot({ head: NEW_HEAD, snapshotDigest: "head-new" }),
        expected: "commit",
      },
      {
        name: "branch",
        previous: snapshot(),
        current: snapshot({ branch: "feature/risk", snapshotDigest: "branch-new" }),
        expected: "branch_change",
      },
      {
        name: "worktree",
        previous: snapshot(),
        current: snapshot({
          status: status([
            { path: "src/index.ts", staged: false, unstaged: true, untracked: false },
          ]),
          snapshotDigest: "worktree-new",
        }),
        expected: "worktree_change",
      },
    ])("derives a $expected event for a $name delta", ({ previous, current, expected }) => {
      const events = derive(current, previous);
      expect(events.map((event) => event.kind)).toEqual([expected]);
    });

    it("orders simultaneous commit, branch, and worktree events deterministically", () => {
      const previous = snapshot();
      const current = snapshot({
        head: NEW_HEAD,
        branch: null,
        detached: true,
        status: status([{ path: "new.ts", staged: true, unstaged: false, untracked: false }]),
        snapshotDigest: "everything-new",
      });
      expect(derive(current, previous).map((event) => event.kind)).toEqual([
        "commit",
        "branch_change",
        "worktree_change",
      ]);
    });

    it("stores only diff-free metadata and never the absolute root or file content", () => {
      const fileBody = "PRIVATE SOURCE BODY";
      const [item] = derive(
        snapshot({
          status: status([
            { path: "src/private.ts", staged: false, unstaged: false, untracked: true },
          ]),
        }),
      );
      const serialized = JSON.stringify(item);
      expect(serialized).not.toContain("/private/project");
      expect(serialized).not.toContain(fileBody);
      expect(serialized).not.toContain("diff");
      expect(item?.privacyMode).toBe("metadata_only");
      expect(item?.selectedContent).toBeUndefined();
    });

    it("sorts and caps root-relative paths while marking truncation", () => {
      const paths = Array.from({ length: GIT_EVIDENCE_PATH_LIMIT + 5 }, (_, index) => ({
        path: `src/file-${String(GIT_EVIDENCE_PATH_LIMIT + 5 - index).padStart(3, "0")}.ts`,
        staged: false,
        unstaged: true,
        untracked: false,
      }));
      const [item] = derive(snapshot({ status: status(paths) }));
      expect(item?.metadata).toMatchObject({
        status: {
          paths: [...paths].sort((left, right) => left.path.localeCompare(right.path)).slice(0, 50),
          pathsTruncated: true,
          totalPathCount: GIT_EVIDENCE_PATH_LIMIT + 5,
        },
      });
    });

    it("validates snapshot scope, identifiers, time, and relative paths", () => {
      expectErrorCode(
        () => derive(snapshot({ rootPath: "/other" }), snapshot()),
        "snapshot_scope_mismatch",
      );
      expectErrorCode(
        () =>
          deriveGitEvidence({
            current: snapshot(),
            repositoryId: " repository-1",
            observedAt: OBSERVED_AT,
            idFactory: ids(),
          }),
        "invalid_identifier",
      );
      expect(() =>
        deriveGitEvidence({
          current: snapshot(),
          repositoryId: "repository-1",
          observedAt: "not-a-time",
          idFactory: ids(),
        }),
      ).toThrow();
      expectErrorCode(
        () =>
          derive(
            snapshot({
              status: status([
                { path: "../secret", staged: true, unstaged: false, untracked: false },
              ]),
            }),
          ),
        "invalid_status_path",
      );
      expectErrorCode(
        () =>
          derive(snapshot(), undefined, {
            next: () => ({ eventId: "", evidenceItemId: "item" }),
          }),
        "invalid_identifier",
      );
    });

    it("produces the same normalized metadata and digest for equivalent input", () => {
      const left = snapshot({
        status: status([
          { path: "src/b.ts", staged: true, unstaged: false, untracked: false },
          { path: "src/a.ts", staged: false, unstaged: true, untracked: false },
        ]),
      });
      const right = snapshot({ status: status([...left.status.paths].reverse()) });
      const [first] = derive(left);
      const [second] = derive(right);
      expect(second).toEqual(first);
    });
  });

  function expectErrorCode(action: () => unknown, code: string): void {
    try {
      action();
    } catch (error) {
      expect(error).toMatchObject({ code });
      return;
    }
    throw new Error(`expected error ${code}`);
  }
});
