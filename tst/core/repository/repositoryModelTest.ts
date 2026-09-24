import { describe, expect, it } from "vitest";
import { DomainInvariantError } from "../../../src/core/primitives.js";
import {
  createRepository,
  RepositoryInspectionError,
  RepositoryObservationCaptureError,
} from "../../../src/core/repository/repositoryModel.js";

const input = {
  id: "web",
  canonicalPath: "/approved/web",
  gitRoot: "/approved/web",
  identityDigest: "identity-digest",
  registeredAt: "2026-09-24T12:00:00Z",
};

describe("registered repository identity", () => {
  it("creates an immutable identity independently of sprint and project grouping", () => {
    const repository = createRepository({ ...input, id: " web ", approvedRoot: "/approved" });
    expect(repository).toEqual({
      ...input,
      approvedRoot: "/approved",
      registeredAt: "2026-09-24T12:00:00.000Z",
    });
    expect(Object.isFrozen(repository)).toBe(true);
    expect(createRepository(input)).not.toHaveProperty("approvedRoot");
  });

  it.each([
    { id: " " },
    { id: "x".repeat(201) },
    { canonicalPath: " " },
    { canonicalPath: "x".repeat(4_097) },
    { canonicalPath: `/${"x".repeat(4_095)} ` },
    { canonicalPath: "/approved/web\0" },
    { gitRoot: " " },
    { identityDigest: " " },
    { identityDigest: "x".repeat(513) },
    { approvedRoot: " " },
    { approvedRoot: "x".repeat(4_097) },
    { registeredAt: "yesterday" },
  ])("rejects malformed registered fields %#", (invalid) => {
    expect(() => createRepository({ ...input, ...invalid })).toThrow(DomainInvariantError);
  });

  it("preserves spaces in inspected paths instead of changing repository identity", () => {
    const path = "/approved/web ";
    expect(
      createRepository({
        ...input,
        canonicalPath: path,
        gitRoot: path,
        approvedRoot: "/approved ",
      }),
    ).toMatchObject({ canonicalPath: path, gitRoot: path, approvedRoot: "/approved " });
    expect(() => createRepository({ ...input, gitRoot: `${input.gitRoot} ` })).toThrow(
      /same worktree root/u,
    );
  });

  it("rejects an identity whose stored canonical and Git roots disagree", () => {
    expect(() => createRepository({ ...input, gitRoot: "/approved/other" })).toThrow(
      /same worktree root/u,
    );
  });
});

describe("repository adapter errors", () => {
  it.each([
    "invalid_repository_path",
    "not_git_repository",
    "state_directory_inside_repository",
  ] as const)("retains inspection code %s with an optional underlying cause", (code) => {
    const cause = new Error("unavailable");
    expect(new RepositoryInspectionError(code, "Inspection failed", cause)).toMatchObject({
      name: "RepositoryInspectionError",
      code,
      message: "Inspection failed",
      cause,
    });
    expect(new RepositoryInspectionError(code, "Inspection failed").cause).toBeUndefined();
  });

  it("retains a capture failure message with a stable default", () => {
    expect(new RepositoryObservationCaptureError()).toMatchObject({
      name: "RepositoryObservationCaptureError",
      message: "repository observation failed",
    });
    expect(new RepositoryObservationCaptureError("Unavailable").message).toBe("Unavailable");
  });
});
