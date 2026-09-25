import { describe, expect, it } from "vitest";
import { CreateSprint, EditTask } from "../../../src/core/planning/planningService.js";
import { createEvidenceItem } from "../../../src/core/evidence/evidenceModel.js";
import {
  completeInvestigation,
  failInvestigation,
  retryInvestigation,
} from "../../../src/core/investigation/investigationModel.js";
import { pendingTriggerDispatch } from "../../../src/core/triggers/triggerModel.js";
import { createFindingFeedback } from "../../../src/core/risk/findingFeedback.js";
import {
  before,
  now,
  sprint,
  task,
  repository,
  evidence,
  finding,
} from "../../fixtures/riskFixture.js";
import { attempt, investigation, observation, seeded, trigger } from "./fixture.js";

const later = "2026-09-24T03:00:00.000Z";

describe("SQLite planning and repository stores", () => {
  it("persists sprint rollover and optimistic task edits without dropping task fields", async () => {
    const db = await seeded();
    const next = await new CreateSprint(
      db.store,
      { next: () => "next" },
      { now: () => now },
    ).execute({
      startAt: now,
      endAt: later,
      pointTarget: 5,
      reviewCadenceMinutes: 30,
      state: "active",
      goal: "Ship",
      assumptions: ["API exists"],
    });
    const changed = await new EditTask(db.store, { now: () => now }).execute({
      taskId: "task",
      version: 1,
      title: "Updated",
      description: "Details",
      pathHints: ["src"],
      completionCriteria: ["Passing check"],
      state: "done",
    });
    await db.store.execute(async ({ planning }) => {
      expect(await planning.findActiveSprint()).toEqual(next);
      expect((await planning.listSprints()).map((item) => item.state)).toEqual([
        "active",
        "completed",
      ]);
      expect(await planning.findSprintById("missing")).toBeUndefined();
      expect(await planning.findTasksBySprintId("sprint")).toEqual([changed]);
      expect(await planning.findOpenTasks()).toEqual([]);
      expect(await planning.countOpenTasks()).toBe(0);
    });
    await expect(db.store.execute((tx) => tx.planning.saveTask(changed))).rejects.toThrow(
      "version",
    );
    await expect(
      db.store.execute((tx) => tx.planning.saveSprint(sprint("missing"))),
    ).rejects.toThrow("missing");
    await expect(db.store.execute((tx) => tx.planning.addSprint(next))).rejects.toMatchObject({
      entity: "sprint",
    });
    await expect(db.store.execute((tx) => tx.planning.addTask(changed))).rejects.toMatchObject({
      entity: "task",
    });
    await expect(
      db.store.execute((tx) => tx.planning.addSprint(sprint("another"))),
    ).rejects.toThrow("UNIQUE");
    await expect(
      db.store.execute((tx) => tx.planning.addTask(task("orphan", { sprintId: "missing" }))),
    ).rejects.toThrow("FOREIGN KEY");
    const reopened = await new EditTask(db.store, { now: () => later }).execute({
      taskId: "task",
      version: 2,
      state: "in_progress",
      description: null,
    });
    expect(await db.store.execute((tx) => tx.planning.findOpenTasks())).toEqual([reopened]);
  });

  it("uniquely registers canonical paths and preserves exact provenance including spaces", async () => {
    const db = await seeded();
    await expect(db.store.execute((tx) => tx.repositories.add(repository))).rejects.toMatchObject({
      conflict: "id",
    });
    await expect(
      db.store.execute((tx) => tx.repositories.add({ ...repository, id: "duplicate" })),
    ).rejects.toMatchObject({ conflict: "canonical_path" });
    const other = {
      ...repository,
      id: "other",
      canonicalPath: "/repo with spaces ",
      gitRoot: "/repo with spaces ",
      approvedRoot: "/",
    };
    await db.store.execute((tx) => tx.repositories.add(other));
    expect(await db.store.execute((tx) => tx.repositories.findById("other"))).toEqual(other);
    expect(await db.store.execute((tx) => tx.repositories.list())).toHaveLength(2);
  });

  it("acknowledges only the exact saved observation and preserves pending handoff across replacement attempts", async () => {
    const db = await seeded();
    const initial = observation();
    await db.store.execute((tx) => tx.repositoryObservations.save(initial));
    await db.store.execute((tx) => tx.repositoryObservations.save(initial));
    await expect(
      db.store.execute((tx) => tx.repositoryObservations.save(observation({ observedAt: later }))),
    ).rejects.toThrow("Pending observations");
    await db.store.execute(async ({ repositoryObservations: observations }) => {
      expect(await observations.listPendingEvaluation(1)).toEqual([initial]);
      expect(await observations.markEvaluated(repository.id, "other", now)).toBe(false);
      expect(await observations.markEvaluated(repository.id, "snapshot", later)).toBe(false);
      expect(await observations.markEvaluated(repository.id, "snapshot", now)).toBe(true);
      expect(await observations.listPendingEvaluation(1)).toEqual([]);
      expect(await observations.findByRepositoryId(repository.id)).toMatchObject({
        evaluatedSnapshotDigest: "snapshot",
      });
      await observations.save(
        observation({
          observedAt: later,
          snapshot: {
            ...initial.snapshot,
            branch: null,
            detached: true,
            snapshotDigest: "changed",
            status: {
              ...initial.snapshot.status,
              clean: false,
              totalPathCount: 1,
              untrackedCount: 1,
              paths: [{ path: "new.ts", staged: false, unstaged: false, untracked: true }],
            },
          },
        }),
      );
      expect(await observations.markEvaluated(repository.id, "snapshot", now)).toBe(false);
      expect(await observations.listPendingEvaluation(1)).toHaveLength(1);
    });
  });
});

