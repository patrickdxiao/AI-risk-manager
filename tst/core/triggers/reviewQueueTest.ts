import { describe, expect, it } from "vitest";
import { createEvidenceItem, type EvidenceItem } from "../../../src/core/evidence/evidenceModel.js";
import { createSprint, createTask, type Task } from "../../../src/core/planning/planningModel.js";
import {
  createRepository,
  type RepositoryObservation,
} from "../../../src/core/repository/repositoryModel.js";
import {
  ApplicationError,
  DomainInvariantError,
  MAX_REVIEW_REPOSITORIES,
  MAX_REVIEW_SEED_EVIDENCE,
} from "../../../src/core/primitives.js";
import {
  pendingTriggerDispatch,
  type TriggerCandidate,
  type TriggerQueueRecord,
} from "../../../src/core/triggers/triggerModel.js";
import { QueueReview, MAX_PENDING_REVIEWS } from "../../../src/core/triggers/triggerService.js";
import { EvaluateStoredTriggers } from "../../../src/core/triggers/storedTriggerEvaluation.js";
import type { SubmittedInvestigationResult } from "../../../src/core/storageContracts.js";
import { reviewQueueFixture } from "../../fixtures/reviewQueueFixture.js";

const now = "2026-09-24T12:00:00Z";
const sprint = createSprint({
  id: "sprint",
  startAt: "2026-09-24T11:00:00Z",
  endAt: "2026-10-02T00:00:00Z",
  createdAt: "2026-09-24T10:00:00Z",
  state: "active",
  reviewCadenceMinutes: 60,
  pointTarget: 8,
});
const repository = (id: string) =>
  createRepository({
    id,
    canonicalPath: `/approved/${id}`,
    gitRoot: `/approved/${id}`,
    identityDigest: id,
    registeredAt: sprint.createdAt,
  });
const evidence = (id = "e1", overrides: Partial<EvidenceItem> = {}): EvidenceItem =>
  createEvidenceItem({
    id,
    eventId: id,
    repositoryId: "web",
    source: "git",
    kind: "commit",
    occurredAt: now,
    locator: id,
    summary: "Observed change",
    digest: id,
    privacyMode: "metadata_only",
    metadata: {},
    ...overrides,
  });
const task = (id: string, overrides: Partial<Task> = {}): Task =>
  createTask({
    id,
    sprintId: sprint.id,
    title: id,
    points: 1,
    startAt: sprint.startAt,
    endAt: now,
    createdAt: sprint.createdAt,
    ...overrides,
  });
const candidate = (overrides: Partial<TriggerCandidate> = {}): TriggerCandidate => ({
  version: "trigger-candidate.v1",
  type: "git_change",
  sprintId: sprint.id,
  repositoryIds: ["web"],
  evidenceDigests: ["e1"],
  dedupKey: "request-1",
  reason: "A change was recorded",
  inputSummary: { first: "a", second: "b" },
  ...overrides,
});
const planCandidate = (key = "plan") =>
  candidate({ type: "plan_changed", repositoryIds: [], evidenceDigests: [], dedupKey: key });
function observation(evidenceIds = ["e1"], digest = "snapshot"): RepositoryObservation {
  return {
    repositoryId: "web",
    observedAt: now,
    evidenceIds,
    snapshot: {
      rootPath: "/approved/web",
      head: "head",
      branch: "main",
      detached: false,
      snapshotDigest: digest,
      status: {
        clean: true,
        stagedCount: 0,
        unstagedCount: 0,
        untrackedCount: 0,
        totalPathCount: 0,
        paths: [],
        pathsTruncated: false,
      },
    },
  };
}
const seedRecord = (id: string): TriggerQueueRecord => ({
  ...planCandidate(id),
  version: "trigger-queue-record.v1",
  id,
  evidenceCitations: [],
  observedAt: "2026-09-24T12:00:00.000Z",
  cooldownUntil: "2026-09-24T12:30:00.000Z",
});

