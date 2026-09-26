import { describe, expect, it } from "vitest";
import { transitionTaskState } from "../../../src/core/planning/planningModel.js";
import { createFindingFeedback } from "../../../src/core/risk/findingFeedback.js";
import {
  createRiskAssessmentRecords,
  GetSprintOverview,
  readCurrentFindings,
  readCurrentRiskAssessment,
} from "../../../src/core/risk/riskAssessment.js";
import {
  before,
  evidence,
  finding,
  now,
  receipt,
  reviewedAt,
  riskFixture,
  sprint,
  task,
} from "../../fixtures/riskFixture.js";

async function read(fixture: ReturnType<typeof riskFixture>, taskId?: string) {
  return fixture.store.execute(async (context) =>
    readCurrentRiskAssessment(context, await readCurrentFindings(context, "sprint", taskId)),
  );
}

describe("current cited assessments", () => {
  it("leaves work with no receipt unassessed instead of healthy", async () => {
    expect(await read(riskFixture(), "task")).toBeUndefined();
  });

  it("selects newer applicable sprint and task receipts with stable ID ties", async () => {
    const prior = finding("prior");
    const current = finding("current", { state: "healthy" });
    const fixture = riskFixture({
      receipts: [receipt("a", [prior], { taskId: "task" }), receipt("z", [current])],
    });
    expect(await read(fixture, "task")).toMatchObject({
      finding: current,
      state: "healthy",
      evidenceIds: [evidence.id],
    });
    fixture.receipts.push(receipt("b", [prior], { taskId: "task", completedAt: now }));
    expect(await read(fixture, "task")).toMatchObject({ finding: prior });
    fixture.receipts.push(
      receipt("new-sprint", [finding("other", { taskId: "other" })], { completedAt: now }),
    );
    expect(await read(fixture, "task")).toMatchObject({ finding: prior });
  });

  it("keeps sprint-only findings separate from task findings", async () => {
    const sprintFinding = { ...finding("sprint-finding", { state: "healthy" }) };
    delete sprintFinding.taskId;
    const fixture = riskFixture({
      receipts: [receipt("sprint-review", [sprintFinding, finding()])],
    });
    expect(await read(fixture)).toMatchObject({ state: "healthy", finding: sprintFinding });
    expect(await read(fixture, "task")).toMatchObject({ state: "blocked" });
  });

  it("shows corrected wording without rewriting findings or citations", async () => {
    const original = finding();
    const correction = createFindingFeedback({
      id: "correction",
      findingId: original.id,
      kind: "correct",
      correction: { statement: "The API is available; the consumer is pending" },
      actor: "developer",
      source: "dashboard",
      createdAt: now,
    });
    const fixture = riskFixture({
      receipts: [receipt("review", [original])],
      feedback: [correction],
    });
    expect(await read(fixture, "task")).toMatchObject({
      state: "blocked",
      finding: original,
      statement: correction.correction?.statement,
      feedback: correction,
      assessedAt: now,
      evidenceIds: [evidence.id],
    });
    expect(original.rationale).toBe("Waiting for the API");
  });

  it("preserves accepted dependency citations across sprint/task contexts", async () => {
    const fixture = riskFixture({
      receipts: [receipt("review", [finding()])],
      evidence: [{ ...evidence, sprintId: "prior-sprint", taskId: "dependency" }],
    });
    expect(await read(fixture, "task")).toMatchObject({
      evidenceIds: [evidence.id],
      unavailableEvidenceIds: [],
    });
  });

  it.each(["missing", "wrong-id", "unregistered", "metadata-only-origin"])(
    "makes %s support visible and cannot certify health",
    async (mode) => {
      const healthy = finding("healthy", { state: "healthy" });
      const fixture = riskFixture({
        receipts: [receipt("review", [healthy])],
        ...(mode === "unregistered" ? { repositories: [] } : {}),
      });
      if (mode === "missing") fixture.observations.delete(evidence.id);
      if (mode === "wrong-id") fixture.observations.set(evidence.id, { ...evidence, id: "other" });
      if (mode === "metadata-only-origin") {
        const unattributed = { ...evidence };
        delete unattributed.repositoryId;
        fixture.observations.set(evidence.id, {
          ...unattributed,
          metadata: { repositoryId: "repo" },
        });
      }
      expect(await read(fixture, "task")).toMatchObject({
        state: "uncertain",
        finding: healthy,
        evidenceIds: [],
        unavailableEvidenceIds: [evidence.id],
      });
      fixture.receipts.push(receipt("later", [finding("blocked")], { completedAt: now }));
      expect(await read(fixture, "task")).toMatchObject({
        state: "blocked",
        unavailableEvidenceIds: [evidence.id],
      });
    },
  );

  it("reads plan-only evidence and uses only the displayed finding's exact citations", async () => {
    const planEvidence = { ...evidence };
    delete planEvidence.repositoryId;
    const original = receipt("review", [finding()]);
    const fixture = riskFixture({
      evidence: [
        {
          ...planEvidence,
          source: "user",
          kind: "task_state_change",
          sprintId: "sprint",
          taskId: "task",
        },
      ],
      receipts: [
        {
          ...original,
          citations: [
            ...original.citations,
            ...original.citations,
            { findingId: "other-finding", evidenceId: "unknown" },
          ],
        },
      ],
    });
    expect(await read(fixture, "task")).toMatchObject({
      evidenceIds: [evidence.id],
      unavailableEvidenceIds: [],
    });
  });
});

