import { describe, expect, it } from "vitest";
import {
  createFindingFeedback,
  type SubmitFindingFeedbackInput,
} from "../../../src/core/risk/findingFeedback.js";
import { GetSprintOverview } from "../../../src/core/risk/riskAssessment.js";
import { SubmitFindingFeedback } from "../../../src/core/risk/submitFindingFeedback.js";
import {
  before,
  evidence,
  finding,
  now,
  receipt,
  reviewedAt,
  riskFixture,
} from "../../fixtures/riskFixture.js";

const input: SubmitFindingFeedbackInput = {
  id: "feedback",
  findingId: "finding",
  kind: "resolve",
  actor: "developer",
  source: "dashboard",
};
function setup(
  seed: Parameters<typeof riskFixture>[0] = { receipts: [receipt("review", [finding()])] },
) {
  const fixture = riskFixture(seed);
  let time = now;
  return {
    ...fixture,
    submit: new SubmitFindingFeedback(fixture.store, fixture.ids, { now: () => time }),
    setNow(value: string) {
      time = value;
    },
  };
}

describe("saved finding feedback", () => {
  it("atomically hides and restores current risk without changing evidence, findings, receipts, or task completion", async () => {
    const original = finding();
    const submitted = receipt("review", [original]);
    const fixture = setup({ receipts: [submitted] });
    const tasks = fixture.tasks();
    expect(await fixture.submit.execute(input)).toMatchObject({
      status: "recorded",
      feedback: { id: input.id, createdAt: now },
    });
    expect(fixture.snapshots()).toMatchObject([
      { state: "uncertain", taskId: "task", sprintId: "sprint" },
    ]);
    expect(fixture.transitions()).toMatchObject([
      { from: null, to: "uncertain", cause: { type: "feedback", feedbackId: input.id } },
    ]);
    fixture.setNow("2026-09-24T03:00:00Z");
    await fixture.submit.execute({ ...input, id: "confirm", kind: "confirm" });
    expect(fixture.snapshots().at(-1)).toMatchObject({ state: "blocked", findingId: original.id });
    expect(fixture.transitions().at(-1)).toMatchObject({ from: "uncertain", to: "blocked" });
    expect(fixture.findings.get(original.id)).toBe(original);
    expect(fixture.observations.get(evidence.id)).toBe(evidence);
    expect(fixture.receipts).toEqual([submitted]);
    expect(fixture.tasks()).toEqual(tasks);
  });

  it("retries a caller-supplied ID with normalized semantic equality regardless of stored key order", async () => {
    const saved = createFindingFeedback({ ...input, createdAt: now });
    const reordered = {
      createdAt: saved.createdAt,
      source: saved.source,
      actor: saved.actor,
      kind: saved.kind,
      findingId: saved.findingId,
      id: saved.id,
    };
    const fixture = setup({ feedback: [reordered] });
    fixture.setNow("2099-01-01T00:00:00Z");
    expect(
      await fixture.submit.execute({ ...input, id: " feedback ", actor: " developer " }),
    ).toEqual({ status: "existing", feedback: reordered });
    expect(fixture.feedback()).toEqual([reordered]);
    expect(fixture.snapshots()).toEqual([]);
    await expect(fixture.submit.execute({ ...input, kind: "dismiss" })).rejects.toMatchObject({
      code: "finding_feedback_conflict",
    });
  });

  it("serializes concurrent retries into one action and one projection", async () => {
    const fixture = setup();
    const results = await Promise.all([
      fixture.submit.execute(input),
      fixture.submit.execute(input),
    ]);
    expect(results.map((result) => result.status)).toEqual(["recorded", "existing"]);
    expect(fixture.feedback()).toHaveLength(1);
    expect(fixture.snapshots()).toHaveLength(1);
  });

  it("ignores extra caller timestamps and records corrected wording without a false risk transition", async () => {
    const original = finding();
    const fixture = setup({
      receipts: [receipt("review", [original])],
      snapshots: [
        {
          id: "initial",
          sprintId: "sprint",
          taskId: "task",
          state: "blocked",
          findingId: original.id,
          createdAt: reviewedAt,
        },
      ],
    });
    const correction = {
      ...input,
      kind: "correct" as const,
      correction: { statement: " Wait for the consumer release " },
      note: " Checked locally ",
      createdAt: "2099-01-01T00:00:00Z",
    };
    expect(await fixture.submit.execute(correction)).toMatchObject({
      feedback: { createdAt: now, note: "Checked locally" },
    });
    expect(fixture.snapshots()).toHaveLength(2);
    expect(fixture.transitions()).toEqual([]);
    const overview = await new GetSprintOverview(fixture.store, { now: () => now }).execute(
      "sprint",
    );
    expect(overview.tasks[0]?.assessment).toMatchObject({
      statement: "Wait for the consumer release",
      finding: original,
      state: "blocked",
    });
    await expect(
      fixture.submit.execute({ ...correction, correction: { statement: "Another correction" } }),
    ).rejects.toMatchObject({ code: "finding_feedback_conflict" });
  });

  it("keeps feedback on superseded findings auditable without replacing newer risk", async () => {
    const old = finding("old");
    const current = finding("current", { state: "healthy" });
    const fixture = setup({
      receipts: [
        receipt("old-review", [old], { taskId: "task", completedAt: reviewedAt }),
        receipt("new-review", [current], { completedAt: now }),
      ],
    });
    await fixture.submit.execute({ ...input, findingId: old.id });
    expect(fixture.feedback()).toHaveLength(1);
    expect(fixture.snapshots()).toEqual([]);
    expect(fixture.transitions()).toEqual([]);
  });

  it("records feedback on historical findings without an applicable receipt", async () => {
    const fixture = setup({ findings: [finding()] });
    await fixture.submit.execute(input);
    expect(fixture.feedback()).toHaveLength(1);
    expect(fixture.snapshots()).toEqual([]);
  });

  it("updates a sprint-only projection independently from task risk", async () => {
    const sprintFinding = { ...finding() };
    delete sprintFinding.taskId;
    const fixture = setup({ receipts: [receipt("review", [sprintFinding, finding("task-risk")])] });
    await fixture.submit.execute(input);
    expect(fixture.snapshots()).toMatchObject([{ sprintId: "sprint", state: "uncertain" }]);
    expect(fixture.snapshots()[0]).not.toHaveProperty("taskId");
    const overview = await new GetSprintOverview(fixture.store, { now: () => now }).execute(
      "sprint",
    );
    expect(overview).toMatchObject({
      overallRisk: "blocked",
      sprintRisk: { state: "uncertain" },
      tasks: [{ riskState: "blocked" }],
    });
  });

  it("rolls back feedback and the snapshot if the transition insert fails", async () => {
    const fixture = setup();
    fixture.failTransitions(true);
    await expect(fixture.submit.execute(input)).rejects.toThrow("transition write failed");
    expect(fixture.feedback()).toEqual([]);
    expect(fixture.snapshots()).toEqual([]);
    fixture.failTransitions(false);
    expect(await fixture.submit.execute(input)).toMatchObject({ status: "recorded" });
  });

  it("rejects missing findings and regressing clocks before persisting feedback", async () => {
    const fixture = setup();
    await expect(fixture.submit.execute({ ...input, findingId: "missing" })).rejects.toMatchObject({
      code: "finding_not_found",
    });
    fixture.setNow(before);
    await expect(fixture.submit.execute(input)).rejects.toThrow("chronological");
    fixture.setNow(now);
    await fixture.submit.execute(input);
    fixture.setNow(reviewedAt);
    await expect(fixture.submit.execute({ ...input, id: "regressed" })).rejects.toThrow(
      "chronological",
    );
    expect(fixture.feedback()).toHaveLength(1);
  });
});