function setup(seed: Parameters<typeof reviewQueueFixture>[0] = {}) {
  const fixture = reviewQueueFixture({
    sprints: [sprint],
    repositories: [repository("web"), repository("api")],
    evidence: [evidence()],
    observations: [observation()],
    ...seed,
  });
  let sequence = 0;
  let time = now;
  const ids = { next: () => `new-${String(++sequence)}` };
  const clock = { now: () => time };
  return {
    ...fixture,
    queue: new QueueReview(fixture.store, ids, clock),
    evaluate: new EvaluateStoredTriggers(fixture.store, ids, clock),
    setNow: (value: string) => {
      time = value;
    },
  };
}

describe("durable review admission", () => {
  it("atomically admits one immutable request and returns that same record for concurrent repeats", async () => {
    const fixture = setup();
    const list = ["saved"];
    const input = {
      candidate: candidate({ inputSummary: { list, approved: true, count: 1 } }),
      evidenceIds: ["e1"],
      cooldownMinutes: 30,
    };
    const results = await Promise.all([fixture.queue.execute(input), fixture.queue.execute(input)]);
    expect(results.map((item) => item.status)).toEqual(["queued", "existing"]);
    expect(results[0].trigger).toBe(results[1].trigger);
    expect(fixture.triggers()).toHaveLength(1);
    expect(fixture.dispatches()).toMatchObject([
      { status: "pending", leaseVersion: 0, attempts: 0 },
    ]);
    const record = results[0].trigger;
    list.push("later");
    expect(record.inputSummary["list"]).toEqual(["saved"]);
    expect(record).toMatchObject({
      repositoryIds: ["web"],
      evidenceCitations: [{ evidenceId: "e1", digest: "e1" }],
    });
    for (const value of [
      record,
      record.repositoryIds,
      record.inputSummary,
      record.evidenceCitations,
      record.evidenceCitations[0],
    ])
      expect(Object.isFrozen(value)).toBe(true);
  });

  it("rolls back request insertion if delivery persistence fails", async () => {
    const fixture = setup();
    fixture.failDispatch();
    await expect(
      fixture.queue.execute({ candidate: candidate(), evidenceIds: ["e1"], cooldownMinutes: 30 }),
    ).rejects.toThrow("Delivery write failed");
    expect(fixture.triggers()).toEqual([]);
    expect(fixture.dispatches()).toEqual([]);
    fixture.failDispatch(false);
    await expect(
      fixture.queue.execute({ candidate: candidate(), evidenceIds: ["e1"], cooldownMinutes: 30 }),
    ).resolves.toMatchObject({ status: "queued" });
  });

  it("coalesces identical pending facts during cooldown without dropping changed observations", async () => {
    const fixture = setup({ evidence: [evidence(), evidence("e2")] });
    await fixture.queue.execute({
      candidate: candidate(),
      evidenceIds: ["e1"],
      cooldownMinutes: 30,
    });
    await expect(
      fixture.queue.execute({
        candidate: candidate({ dedupKey: "repeat" }),
        evidenceIds: ["e1"],
        cooldownMinutes: 30,
      }),
    ).resolves.toMatchObject({ status: "existing" });
    await expect(
      fixture.queue.execute({
        candidate: candidate({ dedupKey: "changed", evidenceDigests: ["e2"] }),
        evidenceIds: ["e2"],
        cooldownMinutes: 30,
      }),
    ).resolves.toMatchObject({ status: "queued" });
    expect(
      fixture
        .triggers()
        .flatMap((record) => record.evidenceCitations.map((item) => item.evidenceId)),
    ).toEqual(["e1", "e2"]);
    await expect(
      fixture.queue.execute({
        candidate: candidate({ dedupKey: "different-facts", inputSummary: { first: "changed" } }),
        evidenceIds: ["e1"],
        cooldownMinutes: 30,
      }),
    ).resolves.toMatchObject({ status: "queued" });
  });

  it("compares persisted facts canonically rather than relying on object or citation order", async () => {
    const first = setup({ evidence: [evidence(), evidence("e2")] });
    const input = {
      candidate: candidate({ evidenceDigests: ["e1", "e2"], repositoryIds: ["api", "web"] }),
      evidenceIds: ["e1", "e2"],
      cooldownMinutes: 30,
    };
    const saved = (await first.queue.execute(input)).trigger;
    const reordered = {
      ...saved,
      inputSummary: { second: "b", first: "a" },
      repositoryIds: ["web", "api"],
      evidenceDigests: ["e2", "e1"],
      evidenceCitations: saved.evidenceCitations
        .toReversed()
        .map((item) => ({ digest: item.digest, evidenceId: item.evidenceId })),
    };
    const fixture = setup({
      evidence: [evidence(), evidence("e2")],
      triggers: [reordered],
      dispatches: first.dispatches(),
    });
    await expect(fixture.queue.execute(input)).resolves.toMatchObject({ status: "existing" });
  });

  it("rejects explicit key reuse for changed facts or broader scope", async () => {
    const fixture = setup();
    await fixture.queue.execute({
      candidate: candidate(),
      evidenceIds: ["e1"],
      cooldownMinutes: 30,
    });
    for (const changed of [
      candidate({ repositoryIds: ["api", "web"] }),
      candidate({ inputSummary: { first: "different" } }),
    ])
      await expect(
        fixture.queue.execute({ candidate: changed, evidenceIds: ["e1"], cooldownMinutes: 30 }),
      ).rejects.toMatchObject({ field: "dedupKey" });
    expect(fixture.triggers()).toHaveLength(1);
  });

  it.each(["completed", "dead"] as const)(
    "retains exact %s receipts but does not coalesce fresh keys into terminal work",
    async (status) => {
      const record = seedRecord("old");
      const fixture = setup({
        triggers: [record],
        dispatches: [{ ...pendingTriggerDispatch(record.id, now), status }],
      });
      await expect(
        fixture.queue.execute({
          candidate: planCandidate("old"),
          evidenceIds: [],
          cooldownMinutes: 30,
        }),
      ).resolves.toMatchObject({ status: "existing" });
      await expect(
        fixture.queue.execute({
          candidate: planCandidate("fresh"),
          evidenceIds: [],
          cooldownMinutes: 30,
        }),
      ).resolves.toMatchObject({ status: "queued" });
    },
  );

  it("honors distinct manual request IDs and cooldown expiry", async () => {
    const fixture = setup();
    for (const key of ["manual-a", "manual-b"])
      await expect(
        fixture.queue.execute({
          candidate: candidate({ type: "manual_review", dedupKey: key }),
          evidenceIds: ["e1"],
          cooldownMinutes: 30,
        }),
      ).resolves.toMatchObject({ status: "queued" });
    await fixture.queue.execute({
      candidate: planCandidate("first"),
      evidenceIds: [],
      cooldownMinutes: 30,
    });
    fixture.setNow("2026-09-24T12:30:00Z");
    await expect(
      fixture.queue.execute({
        candidate: planCandidate("after-cooldown"),
        evidenceIds: [],
        cooldownMinutes: 30,
      }),
    ).resolves.toMatchObject({ status: "queued" });
  });

  it("counts delayed and leased work globally and admits only one request into the last slot", async () => {
    const records = Array.from({ length: MAX_PENDING_REVIEWS - 1 }, (_, index) =>
      seedRecord(`seed-${String(index)}`),
    );
    const fixture = setup({
      triggers: records,
      dispatches: records.map((item, index) => ({
        ...pendingTriggerDispatch(item.id, now),
        status: index % 2 === 0 ? "leased" : "retry_wait",
      })),
    });
    const results = await Promise.allSettled(
      ["a", "b"].map((key) =>
        fixture.queue.execute({
          candidate: { ...planCandidate(key), inputSummary: { change: key } },
          evidenceIds: [],
          cooldownMinutes: 0,
        }),
      ),
    );
    expect(results.map((item) => item.status)).toEqual(["fulfilled", "rejected"]);
    expect(results[1]).toMatchObject({ reason: { code: "investigation_queue_full" } });
    expect(fixture.dispatches()).toHaveLength(MAX_PENDING_REVIEWS);
  });

  it("keeps empty repository scope plan-only and rejects unregistered, mismatched, or future seeds", async () => {
    const fixture = setup({
      evidence: [evidence(), evidence("future", { occurredAt: "2026-09-25T00:00:00Z" })],
    });
    await expect(
      fixture.queue.execute({ candidate: planCandidate(), evidenceIds: [], cooldownMinutes: 0 }),
    ).resolves.toMatchObject({ trigger: { repositoryIds: [] } });
    for (const input of [
      { candidate: candidate({ repositoryIds: [] }), evidenceIds: ["e1"] },
      { candidate: candidate({ repositoryIds: ["missing"] }), evidenceIds: ["e1"] },
      { candidate: candidate(), evidenceIds: ["missing"] },
      { candidate: candidate({ evidenceDigests: [] }), evidenceIds: ["e1"] },
      { candidate: candidate({ evidenceDigests: ["future"] }), evidenceIds: ["future"] },
    ])
      await expect(fixture.queue.execute({ ...input, cooldownMinutes: 30 })).rejects.toBeInstanceOf(
        Error,
      );
  });

  it("allows only same-sprint plan seeds and rejects missing repository provenance", async () => {
    const plan: EvidenceItem = {
      ...evidence(),
      id: "plan",
      source: "user",
      kind: "task_state_change",
      sprintId: sprint.id,
      taskId: "task",
      digest: "plan",
    };
    delete (plan as { repositoryId?: string }).repositoryId;
    const corrupt = {
      ...plan,
      id: "corrupt",
      digest: "corrupt",
      source: "replay" as const,
      kind: "commit" as const,
    };
    const foreign = {
      ...plan,
      id: "foreign",
      digest: "foreign",
      sprintId: "earlier",
      taskId: "prerequisite",
    };
    const fixture = setup({
      tasks: [task("task"), task("prerequisite", { sprintId: "earlier" })],
      evidence: [plan, corrupt, foreign],
    });
    await expect(
      fixture.queue.execute({
        candidate: planCandidate(),
        evidenceIds: ["plan"],
        cooldownMinutes: 0,
      }),
    ).rejects.toMatchObject({ field: "evidenceIds" });
    await expect(
      fixture.queue.execute({
        candidate: planCandidateWithDigest("plan"),
        evidenceIds: ["plan"],
        cooldownMinutes: 0,
      }),
    ).resolves.toMatchObject({ status: "queued" });
    for (const id of ["corrupt", "foreign"])
      await expect(
        fixture.queue.execute({
          candidate: planCandidateWithDigest(id),
          evidenceIds: [id],
          cooldownMinutes: 0,
        }),
      ).rejects.toMatchObject({ code: "scope_mismatch" });
  });

  it("rejects seed lists that an investigation cannot retain", async () => {
    const evidenceIds = Array.from(
      { length: MAX_REVIEW_SEED_EVIDENCE + 1 },
      (_, index) => `evidence-${String(index)}`,
    );
    const fixture = setup({ evidence: evidenceIds.map((id) => evidence(id)) });
    for (const input of [
      { candidate: candidate({ evidenceDigests: evidenceIds }), evidenceIds: [] },
      { candidate: candidate(), evidenceIds },
    ])
      await expect(fixture.queue.execute({ ...input, cooldownMinutes: 0 })).rejects.toMatchObject({
        code: "out_of_range",
      });
    expect(fixture.triggers()).toEqual([]);
  });

  it("rejects repository scopes larger than an execution attempt can authorize", async () => {
    const repositoryIds = Array.from(
      { length: MAX_REVIEW_REPOSITORIES + 1 },
      (_, index) => `repo-${String(index)}`,
    );
    const fixture = setup({ repositories: repositoryIds.map(repository) });
    await expect(
      fixture.queue.execute({
        candidate: candidate({ repositoryIds, evidenceDigests: [] }),
        evidenceIds: [],
        cooldownMinutes: 0,
      }),
    ).rejects.toMatchObject({ field: "repositoryIds" });
    await expect(
      fixture.evaluate.execute({ repositoryIds, cooldownMinutes: 0 }),
    ).rejects.toMatchObject({ field: "repositoryIds" });
    expect(fixture.triggers()).toEqual([]);
  });

  it("validates explicit targets and bounded configuration before any admission", async () => {
    const fixture = setup({ tasks: [task("foreign", { sprintId: "other" })] });
    for (const invalid of [
      candidate({ sprintId: "absent" }),
      candidate({ taskId: "foreign" }),
      candidate({ type: "unknown" as TriggerCandidate["type"] }),
      candidate({ version: "unknown" as TriggerCandidate["version"] }),
      candidate({
        inputSummary: { values: ["valid", 1] } as unknown as TriggerCandidate["inputSummary"],
      }),
    ])
      await expect(
        fixture.queue.execute({ candidate: invalid, evidenceIds: ["e1"], cooldownMinutes: 0 }),
      ).rejects.toBeInstanceOf(Error);
    for (const cooldownMinutes of [-1, 0.5, Number.MAX_SAFE_INTEGER])
      await expect(
        fixture.queue.execute({ candidate: candidate(), evidenceIds: ["e1"], cooldownMinutes }),
      ).rejects.toBeInstanceOf(DomainInvariantError);
    expect(fixture.triggers()).toEqual([]);
  });
});

