import { planningDigest } from "../../../src/core/investigation/evidenceScope.js";
import { describe, expect, it, vi } from "vitest";
import {
  createAttemptAuthority,
  newAttemptToken,
} from "../../../src/core/investigation/attemptAuthority.js";
import {
  claimInvestigationExecution,
  createInvestigation,
  startInvestigation,
  type InvestigationAttempt,
  type InvestigationStructuredResult,
  type RuntimeFindingDraft,
} from "../../../src/core/investigation/investigationModel.js";
import { SubmitInvestigationResult } from "../../../src/core/investigation/submitInvestigationResult.js";
import {
  readCurrentFindings,
  readCurrentRiskAssessment,
} from "../../../src/core/risk/riskAssessment.js";
import type { TriggerDispatch } from "../../../src/core/triggers/triggerModel.js";
import { investigationFixture } from "../../fixtures/investigationFixture.js";
import {
  before,
  evidence,
  finding,
  now,
  receipt,
  repository,
  reviewedAt,
  sprint,
  task,
} from "../../fixtures/riskFixture.js";

const leaseUntil = "2026-09-24T02:10:00.000Z";
const draft = (overrides: Partial<RuntimeFindingDraft> = {}): RuntimeFindingDraft => ({
  state: "healthy",
  confidence: 0.8,
  rationale: "The saved checks pass",
  evidenceCitations: [{ evidenceId: evidence.id }],
  ...overrides,
});
const answer = (findings = [draft()]): InvestigationStructuredResult => ({
  version: "1",
  findings,
});
async function setup(
  seed: Parameters<typeof investigationFixture>[0] = {},
  options: { sprintWide?: boolean; repositoryIds?: readonly string[]; dispatch?: boolean } = {},
) {
  const investigation = claimInvestigationExecution(
    startInvestigation(
      createInvestigation({
        id: "current",
        sprintId: "sprint",
        ...(options.sprintWide === true ? {} : { taskId: "task" }),
        triggerId: "trigger",
        requestedAt: now,
      }),
      now,
    ),
    { now, leaseUntil },
  );
  const attempt: InvestigationAttempt = {
    id: "current:attempt:1",
    investigationId: investigation.id,
    version: 1,
    status: "running",
    startedAt: now,
    leaseUntil,
    timeoutMs: 600_000,
    queueWaitMs: 0,
    promptVersion: "1",
    resultSchemaVersion: "1",
    ...(options.dispatch === true ? { dispatchTriggerId: "trigger", dispatchLeaseVersion: 1 } : {}),
  };
  const dispatch: TriggerDispatch = {
    version: "trigger-dispatch.v1",
    triggerId: "trigger",
    investigationId: investigation.id,
    status: "leased",
    leaseVersion: 1,
    attempts: 1,
    dueAt: now,
    leaseExpiresAt: leaseUntil,
    createdAt: now,
    updatedAt: now,
  };
  const fixture = investigationFixture({
    sprints: [sprint()],
    tasks: [task()],
    evidence: [evidence],
    repositories: [repository],
    ...seed,
    investigations: [investigation, ...(seed.investigations ?? [])],
    attempts: [attempt, ...(seed.attempts ?? [])],
    dispatches: options.dispatch === true ? [dispatch] : (seed.dispatches ?? []),
  });
  const token = newAttemptToken(attempt.id, "test-secret");
  const authority = await fixture.store.execute((store) =>
    createAttemptAuthority(store, investigation, {
      token,
      repositoryIds: options.repositoryIds ?? [repository.id],
      now,
    }),
  );
  await fixture.store.execute((store) =>
    store.investigations.saveAttempt({ ...attempt, authority }),
  );
  let time = now,
    sequence = 0;
  const submit = new SubmitInvestigationResult(
    fixture.store,
    { next: () => `new-${String(++sequence)}` },
    { now: () => time },
  );
  return {
    ...fixture,
    submit,
    token,
    investigation,
    attempt: { ...attempt, authority },
    dispatch,
    setNow(value: string) {
      time = value;
    },
    send: (result = answer(), usage?: { totalTokens?: number; latencyMs?: number }) =>
      submit.execute({ token, result, ...(usage === undefined ? {} : { usage }) }),
  };
}

