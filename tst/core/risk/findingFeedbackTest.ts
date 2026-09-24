import { describe, expect, it } from "vitest";
import {
  createFindingFeedback,
  type FindingFeedback,
} from "../../../src/core/risk/findingFeedback.js";
import { DomainInvariantError } from "../../../src/core/primitives.js";

const input: FindingFeedback = {
  id: "feedback-1",
  findingId: "finding-1",
  kind: "confirm",
  actor: "developer",
  source: "dashboard",
  createdAt: "2026-09-24T08:00:00Z",
};

describe("finding feedback validation", () => {
  it.each(["confirm", "dismiss", "resolve"] as const)("records an immutable %s action", (kind) => {
    const result = createFindingFeedback({ ...input, kind });
    expect(result).toMatchObject({ kind, createdAt: "2026-09-24T08:00:00.000Z" });
    expect(result).not.toHaveProperty("correction");
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("copies and normalizes corrective feedback", () => {
    const correction = { statement: " The dependency has shipped " };
    const result = createFindingFeedback({
      ...input,
      kind: "correct",
      correction,
      note: " Confirmed locally ",
    });
    correction.statement = "changed";
    expect(result).toMatchObject({
      correction: { statement: "The dependency has shipped" },
      note: "Confirmed locally",
    });
    expect(Object.isFrozen(result.correction)).toBe(true);
  });

  it.each<Partial<FindingFeedback>>([
    { kind: "unknown" as FindingFeedback["kind"] },
    { kind: "correct" },
    { correction: { statement: "Not a correction action" } },
    { kind: "correct", correction: { statement: " " } },
    { kind: "correct", correction: { statement: "x".repeat(8_001) } },
    { id: " " },
    { findingId: "x".repeat(201) },
    { actor: " " },
    { source: "x".repeat(201) },
    { note: "x".repeat(4_001) },
    { createdAt: "2026-02-30T08:00:00Z" },
  ])("rejects inconsistent or invalid feedback: %j", (invalid) => {
    expect(() => createFindingFeedback({ ...input, ...invalid })).toThrow(DomainInvariantError);
  });
});