function planCandidateWithDigest(digest: string): TriggerCandidate {
  return { ...planCandidate(digest), evidenceDigests: [digest] };
}

describe("stored trigger evaluation", () => {
  it("snapshots target and policy inputs before asynchronous storage reads", async () => {
    const fixture = setup({ tasks: [task("due")] });
    const input = {
      repositoryIds: ["web"],
      sprintId: sprint.id,
      taskId: "due",
      cooldownMinutes: 30,
    };
    const pending = fixture.evaluate.execute(input);
    input.repositoryIds.push("missing");
    input.sprintId = "missing";
    input.taskId = "missing";
    input.cooldownMinutes = -1;
    const result = await pending;
    expect(result.queued.map((item) => item.type)).toEqual([
      "scheduled_review",
      "git_change",
      "task_deadline",
    ]);
    expect(
      result.queued.every(
        (item) =>
          item.sprintId === sprint.id &&
          item.repositoryIds.join() === "web" &&
          item.cooldownUntil === "2026-09-24T12:30:00.000Z",
      ),
    ).toBe(true);
  });

  it("sweeps the active sprint and retains observation timestamps across polling", async () => {
    const fixture = setup({
      tasks: [
        task("due"),
        task("done", { state: "done" }),
        task("future", { endAt: sprint.endAt }),
      ],
    });
    const first = await fixture.evaluate.execute({ repositoryIds: ["web"], cooldownMinutes: 30 });
    expect(first.queued.map((item) => item.type)).toEqual([
      "scheduled_review",
      "git_change",
      "task_deadline",
    ]);
    fixture.setNow("2026-09-24T12:01:00Z");
    const repeated = await fixture.evaluate.execute({
      repositoryIds: ["web"],
      cooldownMinutes: 30,
    });
    expect(repeated.queued).toEqual([]);
    expect(repeated.existing.map((item) => item.id)).toEqual(first.queued.map((item) => item.id));
    expect(repeated.deferred).toEqual([]);
    expect(
      first.queued.find((item) => item.type === "git_change")?.inputSummary["occurredAt"],
    ).toBe("2026-09-24T12:00:00.000Z");
  });

  it("selects the saved observation seeds rather than unrelated newer evidence", async () => {
    const fixture = setup({
      evidence: [
        evidence("shared", { occurredAt: "2026-09-24T11:30:00Z" }),
        evidence("sprint-hint", { sprintId: "old-sprint" }),
        evidence("task-hint", { taskId: "other-task" }),
      ],
      observations: [observation(["shared"])],
    });
    const result = await fixture.evaluate.execute({ repositoryIds: ["web"], cooldownMinutes: 30 });
    expect(result.queued.find((item) => item.type === "git_change")?.evidenceCitations).toEqual([
      { evidenceId: "shared", digest: "shared" },
    ]);
  });

  it("preserves distinct stored observations even when their digest and timestamp match", async () => {
    const fixture = setup();
    await fixture.evaluate.execute({ repositoryIds: ["web"], cooldownMinutes: 30 });
    fixture.addEvidence(evidence("e2", { digest: "e1" }));
    fixture.saveObservation(observation(["e2"], "changed-snapshot"));
    const changed = await fixture.evaluate.execute({ repositoryIds: ["web"], cooldownMinutes: 30 });
    expect(changed.queued).toMatchObject([
      { type: "git_change", evidenceCitations: [{ evidenceId: "e2", digest: "e1" }] },
    ]);
    expect(
      fixture
        .triggers()
        .flatMap((item) => item.evidenceCitations.map((citation) => citation.evidenceId)),
    ).toEqual(["e1", "e2"]);
  });

  it("stops cadence at sprint end while keeping overdue unfinished tasks reviewable", async () => {
    const ended = { ...sprint, endAt: now };
    const fixture = setup({ sprints: [ended], tasks: [task("due")] });
    expect(
      (await fixture.evaluate.execute({ repositoryIds: [], cooldownMinutes: 30 })).fired.map(
        (item) => item.type,
      ),
    ).toEqual(["task_deadline"]);
    fixture.setNow("2026-09-24T13:00:00Z");
    expect(
      (await fixture.evaluate.execute({ repositoryIds: [], cooldownMinutes: 30 })).fired.map(
        (item) => item.type,
      ),
    ).toEqual(["task_deadline"]);
  });

  it("uses completed sprint-wide reviews for cadence and supports explicit inactive targets", async () => {
    const review: SubmittedInvestigationResult = {
      resultDigest: "receipt",
      investigation: {
        id: "review",
        sprintId: sprint.id,
        triggerId: "trigger",
        status: "completed",
        requestedAt: sprint.startAt,
        completedAt: "2026-09-24T11:45:00Z",
      },
      findings: [],
      citations: [],
      riskSnapshots: [],
      riskTransitions: [],
    };
    const fixture = setup({ reviews: [review] });
    expect(
      (await fixture.evaluate.execute({ repositoryIds: [], cooldownMinutes: 30 })).fired,
    ).toEqual([]);
    const inactive = setup({ sprints: [{ ...sprint, state: "completed" }], tasks: [task("due")] });
    expect(
      (await inactive.evaluate.execute({ repositoryIds: [], cooldownMinutes: 30 })).fired,
    ).toEqual([]);
    expect(
      (
        await inactive.evaluate.execute({ repositoryIds: [], taskId: "due", cooldownMinutes: 30 })
      ).fired.map((item) => item.type),
    ).toEqual(["task_deadline"]);
  });

  it("commits available capacity and exposes deferred facts for capture recovery", async () => {
    const fixture = setup({
      tasks: Array.from({ length: 101 }, (_, index) => task(`due-${String(index)}`)),
    });
    const result = await fixture.evaluate.execute({ repositoryIds: [], cooldownMinutes: 30 });
    expect(result.queued).toHaveLength(MAX_PENDING_REVIEWS);
    expect(result.deferred).toHaveLength(2);
    const repeated = await fixture.evaluate.execute({ repositoryIds: [], cooldownMinutes: 30 });
    expect(repeated.existing).toHaveLength(MAX_PENDING_REVIEWS);
    expect(repeated.deferred).toEqual(result.deferred);
    fixture.completeDispatch(result.queued[0]?.id ?? "");
    const recovered = await fixture.evaluate.execute({ repositoryIds: [], cooldownMinutes: 30 });
    expect(recovered.queued).toHaveLength(1);
    expect(recovered.deferred).toHaveLength(1);
  });

  it("rejects missing or mismatched targets, oversized sweeps, and unregistered scope", async () => {
    const fixture = setup({ tasks: [task("foreign", { sprintId: "other" })] });
    for (const extra of [
      { taskId: "missing" },
      { sprintId: "missing" },
      { taskId: "foreign" },
      { sprintId: sprint.id, taskId: "foreign" },
    ])
      await expect(
        fixture.evaluate.execute({ repositoryIds: [], cooldownMinutes: 30, ...extra }),
      ).rejects.toBeInstanceOf(Error);
    await expect(
      fixture.evaluate.execute({ repositoryIds: ["absent"], cooldownMinutes: 30 }),
    ).rejects.toBeInstanceOf(ApplicationError);
    const oversized = setup({
      tasks: Array.from({ length: 1_001 }, (_, index) => task(String(index))),
    });
    await expect(
      oversized.evaluate.execute({ repositoryIds: [], cooldownMinutes: 30 }),
    ).rejects.toMatchObject({ field: "tasks" });
    expect(oversized.triggers()).toEqual([]);
  });
});
