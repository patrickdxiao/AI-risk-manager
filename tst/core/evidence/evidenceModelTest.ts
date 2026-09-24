import { describe, expect, it } from "vitest";
import {
  createEvidenceItem,
  type CreateEvidenceItemInput,
  type EvidenceKind,
  type EvidenceSource,
} from "../../../src/core/evidence/evidenceModel.js";
import { DomainInvariantError, type PrivacyMode } from "../../../src/core/primitives.js";

const withoutRepository: CreateEvidenceItemInput = {
  id: "evidence-1",
  eventId: "capture-1",
  source: "git",
  kind: "worktree_change",
  occurredAt: "2026-09-24T12:00:00Z",
  locator: "git:web:worktree",
  summary: "Two paths changed",
  digest: "sha256:evidence",
  privacyMode: "metadata_only",
  metadata: { paths: ["src/a.ts"] },
};
const input = { ...withoutRepository, repositoryId: "web" };

describe("evidence records", () => {
  it("retains reusable repository evidence without a sprint or task assignment", () => {
    const metadata = { paths: ["src/a.ts"] };
    const evidence = createEvidenceItem({ ...input, metadata });
    metadata.paths.push("later-change");
    expect(evidence).toMatchObject({
      repositoryId: "web",
      occurredAt: "2026-09-24T12:00:00.000Z",
      metadata: { paths: ["src/a.ts"] },
    });
    for (const value of [evidence, evidence.metadata, evidence.metadata["paths"]])
      expect(Object.isFrozen(value)).toBe(true);
    for (const field of ["sprintId", "taskId", "projectId", "selectedContent"])
      expect(evidence).not.toHaveProperty(field);
  });

  it("allows non-repository evidence with optional sprint and task context", () => {
    const evidence = createEvidenceItem({
      ...withoutRepository,
      source: "user",
      kind: "agent_claim",
      sprintId: " sprint-1 ",
      taskId: " task-1 ",
    });
    expect(evidence).toMatchObject({ sprintId: "sprint-1", taskId: "task-1" });
    expect(evidence).not.toHaveProperty("repositoryId");
  });

  it.each([
    "repository_snapshot",
    "commit",
    "worktree_change",
    "branch_change",
    "upstream_relation",
  ] as const)("requires top-level repository provenance for %s, even during replay", (kind) => {
    expect(() =>
      createEvidenceItem({
        ...withoutRepository,
        source: "replay",
        kind,
        metadata: { repositoryId: "web" },
      }),
    ).toThrow(/requires repositoryId/u);
  });

  it("requires repository provenance for any Git-derived observation", () => {
    expect(() => createEvidenceItem({ ...withoutRepository, kind: "observed_failure" })).toThrow(
      /requires repositoryId/u,
    );
  });

  it("preserves selected source text exactly and freezes its disclosure marker", () => {
    const selectedContent = { text: "  const x = 1;\n", truncated: true };
    const evidence = createEvidenceItem({
      ...input,
      privacyMode: "selected_content",
      selectedContent,
    });
    selectedContent.text = "later";
    expect(evidence.selectedContent).toEqual({ text: "  const x = 1;\n", truncated: true });
    expect(Object.isFrozen(evidence.selectedContent)).toBe(true);
    expect(createEvidenceItem({ ...input, privacyMode: "selected_content" })).not.toHaveProperty(
      "selectedContent",
    );
  });

  it("rejects selected source text in metadata-only mode", () => {
    expect(() =>
      createEvidenceItem({ ...input, selectedContent: { text: "secret", truncated: false } }),
    ).toThrow(/metadata-only/u);
  });

  it.each([
    { text: " ", truncated: false },
    { text: "x".repeat(8_001), truncated: false },
    { text: ` ${"x".repeat(8_000)} `, truncated: false },
    { text: "valid", truncated: "false" as unknown as boolean },
  ])("rejects invalid selected content %#", (selectedContent) => {
    expect(() =>
      createEvidenceItem({ ...input, privacyMode: "selected_content", selectedContent }),
    ).toThrow(DomainInvariantError);
  });

  it.each([
    { id: " " },
    { eventId: "x".repeat(201) },
    { repositoryId: " " },
    { sprintId: "x".repeat(201) },
    { taskId: " " },
    { locator: "x".repeat(4_097) },
    { summary: " " },
    { digest: "x".repeat(513) },
    { occurredAt: "yesterday" },
    { source: "unknown" as EvidenceSource },
    { kind: "unknown" as EvidenceKind },
    { privacyMode: "anything" as PrivacyMode },
  ])("rejects invalid observation fields %#", (invalid) => {
    expect(() => createEvidenceItem({ ...input, ...invalid })).toThrow(DomainInvariantError);
  });
});