describe("SQLite immutable evidence and scoped queries", () => {
  it("compares the full evidence identity, supports explicit null context, and orders bounded results deterministically", async () => {
    const db = await seeded();
    const taskItem = createEvidenceItem({
      ...evidence,
      id: "task-evidence",
      sprintId: "sprint",
      taskId: "task",
      occurredAt: now,
    });
    const selected = createEvidenceItem({
      ...evidence,
      id: "selected",
      digest: "selected",
      occurredAt: now,
      privacyMode: "selected_content",
      selectedContent: { text: "one explicit line", truncated: false },
      metadata: { true: true, null: null, values: [1, "two", { nested: true }] },
    });
    const plan = createEvidenceItem({
      id: "plan",
      eventId: "event-plan",
      sprintId: "sprint",
      source: "user",
      kind: "task_state_change",
      occurredAt: now,
      locator: "task",
      summary: "Plan changed",
      digest: "plan",
      privacyMode: "metadata_only",
      metadata: {},
    });
    await db.store.execute(async ({ evidence: store }) => {
      for (const item of [taskItem, selected, plan]) await store.add(item);
      await store.add(evidence);
      expect(await store.findByIdentity(evidence)).toEqual(evidence);
      expect(await store.findByIdentity(taskItem)).toEqual(taskItem);
      expect(await store.findByIdentity({ ...evidence, taskId: "task" })).toBeUndefined();
      expect(await store.findScoped({ limit: 2 })).toEqual([taskItem, selected]);
      expect(
        await store.findScoped({
          sprintId: null,
          taskId: null,
          repositoryId: repository.id,
          source: "git",
          kinds: ["commit"],
          occurredSince: now,
          occurredThrough: now,
          limit: 10,
        }),
      ).toEqual([selected]);
      expect(await store.findScoped({ sprintId: "sprint", taskId: "task", limit: 10 })).toEqual([
        taskItem,
      ]);
      expect(await store.findScoped({ sprintId: "sprint", taskId: null, limit: 10 })).toEqual([
        plan,
      ]);
      expect(await store.findScoped({ kinds: [], limit: 10 })).toEqual([]);
    });
    await expect(
      db.store.execute((tx) => tx.evidence.add({ ...evidence, summary: "changed" })),
    ).rejects.toThrow("replace");
    await expect(
      db.store.execute((tx) => tx.evidence.add({ ...evidence, id: "same-identity" })),
    ).rejects.toThrow("UNIQUE");
    expect(() => {
      db.raw.exec("UPDATE evidence SET data = data");
    }).toThrow("immutable");
    expect(() => {
      db.raw.exec("DELETE FROM evidence");
    }).toThrow("immutable");
  });

  it("rejects unbounded read limits at every bounded storage method", async () => {
    const db = await seeded();
    for (const count of [-1, 0, 1.5, 1_001, Number.NaN])
      for (const read of [
        () => db.store.execute((tx) => tx.evidence.findScoped({ limit: count })),
        () => db.store.execute((tx) => tx.repositoryObservations.listPendingEvaluation(count)),
        () =>
          db.store.execute((tx) => tx.investigations.findRecentBySprintId("sprint", now, count)),
        () => db.store.execute((tx) => tx.triggerQueue.listPendingBySprintId("sprint", count)),
        () => db.store.execute((tx) => tx.findingFeedback.findByFindingId("finding", count)),
      ])
        await expect(read()).rejects.toThrow();
  });
});