function prior(
  seed: {
    private?: boolean;
    taskId?: string;
    state?: "healthy" | "uncertain" | "blocked";
    id?: string;
  } = {},
) {
  const id = seed.id ?? "prior";
  const savedFinding = finding(`${id}-finding`, {
    investigationId: id,
    ...(seed.taskId === undefined ? {} : { taskId: seed.taskId }),
    state: seed.state ?? "blocked",
  });
  const saved = receipt(id, [savedFinding], {
    taskId: seed.taskId ?? "task",
    completedAt: reviewedAt,
  });
  const investigation = {
    ...saved.investigation,
    executionAttemptId: `${id}-attempt`,
    executionVersion: 1,
  };
  const attempt: InvestigationAttempt = {
    id: `${id}-attempt`,
    investigationId: id,
    version: 1,
    status: "succeeded",
    startedAt: before,
    completedAt: reviewedAt,
    leaseUntil: reviewedAt,
    timeoutMs: 60_000,
    queueWaitMs: 0,
    promptVersion: "1",
    resultSchemaVersion: "1",
    authority: {
      credentialHash: "old",
      repositoryIds: seed.private === true ? ["private"] : [repository.id],
      planningDigest: "old",
      toolCalls: 1,
      reservedTokens: 20_000,
    },
  };
  return { finding: savedFinding, receipt: { ...saved, investigation }, investigation, attempt };
}

async function assessment(fixture: Awaited<ReturnType<typeof setup>>, taskId = "task") {
  return fixture.store.execute(async (store) =>
    readCurrentRiskAssessment(store, await readCurrentFindings(store, "sprint", taskId)),
  );
}

