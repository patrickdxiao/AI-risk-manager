import { describe, expect, it } from "vitest";
import type { EvidenceItem } from "../../../src/core/evidence/evidenceModel.js";
import {
  createFinding,
  createFindingEvidence,
  type CreateFindingInput,
  type RiskType,
} from "../../../src/core/investigation/findingModel.js";
import { DomainInvariantError, type RiskState } from "../../../src/core/primitives.js";

const evidence: EvidenceItem = {
  id: "evidence-1",
  eventId: "event-1",
  repositoryId: "payments",
  sprintId: "earlier-sprint",
  taskId: "dependency",
  source: "git",
  kind: "commit",
  occurredAt: "2026-09-23T08:00:00Z",
  locator: "git:commit:abc",
  summary: "The API changed its response type",
  digest: "sha256:abc",
  privacyMode: "metadata_only",
  metadata: {},
};
const permitted = new Map([[evidence.id, evidence]]);
const input = (): CreateFindingInput => ({
  id: "finding-1",
  investigationId: "review-1",
  sprintId: "sprint-1",
  taskId: "checkout",
  state: "at_risk",
  riskType: "dependency_blocker",
  confidence: 0.7,
  rationale: "The API response changed; client compatibility is unverified.",
  nextCheckCondition: "Inspect the client response handling",
  createdAt: "2026-09-24T08:00:00Z",
  evidenceCitations: [{ evidenceId: evidence.id }],
});

describe("finding validation", () => {
  it("accepts caller-permitted dependency evidence across sprint and task contexts", () => {
    const originalCitation = { evidenceId: evidence.id, note: " API contract change " };
    const citations = [originalCitation];
    const result = createFinding({ ...input(), evidenceCitations: citations }, permitted);
    originalCitation.note = "changed";
    expect(result.finding).toMatchObject({
      sprintId: "sprint-1",
      taskId: "checkout",
      state: "at_risk",
      confidence: 0.7,
    });
    expect(result.citations).toEqual([
      { findingId: "finding-1", evidenceId: evidence.id, note: "API contract change" },
    ]);
    for (const value of [
      result,
      result.finding,
      result.finding.missingEvidence,
      result.citations,
      result.citations[0],
    ])
      expect(Object.isFrozen(value)).toBe(true);
  });

  it("always binds citations to the new finding, ignoring an extra supplied finding ID", () => {
    const citations = [{ evidenceId: evidence.id, findingId: "another-finding" }];
    expect(
      createFinding({ ...input(), evidenceCitations: citations }, permitted).citations[0]
        ?.findingId,
    ).toBe("finding-1");
  });

  it("allows a cited healthy sprint assessment without a next check or task", () => {
    const healthy = { ...input() };
    delete healthy.taskId;
    delete healthy.riskType;
    delete healthy.nextCheckCondition;
    const result = createFinding({ ...healthy, state: "healthy", confidence: 1 }, permitted);
    expect(result.finding).toMatchObject({ state: "healthy", confidence: 1 });
    expect(result.finding).not.toHaveProperty("taskId");
  });

  it.each([
    { uncertainty: " Verification is unavailable " },
    { missingEvidence: [" Compatibility check "] },
  ])("allows an uncited uncertain result that records its evidence gap: %j", (gap) => {
    const result = createFinding(
      { ...input(), state: "uncertain", evidenceCitations: [], ...gap },
      new Map(),
    );
    expect(result.finding.state).toBe("uncertain");
    expect(result.citations).toEqual([]);
  });

  it("normalizes optional text and a timed next check", () => {
    const timed = { ...input() };
    delete timed.nextCheckCondition;
    const result = createFinding(
      {
        ...timed,
        nextCheckAt: "2026-09-24T09:00:00Z",
        uncertainty: " Verify the client ",
        recommendedUserAction: " Check the contract ",
        missingEvidence: [" Integration check "],
      },
      permitted,
    );
    expect(result.finding).toMatchObject({
      nextCheckAt: "2026-09-24T09:00:00.000Z",
      uncertainty: "Verify the client",
      recommendedUserAction: "Check the contract",
      missingEvidence: ["Integration check"],
    });
  });

  it.each(["healthy", "uncertain", "at_risk", "blocked"] as const)(
    "rejects an unsupported uncited %s conclusion",
    (state) => {
      expect(() => createFinding({ ...input(), state, evidenceCitations: [] }, new Map())).toThrow(
        DomainInvariantError,
      );
    },
  );

  it.each(["at_risk", "blocked"] as const)("requires a risk type for %s", (state) => {
    const untyped = { ...input() };
    delete untyped.riskType;
    expect(() => createFinding({ ...untyped, state }, permitted)).toThrow(DomainInvariantError);
  });

  it("requires a next check for non-healthy results and rejects checks before the finding", () => {
    const noCheck = { ...input() };
    delete noCheck.nextCheckCondition;
    expect(() => createFinding(noCheck, permitted)).toThrow(DomainInvariantError);
    expect(() =>
      createFinding({ ...input(), nextCheckAt: "2026-09-23T08:00:00Z" }, permitted),
    ).toThrow(DomainInvariantError);
  });

  it("rejects unavailable, misidentified, and duplicate citations after normalization", () => {
    expect(() => createFinding(input(), new Map())).toThrow(DomainInvariantError);
    expect(() =>
      createFinding(input(), new Map([[evidence.id, { ...evidence, id: "other" }]])),
    ).toThrow(DomainInvariantError);
    expect(() =>
      createFinding(
        {
          ...input(),
          evidenceCitations: [{ evidenceId: evidence.id }, { evidenceId: ` ${evidence.id} ` }],
        },
        permitted,
      ),
    ).toThrow(DomainInvariantError);
  });

  it.each<Partial<CreateFindingInput>>([
    { state: "unknown" as RiskState },
    { riskType: "unknown" as RiskType },
    { confidence: -0.1 },
    { confidence: 1.1 },
    { confidence: Number.NaN },
    { id: " " },
    { rationale: " " },
    { rationale: "x".repeat(8_001) },
    { uncertainty: "x".repeat(4_001) },
    { recommendedUserAction: " " },
    { nextCheckCondition: " " },
    { missingEvidence: Array.from({ length: 51 }, () => "missing") },
    { evidenceCitations: Array.from({ length: 101 }, () => ({ evidenceId: evidence.id })) },
    { evidenceCitations: [{ evidenceId: evidence.id, note: "x".repeat(2_001) }] },
  ])("rejects invalid bounded finding data: %j", (invalid) => {
    expect(() => createFinding({ ...input(), ...invalid }, permitted)).toThrow(
      DomainInvariantError,
    );
  });

  it("normalizes standalone citations and rejects blank notes", () => {
    expect(createFindingEvidence({ findingId: " finding ", evidenceId: " evidence " })).toEqual({
      findingId: "finding",
      evidenceId: "evidence",
    });
    expect(() =>
      createFindingEvidence({ findingId: "finding", evidenceId: "evidence", note: " " }),
    ).toThrow(DomainInvariantError);
  });
});