describe("SQLite execution, receipts and risk history", () => {
  it("claims installation-wide execution atomically, advances takeover versions, and never loses unknown reservations", async () => {
    const db = await seeded();
    await db.store.execute(async ({ investigations: store }) => {
      await store.add(investigation());
      await store.add(investigation("other"));
      expect(await store.claimExecution("missing", now, later)).toBeUndefined();
      const claimed = await store.claimExecution("investigation", now, later);
      expect(claimed?.executionVersion).toBe(1);
      expect(await store.claimExecution("other", now, later)).toBeUndefined();
      expect(await store.findActive(now)).toEqual(claimed);
      await store.saveAttempt(attempt({ leaseUntil: later }));
      const expired = {
        ...attempt({ leaseUntil: later }),
        status: "expired" as const,
        completedAt: later,
        terminalReason: "expired",
        durationMs: 3_600_000,
      };
      await store.saveAttempt(expired);
      const takeover = await store.claimExecution(
        "investigation",
        later,
        "2026-09-24T04:00:00.000Z",
      );
      expect(takeover?.executionVersion).toBe(2);
      await store.saveAttempt(
        attempt({
          id: "investigation:attempt:2",
          version: 2,
          startedAt: later,
          leaseUntil: "2026-09-24T04:00:00.000Z",
          usage: { totalTokens: 0 },
          authority: {
            credentialHash: "a".repeat(64),
            repositoryIds: [repository.id],
            planningDigest: "plan",
            reservedTokens: 20_000,
            toolCalls: 1,
          },
        }),
      );
      expect(await store.listAttemptsSince(later)).toHaveLength(1);
      expect(await store.listUnsettledAttempts()).toHaveLength(2);
      expect(await store.findAttempts("investigation")).toHaveLength(2);
      expect(
        await store.findByDedupKey({ sprintId: "sprint", triggerId: "trigger-investigation" }),
      ).toEqual(takeover);
      expect(await store.findRecentBySprintId("sprint", now, 1)).toMatchObject([
        { investigation: { id: "other" } },
      ]);
      expect(await store.findRecentBySprintId("sprint", later, 2)).toMatchObject([
        { investigation: { id: "other" } },
        { latestAttempt: { version: 2 } },
      ]);
    });
    const stored = await db.store.execute((tx) =>
      tx.investigations.findAttemptById("investigation:attempt:1"),
    );
    expect(stored?.usage).toBeUndefined();
    await expect(
      db.store.execute((tx) =>
        tx.investigations.saveAttempt(attempt({ leaseUntil: later, version: 3 })),
      ),
    ).rejects.toThrow("immutable");
    await expect(
      db.store.execute((tx) => tx.investigations.saveAttempt(attempt({ leaseUntil: later }))),
    ).rejects.toThrow("terminal");
    await expect(
      db.store.execute((tx) => tx.investigations.save({ ...investigation(), sprintId: "other" })),
    ).rejects.toThrow("immutable");
    await expect(db.store.execute((tx) => tx.investigations.save(investigation()))).rejects.toThrow(
      "version",
    );
    await expect(
      db.store.execute((tx) => tx.investigations.save(investigation("missing"))),
    ).rejects.toThrow("missing");
  });

  it("persists immutable receipts with their findings, feedback and deterministic current risk", async () => {
    const db = await seeded();
    const current = investigation();
    const completed = completeInvestigation(current, {
      completedAt: later,
      usage: { latencyMs: 20, totalTokens: 9, estimatedCostUsd: 0 },
    });
    const item = finding("finding", { taskId: "task", rationale: "r".repeat(8_000) });
    const citation = { findingId: item.id, evidenceId: evidence.id, note: "Supports blocker" };
    const snapshot = {
      id: "risk",
      sprintId: "sprint",
      taskId: "task",
      findingId: item.id,
      state: "blocked" as const,
      createdAt: later,
    };
    const transition = {
      id: "transition",
      sprintId: "sprint",
      taskId: "task",
      from: null,
      to: "blocked" as const,
      cause: { type: "finding" as const, findingId: item.id },
      occurredAt: later,
    };
    const receipt = {
      investigation: completed,
      resultDigest: "digest",
      findings: [item],
      citations: [citation],
      riskSnapshots: [snapshot],
      riskTransitions: [transition],
      question: {
        id: "question",
        question: "q".repeat(8_000),
        reason: "scope" as const,
        taskId: "task",
      },
    };
    await db.store.execute(async (tx) => {
      await tx.investigations.add(current);
      await tx.investigations.save(completed);
      await tx.findings.add(item);
      await tx.findings.addEvidence(citation);
      await tx.risks.addSnapshot(snapshot);
      await tx.risks.addTransition(transition);
      await tx.investigations.saveSubmittedResult(receipt);
      await tx.investigations.saveSubmittedResult(receipt);
      expect(await tx.investigations.findLatestSubmittedResult("sprint")).toEqual(receipt);
      expect(await tx.investigations.findLatestSubmittedResult("sprint", "task")).toBeUndefined();
      expect(await tx.findings.findEvidenceByFindingId(item.id)).toEqual([citation]);
      expect(await tx.findings.findById(item.id)).toEqual(item);
      for (const [id, kind] of [
        ["one", "confirm"],
        ["two", "dismiss"],
        ["z", "correct"],
      ] as const)
        await tx.findingFeedback.add(
          createFindingFeedback({
            id,
            findingId: item.id,
            kind,
            ...(kind === "correct"
              ? { correction: { statement: "Reworded" } }
              : { note: "A note" }),
            actor: "user",
            source: "dashboard",
            createdAt: later,
          }),
        );
      expect((await tx.findingFeedback.findByFindingId(item.id, 2)).map((item) => item.id)).toEqual(
        ["z", "two"],
      );
      expect(
        (await tx.findingFeedback.findCurrentByFindingId(item.id)).map((item) => item.id),
      ).toEqual(["z", "two"]);
      expect(await tx.findingFeedback.findById("z")).toMatchObject({
        correction: { statement: "Reworded" },
      });
      expect(await tx.risks.findLatestSnapshot("sprint")).toBeUndefined();
      expect(await tx.risks.findLatestSnapshot("sprint", "task")).toEqual(snapshot);
      await tx.risks.addTransition({
        ...transition,
        id: "feedback-transition",
        from: "blocked",
        to: "uncertain",
        cause: { type: "feedback", feedbackId: "two" },
      });
    });
    await expect(
      db.store.execute((tx) =>
        tx.investigations.saveSubmittedResult({ ...receipt, resultDigest: "different" }),
      ),
    ).rejects.toThrow("replace");
    await expect(
      db.store.execute((tx) => tx.investigations.save({ ...completed, triggerId: "different" })),
    ).rejects.toThrow("immutable");
    await expect(
      db.store.execute((tx) =>
        tx.investigations.save({ ...completed, usage: { totalTokens: 10 } }),
      ),
    ).rejects.toThrow("immutable");
    expect(() => {
      db.raw.exec("DELETE FROM investigation_results");
    }).toThrow("immutable");
  });

  it("stores retryable failures without resetting the prior attempt version", async () => {
    const db = await seeded();
    await db.store.execute(async ({ investigations: store }) => {
      await store.add(investigation());
      const claimed = await store.claimExecution("investigation", now, later);
      expect(claimed).toBeDefined();
      if (claimed === undefined) return;
      const failed = failInvestigation(claimed, {
        completedAt: now,
        failure: { code: "unavailable", message: "Try again", retryable: true },
      });
      await store.save(failed);
      await store.save(retryInvestigation(failed, later));
      expect(
        (await store.claimExecution("investigation", later, "2026-09-24T04:00:00.000Z"))
          ?.executionVersion,
      ).toBe(2);
    });
  });
});