describe("atomic investigation acceptance", () => {
  it("saves immutable cited findings, risks, attempt completion and receipt without completing tasks", async () => {
    const fixture = await setup({}, { dispatch: true });
    const result = await fixture.send(answer(), { totalTokens: 120, latencyMs: 300 });
    expect(Object.keys(result).sort()).toEqual(["completedAt", "investigationId", "resultDigest"]);
    expect(result).toMatchObject({ investigationId: "current", completedAt: now });
    expect(fixture.findings()).toHaveLength(1);
    expect(fixture.citations()).toMatchObject([
      { evidenceId: evidence.id, findingId: fixture.findings()[0]?.id },
    ]);
    expect(fixture.snapshots()).toMatchObject([{ state: "healthy", taskId: "task" }]);
    expect(fixture.attempts()[0]).toMatchObject({
      status: "succeeded",
      usage: { totalTokens: 120 },
      durationMs: 0,
    });
    expect(fixture.dispatches()[0]).toMatchObject({ status: "completed" });
    expect(fixture.dispatches()[0]).not.toHaveProperty("leaseExpiresAt");
    expect(fixture.tasks.get("task")).toEqual(task());
    expect(fixture.evidence.get(evidence.id)).toBe(evidence);
    expect(Object.isFrozen(fixture.receipts()[0]?.findings)).toBe(true);
    expect(Object.isFrozen(fixture.findings()[0])).toBe(true);
  });

  it("does not invent zero usage when a runtime does not report it", async () => {
    const fixture = await setup();
    await fixture.send();
    expect(fixture.attempts()[0]).not.toHaveProperty("usage");
    expect(fixture.receipts()[0]?.investigation).not.toHaveProperty("usage");
    expect(fixture.attempts()[0]?.authority?.reservedTokens).toBe(20_000);
  });

  it("normalizes semantic retries across ordering, whitespace, dates, defaults and telemetry", async () => {
    const fixture = await setup({ evidence: [evidence, { ...evidence, id: "second" }] });
    const a = draft({
      rationale: " A ",
      taskId: " task ",
      missingEvidence: [" y ", "x", "x"],
      nextCheckAt: "2026-09-25T00:00:00Z",
      evidenceCitations: [
        { evidenceId: " second " },
        { evidenceId: " evidence ", note: " checked " },
      ],
    });
    const b = draft({ rationale: "B" });
    const first = await fixture.send(answer([a, b]), { totalTokens: 100 });
    fixture.setNow("2026-10-01T00:00:00Z");
    const repeated = await fixture.send(
      answer([
        b,
        {
          ...a,
          taskId: "task",
          rationale: "A",
          missingEvidence: ["x", "y"],
          nextCheckAt: "2026-09-25T00:00:00.000Z",
          evidenceCitations: [
            { note: "checked", evidenceId: "evidence" },
            { evidenceId: "second" },
          ],
        },
      ]),
      { totalTokens: 500, latencyMs: 999 },
    );
    expect(repeated).toEqual(first);
    expect(fixture.receipts()).toHaveLength(1);
    expect(fixture.findings()).toHaveLength(2);
    expect(fixture.attempts()[0]?.usage?.totalTokens).toBe(100);
  });

  it("serializes concurrent equal and conflicting answers without duplicate writes", async () => {
    const fixture = await setup();
    const equal = await Promise.all([fixture.send(), fixture.send()]);
    expect(equal[0]).toEqual(equal[1]);
    expect(fixture.receipts()).toHaveLength(1);
    expect(fixture.snapshots()).toHaveLength(1);
    const fresh = await setup();
    const outcomes = await Promise.allSettled([
      fresh.send(),
      fresh.send(answer([draft({ rationale: "different" })])),
    ]);
    expect(outcomes.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(outcomes[1]).toMatchObject({ reason: { code: "investigation_result_conflict" } });
    expect(fresh.findings()).toHaveLength(1);
  });

  it.each(["receipt", "dispatch"])(
    "rolls every write back on failed %s persistence",
    async (failure) => {
      const fixture = await setup(failure === "dispatch" ? { failFenced: true } : {}, {
        dispatch: true,
      });
      fixture.failReceiptWrites(failure === "receipt");
      await expect(fixture.send()).rejects.toThrow();
      expect(fixture.receipts()).toEqual([]);
      expect(fixture.findings()).toEqual([]);
      expect(fixture.citations()).toEqual([]);
      expect(fixture.snapshots()).toEqual([]);
      expect(fixture.transitions()).toEqual([]);
      expect(fixture.attempts()[0]?.status).toBe("running");
      expect(fixture.investigations()[0]?.status).toBe("running");
      expect(fixture.dispatches()[0]?.status).toBe("leased");
    },
  );

  it("stores bounded questions locally without changing task state", async () => {
    const fixture = await setup();
    const accepted = await fixture.send({
      ...answer(),
      question: { question: " Which criteria apply? ", reason: "completion_criteria" },
    });
    expect(accepted).not.toHaveProperty("question");
    expect(fixture.receipts()[0]?.question).toMatchObject({
      question: "Which criteria apply?",
      reason: "completion_criteria",
      taskId: "task",
    });
    expect(fixture.tasks.get("task")?.state).toBe("planned");
  });
});

describe("acceptance authority and freshness", () => {
  it("requires the exact attempt credential even for an already accepted answer", async () => {
    const fixture = await setup();
    await fixture.send();
    await expect(
      fixture.submit.execute({
        token: newAttemptToken(fixture.attempt.id, "wrong-secret"),
        result: answer(),
      }),
    ).rejects.toMatchObject({ code: "attempt_unauthorized" });
    fixture.repositories.delete(repository.id);
    await expect(fixture.send()).rejects.toMatchObject({ code: "attempt_scope_revoked" });
  });

  it.each(["deadline", "version", "dispatch", "terminal"])(
    "rejects %s ownership loss before publishing",
    async (kind) => {
      const fixture = await setup({}, { dispatch: true });
      if (kind === "deadline") fixture.setNow(leaseUntil);
      if (kind === "version")
        await fixture.store.execute((store) =>
          store.investigations.saveAttempt({ ...fixture.attempt, version: 2 }),
        );
      if (kind === "terminal")
        await fixture.store.execute((store) =>
          store.investigations.saveAttempt({ ...fixture.attempt, status: "cancelled" }),
        );
      if (kind === "dispatch")
        await fixture.store.execute((store) =>
          store.triggerDispatches.saveFenced({ ...fixture.dispatch, leaseVersion: 2 }, 1, "leased"),
        );
      await expect(fixture.send()).rejects.toMatchObject({ code: "execution_lease_lost" });
      expect(fixture.receipts()).toEqual([]);
    },
  );

  it.each(["task", "prerequisite", "sprint"])(
    "rejects a changed %s after admission",
    async (kind) => {
      const prerequisite = task("prerequisite", { sprintId: "earlier" });
      const fixture = await setup({
        tasks: [task("task", { dependencyIds: [prerequisite.id] }), prerequisite],
      });
      if (kind === "sprint") fixture.sprints.set("sprint", { ...sprint(), goal: "New goal" });
      else {
        const id = kind === "task" ? "task" : prerequisite.id;
        const saved = fixture.tasks.get(id);
        if (saved === undefined) throw new Error("fixture task missing");
        fixture.tasks.set(id, { ...saved, version: saved.version + 1 });
      }
      await expect(fixture.send()).rejects.toMatchObject({ code: "investigation_input_changed" });
      expect(fixture.findings()).toEqual([]);
    },
  );

  it.each(["missing", "wrong-id", "wrong-repo", "empty-scope", "revoked"])(
    "rejects %s cited evidence",
    async (kind) => {
      const fixture = await setup(
        {},
        { repositoryIds: kind === "empty-scope" ? [] : [repository.id] },
      );
      if (kind === "missing") fixture.evidence.delete(evidence.id);
      if (kind === "wrong-id") fixture.evidence.set(evidence.id, { ...evidence, id: "different" });
      if (kind === "wrong-repo")
        fixture.evidence.set(evidence.id, {
          ...evidence,
          repositoryId: "private",
          metadata: { repositoryId: repository.id },
        });
      if (kind === "revoked") fixture.repositories.delete(repository.id);
      await expect(fixture.send()).rejects.toMatchObject({
        code:
          kind === "revoked"
            ? "attempt_scope_revoked"
            : kind === "missing" || kind === "wrong-id"
              ? "evidence_not_found"
              : "evidence_scope_mismatch",
      });
      expect(fixture.findings()).toEqual([]);
    },
  );

  it("accepts an authorized cross-sprint prerequisite citation and scoped plan-only uncertainty", async () => {
    const prerequisite = task("dependency", { sprintId: "earlier" });
    const fixture = await setup({
      tasks: [task("task", { dependencyIds: [prerequisite.id] }), prerequisite],
      evidence: [{ ...evidence, taskId: prerequisite.id, sprintId: prerequisite.sprintId }],
    });
    await fixture.send();
    expect(fixture.citations()).toHaveLength(1);
    const planOnly = await setup({}, { repositoryIds: [] });
    await planOnly.send(
      answer([
        draft({
          state: "uncertain",
          uncertainty: "No observations available",
          nextCheckCondition: "After permission is granted",
          evidenceCitations: [],
        }),
      ]),
    );
    expect(planOnly.snapshots()[0]?.state).toBe("uncertain");
  });

  it.each(["finding", "question"])("rejects a %s about another task", async (kind) => {
    const fixture = await setup({ tasks: [task(), task("other")] });
    const result =
      kind === "finding"
        ? answer([draft({ taskId: "other" })])
        : {
            ...answer(),
            question: { question: "Which scope?", reason: "scope" as const, taskId: "other" },
          };
    await expect(fixture.send(result)).rejects.toMatchObject({ code: "task_scope_mismatch" });
  });
});

describe("partial review coverage", () => {
  it("retains an unexamined blocker locally without leaking its broader origin through acknowledgements", async () => {
    const old = prior({ private: true });
    const fixture = await setup({
      investigations: [old.investigation],
      attempts: [old.attempt],
      receipts: [old.receipt],
    });
    const response = await fixture.send();
    expect(fixture.receipts().at(-1)).toMatchObject({ retainedFindingIds: [old.finding.id] });
    expect(await assessment(fixture)).toMatchObject({ state: "blocked", finding: old.finding });
    expect(JSON.stringify(response)).not.toContain(old.finding.rationale);
    expect(await fixture.send()).toEqual(response);
  });

  it("requires permitted origin authority and replacement scope before clearing an old risk", async () => {
    const old = prior();
    const fixture = await setup({
      investigations: [old.investigation],
      attempts: [old.attempt],
      receipts: [old.receipt],
    });
    await fixture.send({ ...answer(), examinedFindingIds: [old.finding.id] });
    expect(await assessment(fixture)).toMatchObject({ state: "healthy" });
    expect(fixture.receipts().at(-1)).not.toHaveProperty("retainedFindingIds");
    const privateOld = prior({ private: true });
    const denied = await setup({
      investigations: [privateOld.investigation],
      attempts: [privateOld.attempt],
      receipts: [privateOld.receipt],
    });
    await expect(
      denied.send({ ...answer(), examinedFindingIds: [privateOld.finding.id] }),
    ).rejects.toMatchObject({ code: "evidence_scope_mismatch" });
    await expect(
      denied.send({ ...answer(), examinedFindingIds: ["missing"] }),
    ).rejects.toMatchObject({ code: "invalid_coverage" });
    expect(denied.receipts()).toEqual([privateOld.receipt]);
  });

  it("carries unexamined uncertainty and healthy untouched scopes through sprint-wide partial reviews", async () => {
    const uncertain = prior({ taskId: "task", state: "uncertain" });
    const healthy = prior({ taskId: "other", state: "healthy", id: "other-prior" });
    const fixture = await setup(
      {
        tasks: [task(), task("other"), task("unseen")],
        investigations: [uncertain.investigation, healthy.investigation],
        attempts: [uncertain.attempt, healthy.attempt],
        receipts: [uncertain.receipt, healthy.receipt],
      },
      { sprintWide: true },
    );
    const originalDigest = await fixture.store.execute((store) =>
      planningDigest(store, healthy.investigation),
    );
    await fixture.store.execute((store) =>
      store.investigations.saveAttempt({
        ...healthy.attempt,
        authority: {
          credentialHash: "seed",
          repositoryIds: [repository.id],
          toolCalls: 0,
          reservedTokens: 20_000,
          planningDigest: originalDigest,
        },
      }),
    );
    await fixture.send(answer([draft({ taskId: "task" })]));
    expect(await assessment(fixture)).toMatchObject({ state: "uncertain" });
    expect(await assessment(fixture, "other")).toMatchObject({
      state: "healthy",
      finding: healthy.finding,
      assessedAt: reviewedAt,
    });
    expect(await assessment(fixture, "unseen")).toBeUndefined();
    expect([...(fixture.receipts().at(-1)?.retainedFindingIds ?? [])].sort()).toEqual(
      [healthy.finding.id, uncertain.finding.id].sort(),
    );
  });

  it("cannot mark a different task's blocker examined without assessing that task", async () => {
    const old = prior({ taskId: "other" });
    const fixture = await setup(
      {
        tasks: [task(), task("other")],
        investigations: [old.investigation],
        attempts: [old.attempt],
        receipts: [old.receipt],
      },
      { sprintWide: true },
    );
    await expect(
      fixture.send({
        ...answer([draft({ taskId: "task" })]),
        examinedFindingIds: [old.finding.id],
      }),
    ).rejects.toMatchObject({ code: "invalid_coverage" });
  });
});

describe("bounded result schema", () => {
  it.each(["state", "riskType"] as const)(
    "rejects malformed %s objects before serialization",
    async (field) => {
      const fixture = await setup();
      const toJSON = vi.fn(() => {
        throw new Error("Unvalidated objects must not be serialized");
      });
      const malformed = draft({ [field]: { toJSON } } as unknown as Partial<RuntimeFindingDraft>);
      await expect(fixture.send(answer([malformed]))).rejects.toMatchObject({
        code: "invalid_value",
        field,
      });
      expect(toJSON).not.toHaveBeenCalled();
      expect(fixture.receipts()).toEqual([]);
      expect(fixture.findings()).toEqual([]);
    },
  );

  it("reads only supported citation fields before serializing an answer", async () => {
    const fixture = await setup();
    const extra = vi.fn(() => {
      throw new Error("Unknown citation properties must not be read");
    });
    const citation = Object.defineProperty({ evidenceId: evidence.id }, "extra", {
      enumerable: true,
      get: extra,
    });
    await fixture.send(answer([draft({ evidenceCitations: [citation] })]));
    expect(extra).not.toHaveBeenCalled();
    expect(fixture.receipts()).toHaveLength(1);
  });

  it.each([
    { version: "2" },
    { completedTasks: [] },
    { needsConfirmation: true },
    { findings: [] },
    { findings: Array.from({ length: 21 }, () => draft()) },
    {
      findings: [
        draft({
          evidenceCitations: Array.from({ length: 101 }, (_, index) => ({
            evidenceId: String(index),
          })),
        }),
      ],
    },
    {
      findings: [
        draft({ evidenceCitations: [{ evidenceId: "evidence" }, { evidenceId: " evidence " }] }),
      ],
    },
    { findings: [draft({ confidence: Number.NaN })] },
    { findings: [draft({ rationale: "x".repeat(8_001) })] },
    { findings: [draft({ nextCheckAt: "2026-02-30T00:00:00Z" })] },
    { findings: [draft({ nextCheckAt: before })] },
    { findings: [draft({ state: "blocked", riskType: "dependency_blocker" })] },
    { findings: [draft({ evidenceCitations: [] })] },
    { examinedFindingIds: Array.from({ length: 1_001 }, (_, index) => String(index)) },
    { question: { question: "Which?", reason: "invalid" } },
    { question: { question: "x".repeat(8_001), reason: "scope" } },
  ])("rejects invalid or unsupported structured answers %#", async (invalid) => {
    const fixture = await setup();
    await expect(
      fixture.send({ ...answer(), ...invalid } as InvestigationStructuredResult),
    ).rejects.toThrow();
    expect(fixture.receipts()).toEqual([]);
    expect(fixture.findings()).toEqual([]);
    expect(fixture.attempts()[0]?.status).toBe("running");
  });

  it("rejects oversized receipts before publishing any of their valid individual findings", async () => {
    const fixture = await setup();
    const findings = Array.from({ length: 11 }, (_, index) =>
      draft({
        rationale: `Finding ${String(index)}`,
        missingEvidence: Array.from(
          { length: 50 },
          (_, gap) => `${String(gap)}:${"x".repeat(3_990)}`,
        ),
      }),
    );
    await expect(fixture.send(answer(findings))).rejects.toMatchObject({
      code: "out_of_range",
      field: "result",
    });
    expect(fixture.findings()).toEqual([]);
    expect(fixture.receipts()).toEqual([]);
  });

  it.each([2_000, 2_001])(
    "refuses to silently drop retained history at %i stored findings",
    async (count) => {
      const old = prior();
      const historic = {
        ...old.receipt,
        findings: Array.from({ length: count }, (_, index) => ({
          ...old.finding,
          id: `old-${String(index)}`,
        })),
      };
      const fixture = await setup({ receipts: [historic] });
      await expect(fixture.send()).rejects.toMatchObject({ code: "out_of_range", field: "result" });
      expect(fixture.receipts()).toEqual([historic]);
      expect(fixture.findings()).toHaveLength(count);
    },
  );

  it("strips unsupported incidental draft fields and uses generated finding identity", async () => {
    const fixture = await setup({}, { sprintWide: true });
    const untrusted = {
      ...draft(),
      id: "caller",
      investigationId: "other",
      sprintId: "other",
      createdAt: "2099-01-01T00:00:00Z",
      selectedContent: "not a finding field",
    };
    await fixture.send({
      ...answer([untrusted]),
      question: { question: "Which scope?", reason: "scope" },
    });
    expect(fixture.findings()[0]).toMatchObject({
      investigationId: "current",
      sprintId: "sprint",
      createdAt: now,
    });
    expect(fixture.findings()[0]?.id).not.toBe("caller");
    expect(fixture.findings()[0]).not.toHaveProperty("selectedContent");
    expect(fixture.snapshots()[0]).not.toHaveProperty("taskId");
    expect(fixture.receipts()[0]?.question).not.toHaveProperty("taskId");
  });

  it("never returns another attempt's receipt even if it has valid persisted credentials", async () => {
    const fixture = await setup();
    await fixture.send();
    const saved = fixture.receipts()[0];
    if (saved === undefined) throw new Error("accepted receipt missing");
    await fixture.store.execute((store) =>
      store.investigations.save({
        ...saved.investigation,
        executionAttemptId: "replacement",
      }),
    );
    await expect(fixture.send()).rejects.toMatchObject({ code: "execution_lease_lost" });
  });
});

describe("healthy assessment freshness", () => {
  it.each(["task", "prerequisite", "sprint", "missing-task"])(
    "does not present an accepted healthy finding as current after changing %s",
    async (changed) => {
      const dependency = task("dependency", { sprintId: "earlier" });
      const fixture = await setup({
        tasks: [task("task", { dependencyIds: [dependency.id] }), dependency],
      });
      await fixture.send();
      expect(await assessment(fixture)).toMatchObject({ state: "healthy", assessedAt: now });
      if (changed === "sprint")
        fixture.sprints.set("sprint", { ...sprint(), assumptions: ["Changed scope"] });
      else if (changed === "missing-task") fixture.tasks.delete("task");
      else {
        const id = changed === "task" ? "task" : dependency.id;
        const saved = fixture.tasks.get(id);
        if (saved === undefined) throw new Error("fixture task missing");
        fixture.tasks.set(id, { ...saved, version: 2 });
      }
      expect(await assessment(fixture)).toMatchObject({
        state: "uncertain",
        assessedAt: now,
        coverageGap:
          "The saved healthy finding does not verify the current plan; review is required.",
        finding: { state: "healthy" },
      });
    },
  );

  it("writes an uncertain snapshot when a partial review carries healthy work whose inputs changed before this attempt", async () => {
    const old = prior({ taskId: "other", state: "healthy" });
    const fixture = await setup(
      {
        tasks: [task(), task("other")],
        investigations: [old.investigation],
        attempts: [old.attempt],
        receipts: [old.receipt],
      },
      { sprintWide: true },
    );
    const originalDigest = await fixture.store.execute((store) =>
      planningDigest(store, old.investigation),
    );
    await fixture.store.execute((store) =>
      store.investigations.saveAttempt({
        ...old.attempt,
        authority: {
          credentialHash: "seed",
          repositoryIds: [repository.id],
          toolCalls: 0,
          reservedTokens: 20_000,
          planningDigest: originalDigest,
        },
      }),
    );
    fixture.tasks.set("other", task("other", { version: 2 }));
    const admitted = await fixture.store.execute((store) =>
      createAttemptAuthority(store, fixture.investigation, {
        token: fixture.token,
        repositoryIds: [repository.id],
        now,
      }),
    );
    await fixture.store.execute((store) =>
      store.investigations.saveAttempt({ ...fixture.attempt, authority: admitted }),
    );
    await fixture.send(answer([draft({ taskId: "task" })]));
    expect(fixture.snapshots().find((item) => item.taskId === "other")).toMatchObject({
      state: "uncertain",
      findingId: old.finding.id,
    });
    expect(await assessment(fixture, "other")).toMatchObject({
      state: "uncertain",
      assessedAt: reviewedAt,
      finding: old.finding,
      coverageGap:
        "The saved healthy finding does not verify the current plan; review is required.",
    });
  });

  it("cannot certify health without the source authority's saved planning digest", async () => {
    const fixture = await setup();
    await fixture.send();
    const saved = fixture.attempts()[0];
    if (saved === undefined) throw new Error("attempt missing");
    const missing = { ...saved };
    delete missing.authority;
    await fixture.store.execute((store) => store.investigations.saveAttempt(missing));
    expect(await assessment(fixture)).toMatchObject({
      state: "uncertain",
      coverageGap:
        "The saved healthy finding does not verify the current plan; review is required.",
    });
  });

  it("advances retained assessment time for feedback without attributing it to the later partial review", async () => {
    const old = prior();
    const correctedAt = "2026-09-24T01:30:00.000Z";
    const fixture = await setup({
      investigations: [old.investigation],
      attempts: [old.attempt],
      receipts: [old.receipt],
      feedback: [
        {
          id: "correction",
          findingId: old.finding.id,
          kind: "correct",
          correction: { statement: "Dependency still pending" },
          actor: "developer",
          source: "dashboard",
          createdAt: correctedAt,
        },
      ],
    });
    await fixture.send();
    expect(await assessment(fixture)).toMatchObject({
      state: "blocked",
      assessedAt: correctedAt,
      statement: "Dependency still pending",
    });
  });
});

describe("submission input snapshots", () => {
  it("captures credentials, bounded nested answers, and usage before asynchronous authentication", async () => {
    const fixture = await setup();
    const finding = {
      state: "healthy" as const,
      confidence: 0.8,
      rationale: "Original rationale",
      evidenceCitations: [{ evidenceId: evidence.id }],
    };
    const input = {
      token: fixture.token,
      result: {
        version: "1" as const,
        findings: [finding],
        question: { question: "Original question", reason: "scope" as const },
      },
      usage: { totalTokens: 5 },
    };
    const pending = fixture.submit.execute(input);
    input.token = "changed";
    finding.rationale = "Changed rationale";
    finding.evidenceCitations[0] = { evidenceId: "missing" };
    input.result.question.question = "Changed question";
    input.usage.totalTokens = 999;
    await pending;
    expect(fixture.findings()[0]?.rationale).toBe("Original rationale");
    expect(fixture.receipts()[0]?.question?.question).toBe("Original question");
    expect(fixture.attempts()[0]?.usage?.totalTokens).toBe(5);
  });

  it.each(["rationale", "question", "citation"])(
    "refuses a credential echoed in bounded normalized %s data",
    async (field) => {
      const fixture = await setup();
      const result =
        field === "question"
          ? { ...answer(), question: { question: fixture.token, reason: "scope" as const } }
          : answer([
              field === "rationale"
                ? draft({ rationale: fixture.token })
                : draft({ evidenceCitations: [{ evidenceId: evidence.id, note: fixture.token }] }),
            ]);
      await expect(fixture.send(result)).rejects.toMatchObject({
        code: "invalid_value",
        field: "result",
      });
      expect(fixture.receipts()).toEqual([]);
      expect(fixture.findings()).toEqual([]);
    },
  );
});