describe("sprint overview", () => {
  it("retains earlier unfinished work, omits future and archived work, and ranks dependencies before deadlines", async () => {
    const savedTasks = [
      task("dependent", { dependencyIds: ["dependency"], endAt: "2026-09-25T00:00:00Z" }),
      task("dependency"),
      task("old", { sprintId: "prior" }),
      task("archived", { sprintId: "prior", state: "done" }),
      task("future", { sprintId: "future" }),
      task("done", { state: "done" }),
    ];
    const fixture = riskFixture({
      sprints: [
        sprint(),
        sprint("prior", { startAt: before, state: "completed" }),
        sprint("future", { startAt: "2026-09-25T00:00:00Z" }),
      ],
      tasks: savedTasks,
      receipts: [
        receipt("old-review", [finding("old-blocker", { sprintId: "prior", taskId: "old" })], {
          sprintId: "prior",
        }),
      ],
    });
    const overview = await new GetSprintOverview(fixture.store, { now: () => now }).execute(
      " sprint ",
    );
    expect(overview.tasks.map((row) => row.id)).toEqual(["old", "dependency", "dependent", "done"]);
    expect(overview).toMatchObject({
      overallRisk: "blocked",
      totalPoints: 12,
      confirmedDonePoints: 3,
      generatedAt: now,
    });
    expect(overview.tasks.find((row) => row.id === "dependency")).not.toHaveProperty("assessment");
    for (const row of overview.tasks)
      for (const to of row.allowedUserTransitions)
        expect(transitionTaskState(row, { actor: "user", to, occurredAt: now }).task.state).toBe(
          to,
        );
    expect(Object.isFrozen(overview.tasks)).toBe(true);
    expect(fixture.tasks()).toEqual(savedTasks);
  });

  it("retains unfinished work when sprint dates overlap or the new active sprint was backdated", async () => {
    const fixture = riskFixture({
      sprints: [
        sprint(),
        sprint("same-dates"),
        sprint("closed", { startAt: "2026-09-25T00:00:00Z", state: "completed" }),
      ],
      tasks: [
        task(),
        task("same-dates-task", { sprintId: "same-dates" }),
        task("closed-task", { sprintId: "closed" }),
      ],
    });
    const overview = await new GetSprintOverview(fixture.store, { now: () => now }).execute(
      "sprint",
    );
    expect(overview.tasks.map((row) => row.id)).toEqual(["closed-task", "same-dates-task", "task"]);
  });

  it("does not invent a sprint-only uncertainty when all reviewed tasks are healthy", async () => {
    const fixture = riskFixture({
      receipts: [receipt("review", [finding("healthy", { state: "healthy" })])],
    });
    const overview = await new GetSprintOverview(fixture.store, { now: () => now }).execute(
      "sprint",
    );
    expect(overview.overallRisk).toBe("healthy");
    expect(overview).not.toHaveProperty("sprintRisk");
  });

  it("keeps unexamined tasks uncertain even when the sprint-only finding is healthy", async () => {
    const sprintFinding = { ...finding("sprint-healthy", { state: "healthy" }) };
    delete sprintFinding.taskId;
    const fixture = riskFixture({ receipts: [receipt("review", [sprintFinding])] });
    expect(
      await new GetSprintOverview(fixture.store, { now: () => now }).execute("sprint"),
    ).toMatchObject({
      sprintRisk: { state: "healthy" },
      overallRisk: "uncertain",
      tasks: [{ riskState: "uncertain" }],
    });
  });

  it.each(["ended", "closed"])(
    "archives completed tasks in an %s sprint but keeps unfinished tasks",
    async (mode) => {
      const fixture = riskFixture({
        sprints: [sprint("sprint", mode === "closed" ? { state: "completed" } : {})],
        tasks: [task(), task("done", { state: "done" })],
      });
      const overview = await new GetSprintOverview(fixture.store, {
        now: () => (mode === "ended" ? "2026-10-01T00:00:00Z" : now),
      }).execute("sprint");
      expect(overview.tasks.map((row) => row.id)).toEqual(["task"]);
      expect(overview.confirmedDonePoints).toBe(3);
      expect(overview.totalPoints).toBe(6);
    },
  );

  it("returns unknown for an empty sprint and identifies a missing sprint", async () => {
    const fixture = riskFixture({ tasks: [] });
    const overview = new GetSprintOverview(fixture.store, { now: () => now });
    expect(await overview.execute("sprint")).toMatchObject({
      tasks: [],
      totalPoints: 0,
      overallRisk: "uncertain",
    });
    await expect(overview.execute("missing")).rejects.toMatchObject({ code: "sprint_not_found" });
  });
});