describe("SQLite durable delivery", () => {
  it("retains immutable scoped queue facts and fences dispatch writes by lease and status", async () => {
    const db = await seeded();
    const queued = trigger("a", {
      inputSummary: { text: "context", count: 2, changed: true, files: ["one", ""] },
    });
    const pending = pendingTriggerDispatch("a", now);
    await db.store.execute(async (tx) => {
      await tx.triggerQueue.add(queued);
      await tx.triggerQueue.add(trigger("b", { taskId: "task", repositoryIds: [] }));
      await tx.triggerDispatches.add(pending);
      await tx.triggerDispatches.add(pendingTriggerDispatch("b", later));
      await tx.investigations.add(investigation());
      expect(await tx.triggerQueue.findByDedupKey(queued.dedupKey)).toEqual(queued);
      expect(await tx.triggerQueue.findById("a")).toEqual(queued);
      expect(await tx.triggerQueue.findLatestByCooldownScope(queued)).toEqual(queued);
      expect(
        await tx.triggerQueue.findLatestByCooldownScope({ ...queued, repositoryIds: [] }),
      ).toBeUndefined();
      expect(await tx.triggerDispatches.countPending()).toBe(2);
      expect(await tx.triggerQueue.listPendingBySprintId("sprint", 1)).toEqual([queued]);
      expect(await tx.triggerDispatches.findNextDue(before)).toBeUndefined();
      expect(await tx.triggerDispatches.findNextDue(now)).toEqual(pending);
      const leased = {
        ...pending,
        investigationId: "investigation",
        status: "leased" as const,
        leaseVersion: 1,
        attempts: 1,
        leaseExpiresAt: later,
      };
      expect(await tx.triggerDispatches.saveFenced(leased, 1, "pending")).toBe(false);
      expect(await tx.triggerDispatches.saveFenced(leased, 0, "leased")).toBe(false);
      expect(await tx.triggerDispatches.saveFenced(leased, 0, "pending")).toBe(true);
      expect(await tx.triggerDispatches.findByInvestigationId("investigation")).toEqual(leased);
      expect(await tx.triggerDispatches.findNextDue(now)).toBeUndefined();
      expect(await tx.triggerDispatches.findNextDue(later)).toEqual(leased);
      const retry = {
        ...pending,
        investigationId: "investigation",
        status: "retry_wait" as const,
        leaseVersion: 1,
        attempts: 1,
        dueAt: later,
        updatedAt: later,
        failureCode: "unavailable",
      };
      expect(await tx.triggerDispatches.saveFenced(retry, 1, "leased")).toBe(true);
      expect(await tx.triggerDispatches.findNextDue(later)).toEqual(retry);
      const completed = { ...retry, status: "completed" as const, completedAt: later };
      expect(await tx.triggerDispatches.saveFenced(completed, 1, "retry_wait")).toBe(true);
      expect(await tx.triggerDispatches.countPending()).toBe(1);
      expect(await tx.triggerQueue.listPendingBySprintId("sprint", 10)).toMatchObject([
        { id: "b" },
      ]);
      expect(await tx.triggerDispatches.findByTriggerId("a")).toEqual(completed);
      expect(await tx.triggerDispatches.findNextDue(later)).toMatchObject({ triggerId: "b" });
    });
    await expect(
      db.store.execute((tx) => tx.triggerQueue.add({ ...queued, repositoryIds: [] })),
    ).rejects.toThrow("replace");
    await expect(
      db.store.execute((tx) =>
        tx.triggerDispatches.saveFenced(
          { ...pending, status: "dead", completedAt: now },
          1,
          "completed",
        ),
      ),
    ).rejects.toThrow("identity");
  });
});