describe("risk records", () => {
  it("preserves snapshots for same-state findings and transitions only when the state changes", () => {
    let id = 0;
    const input = {
      sprintId: "sprint",
      taskId: "task",
      assessment: { state: "blocked" as const, finding: finding() },
      cause: { type: "finding" as const, findingId: "finding" },
      now: reviewedAt,
      ids: { next: () => String(++id) },
    };
    const initial = createRiskAssessmentRecords(input);
    expect(initial.transition).toMatchObject({ from: null, to: "blocked", cause: input.cause });
    const repeated = createRiskAssessmentRecords({ ...input, previous: initial.snapshot, now });
    expect(repeated.snapshot.id).not.toBe(initial.snapshot.id);
    expect(repeated).not.toHaveProperty("transition");
    expect(
      createRiskAssessmentRecords({
        ...input,
        previous: initial.snapshot,
        assessment: { state: "uncertain" },
        now,
      }).transition,
    ).toMatchObject({ from: "blocked", to: "uncertain" });
    expect(Object.isFrozen(initial.transition?.cause)).toBe(true);
    expect(() =>
      createRiskAssessmentRecords({
        ...input,
        previous: { ...initial.snapshot, sprintId: "other" },
      }),
    ).toThrow("another scope");
    expect(() =>
      createRiskAssessmentRecords({ ...input, previous: initial.snapshot, now: before }),
    ).toThrow("chronological");
  });
});

it("does not refresh a retained blocker's age when feedback corrects a different finding", async () => {
  const old = finding("old-blocker");
  const fresh = finding("fresh-healthy", { state: "healthy", createdAt: now });
  const later = "2026-09-24T03:00:00.000Z";
  const fixture = riskFixture({
    receipts: [
      { ...receipt("partial", [old, fresh], { completedAt: now }), retainedFindingIds: [old.id] },
    ],
    feedback: [
      createFindingFeedback({
        id: "correction",
        findingId: fresh.id,
        kind: "correct",
        correction: { statement: "A more precise healthy explanation" },
        actor: "developer",
        source: "dashboard",
        createdAt: later,
      }),
    ],
  });
  expect(await read(fixture, "task")).toMatchObject({
    state: "blocked",
    finding: old,
    assessedAt: reviewedAt,
  });
});
