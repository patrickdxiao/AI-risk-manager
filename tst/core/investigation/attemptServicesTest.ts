import { describe, expect, it } from "vitest";
import { createEvidenceItem, type EvidenceItem } from "../../../src/core/evidence/evidenceModel.js";
import { createSprint, createTask } from "../../../src/core/planning/planningModel.js";
import { createRepository } from "../../../src/core/repository/repositoryModel.js";
import { ApplicationError, DomainInvariantError } from "../../../src/core/primitives.js";
import type { SubmittedInvestigationResult } from "../../../src/core/storageContracts.js";
import type { TriggerDispatch } from "../../../src/core/triggers/triggerModel.js";
import {
  assertBudgetAvailable,
  assertExecutionOwnership,
  assertRepositoryScope,
  authorizeAttempt,
  createAttemptAuthority,
  credentialHash,
  newAttemptToken,
} from "../../../src/core/investigation/attemptAuthority.js";
import {
  evidenceInScope,
  evidenceMatchesScope,
  planningDigest,
  selectPlanningContext,
} from "../../../src/core/investigation/evidenceScope.js";
import {
  CancelInvestigationAttempt,
  GetInvestigationContext,
  GetInvestigationEvidence,
  ListSprintInvestigations,
} from "../../../src/core/investigation/investigationLifecycle.js";
import {
  claimInvestigationExecution,
  createInvestigation,
  startInvestigation,
  type InvestigationAttempt,
} from "../../../src/core/investigation/investigationModel.js";
import { investigationFixture } from "../../fixtures/investigationFixture.js";

const now = "2026-09-24T12:00:00.000Z",
  leaseUntil = "2026-09-24T12:01:00.000Z";
const clock = { now: () => now };
const sprint = createSprint({
  id: "sprint",
  startAt: now,
  endAt: "2026-09-30T12:00:00Z",
  createdAt: now,
  pointTarget: 5,
  reviewCadenceMinutes: 30,
});
const task = createTask({
  id: "checkout",
  sprintId: sprint.id,
  title: "Checkout",
  points: 3,
  createdAt: now,
  startAt: now,
  endAt: sprint.endAt,
  dependencyIds: ["api"],
});
const dependency = createTask({ ...task, id: "api", sprintId: "previous", dependencyIds: [] });
const repository = createRepository({
  id: "web",
  canonicalPath: "/approved/web",
  gitRoot: "/approved/web",
  identityDigest: "identity",
  registeredAt: now,
});
const investigation = claimInvestigationExecution(
  startInvestigation(
    createInvestigation({
      id: "review",
      sprintId: sprint.id,
      taskId: task.id,
      triggerId: "trigger",
      requestedAt: now,
    }),
    now,
  ),
  { now, leaseUntil },
);
const token = newAttemptToken("review:attempt:1", "test-secret");
const authority = Object.freeze({
  credentialHash: credentialHash(token),
  repositoryIds: Object.freeze(["web"]),
  planningDigest: "plan",
  toolCalls: 0,
  reservedTokens: 20_000,
});
const attempt: InvestigationAttempt = Object.freeze({
  id: "review:attempt:1",
  investigationId: investigation.id,
  version: 1,
  status: "running",
  startedAt: now,
  leaseUntil,
  timeoutMs: 60_000,
  queueWaitMs: 0,
  promptVersion: "v1",
  resultSchemaVersion: "1",
  authority,
});
const evidence = (overrides: Partial<EvidenceItem> = {}) =>
  createEvidenceItem({
    id: "evidence",
    eventId: "event",
    repositoryId: "web",
    source: "git",
    kind: "commit",
    occurredAt: now,
    locator: "git:commit",
    summary: "Commit observed",
    digest: "digest",
    privacyMode: "metadata_only",
    metadata: {},
    ...overrides,
  });
const dispatch: TriggerDispatch = {
  version: "trigger-dispatch.v1",
  triggerId: investigation.triggerId,
  investigationId: investigation.id,
  status: "leased",
  leaseVersion: 2,
  attempts: 1,
  dueAt: now,
  leaseExpiresAt: leaseUntil,
  createdAt: now,
  updatedAt: now,
};
const ownedAttempt = { ...attempt, dispatchTriggerId: dispatch.triggerId, dispatchLeaseVersion: 2 };
function setup(overrides: Parameters<typeof investigationFixture>[0] = {}) {
  return investigationFixture({
    sprints: [sprint],
    tasks: [task, dependency],
    repositories: [repository],
    investigations: [investigation],
    attempts: [attempt],
    evidence: [evidence()],
    ...overrides,
  });
}

function receipt(): SubmittedInvestigationResult {
  return {
    resultDigest: "prior-result",
    investigation: {
      ...investigation,
      id: "previous-review",
      status: "completed",
      executionAttemptId: "prior-attempt",
    },
    findings: [
      {
        id: "finding",
        investigationId: "previous-review",
        sprintId: sprint.id,
        taskId: task.id,
        state: "uncertain",
        confidence: 0.2,
        rationale: "Unverified",
        missingEvidence: ["No test run"],
        createdAt: now,
      },
    ],
    citations: [{ findingId: "finding", evidenceId: "evidence" }],
    riskSnapshots: [],
    riskTransitions: [],
  };
}
const priorAttempt = {
  ...attempt,
  id: "prior-attempt",
  investigationId: "previous-review",
  status: "succeeded" as const,
  usage: { totalTokens: 10 },
};

describe("fixed attempt authority", () => {
  it("normalizes and freezes explicit repository scope without inheriting other registered repositories", async () => {
    const fixture = setup({ repositories: [repository, { ...repository, id: "other" }] });
    const repositoryIds = [" web ", "web"];
    const value = await fixture.store.execute((store) =>
      createAttemptAuthority(store, investigation, { token, repositoryIds, now }),
    );
    repositoryIds.push("other");
    expect(value).toMatchObject({
      credentialHash: credentialHash(token),
      repositoryIds: ["web"],
      toolCalls: 0,
      reservedTokens: 20_000,
    });
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.repositoryIds)).toBe(true);
    expect(value).not.toHaveProperty("token");
    const empty = await fixture.store.execute((store) =>
      createAttemptAuthority(store, investigation, { token, repositoryIds: [], now }),
    );
    expect(empty.repositoryIds).toEqual([]);
    await expect(
      fixture.store.execute((store) =>
        createAttemptAuthority(store, investigation, { token, repositoryIds: ["absent"], now }),
      ),
    ).rejects.toMatchObject({ code: "attempt_scope_revoked" });
  });

  it("binds credentials to one attempt and charges only accepted authorized calls", async () => {
    const fixture = setup();
    const first = await fixture.store.execute((store) => authorizeAttempt(store, token, now));
    expect(first.attempt.authority.toolCalls).toBe(1);
    await fixture.store.execute((store) => authorizeAttempt(store, token, now, false));
    expect(fixture.attempts()[0]?.authority?.toolCalls).toBe(1);
    expect(Object.isFrozen(first.attempt.authority.repositoryIds)).toBe(true);
    expect(newAttemptToken(attempt.id, "other-secret")).not.toBe(token);
    expect(newAttemptToken(attempt.id)).not.toBe(token);
    await expect(
      fixture.store.execute((store) =>
        authorizeAttempt(store, newAttemptToken(attempt.id, "wrong-secret"), now),
      ),
    ).rejects.toMatchObject({ code: "attempt_unauthorized" });
  });

  it.each(["", "risk_attempt.bad.bad", newAttemptToken("missing", "test-secret")])(
    "rejects absent or malformed credentials %#",
    async (credential) => {
      const fixture = setup();
      await expect(
        new GetInvestigationEvidence(fixture.store, clock).execute(credential, ["evidence"]),
      ).rejects.toMatchObject({ code: "attempt_unauthorized" });
      expect(fixture.evidenceReads).toEqual([]);
    },
  );

  it("denies missing authority and malformed credential hashes", async () => {
    const missing = { ...attempt };
    delete missing.authority;
    for (const item of [
      missing,
      { ...attempt, authority: { ...authority, credentialHash: "not-hex" } },
    ]) {
      const fixture = setup({ attempts: [item] });
      await expect(
        fixture.store.execute((store) => authorizeAttempt(store, token, now)),
      ).rejects.toMatchObject({ code: "attempt_unauthorized" });
    }
    await expect(
      setup().store.execute((store) => assertRepositoryScope(store, missing)),
    ).rejects.toMatchObject({ code: "attempt_unauthorized" });
    await expect(
      setup({ investigations: [] }).store.execute((store) => authorizeAttempt(store, token, now)),
    ).rejects.toMatchObject({ code: "attempt_unauthorized" });
  });

  it("denies revoked repositories even when a matching evidence record remains stored", async () => {
    const fixture = setup();
    fixture.repositories.delete(repository.id);
    await expect(
      new GetInvestigationEvidence(fixture.store, clock).execute(token, ["evidence"]),
    ).rejects.toMatchObject({ code: "attempt_scope_revoked" });
    expect(fixture.evidenceReads).toEqual([]);
  });

  it("enforces a shared tool-call limit across concurrent callers", async () => {
    const fixture = setup({
      attempts: [{ ...attempt, authority: { ...authority, toolCalls: 11 } }],
    });
    const results = await Promise.allSettled([
      fixture.store.execute((store) => authorizeAttempt(store, token, now)),
      fixture.store.execute((store) => authorizeAttempt(store, token, now)),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(fixture.attempts()[0]?.authority?.toolCalls).toBe(12);
    await expect(
      fixture.store.execute((store) => authorizeAttempt(store, token, now)),
    ).rejects.toMatchObject({ code: "tool_budget_exhausted" });
  });
});

describe("transactional execution ownership", () => {
  it.each([
    { investigations: [{ ...investigation, status: "failed" as const }] },
    { investigations: [{ ...investigation, executionAttemptId: "new-owner" }] },
    { investigations: [{ ...investigation, executionLeaseUntil: now }] },
    { attempts: [] },
    { attempts: [{ ...attempt, status: "expired" as const }] },
    { attempts: [{ ...attempt, investigationId: "other" }] },
    { attempts: [{ ...attempt, version: 2 }] },
    { attempts: [{ ...attempt, leaseUntil: now }] },
    { attempts: [{ ...attempt, startedAt: leaseUntil }] },
    { investigations: [{ ...investigation, id: "other" }, investigation] },
    { attempts: [{ ...attempt, dispatchLeaseVersion: 1 }] },
  ])("rejects stale or inconsistent ownership %#", async (seed) => {
    const fixture = setup(seed);
    await expect(
      fixture.store.execute((store) =>
        assertExecutionOwnership(
          store,
          seed.investigations?.find((item) => item.id === investigation.id) ?? investigation,
          attempt.id,
          now,
        ),
      ),
    ).rejects.toMatchObject({ code: "execution_lease_lost" });
  });

  it("checks the dispatch owner and deadline as well as the attempt lease", async () => {
    const fixture = setup({ attempts: [ownedAttempt], dispatches: [dispatch] });
    await expect(
      fixture.store.execute((store) =>
        assertExecutionOwnership(store, investigation, attempt.id, now),
      ),
    ).resolves.toEqual(ownedAttempt);
    for (const invalid of [
      undefined,
      { ...dispatch, status: "pending" as const },
      { ...dispatch, investigationId: "other" },
      { ...dispatch, leaseVersion: 3 },
      { ...dispatch, leaseExpiresAt: now },
    ]) {
      await expect(
        setup({
          attempts: [ownedAttempt],
          dispatches: invalid === undefined ? [] : [invalid],
        }).store.execute((store) =>
          assertExecutionOwnership(store, investigation, attempt.id, now),
        ),
      ).rejects.toMatchObject({ code: "execution_lease_lost" });
    }
  });
});

describe("conservative token admission", () => {
  const old = "2026-09-20T00:00:00Z";
  it("retains ten old unknown reservations after cancellation and timeout", async () => {
    const attempts = Array.from({ length: 10 }, (_, index) => ({
      ...attempt,
      id: String(index),
      startedAt: old,
      status: index % 2 === 0 ? ("cancelled" as const) : ("expired" as const),
    }));
    await expect(
      setup({ attempts }).store.execute((store) => assertBudgetAvailable(store, now)),
    ).rejects.toMatchObject({ code: "investigation_budget_exhausted" });
    await expect(
      setup({ attempts: attempts.slice(1) }).store.execute((store) =>
        assertBudgetAvailable(store, now),
      ),
    ).resolves.toBeUndefined();
  });

  it("deduplicates recent unsettled attempts and does not release active reservations on partial usage", async () => {
    const attempts = Array.from({ length: 9 }, (_, index) => ({
      ...attempt,
      id: String(index),
      usage: { totalTokens: 0 },
    }));
    await expect(
      setup({ attempts }).store.execute((store) => assertBudgetAvailable(store, now)),
    ).resolves.toBeUndefined();
    await expect(
      setup({
        attempts: [...attempts, { ...attempt, id: "tenth", usage: { totalTokens: 0 } }],
      }).store.execute((store) => assertBudgetAvailable(store, now)),
    ).rejects.toMatchObject({ code: "investigation_budget_exhausted" });
  });

  it("uses reported totals once work ends and keeps unknown legacy reservations", async () => {
    const missing = { ...attempt, id: "legacy", startedAt: old };
    delete missing.authority;
    const fixture = setup({
      attempts: [
        missing,
        { ...attempt, id: "settled", status: "succeeded", usage: { totalTokens: 180_001 } },
      ],
    });
    await expect(
      fixture.store.execute((store) => assertBudgetAvailable(store, now)),
    ).rejects.toMatchObject({ code: "investigation_budget_exhausted" });
    await expect(
      setup({
        attempts: [
          { ...attempt, status: "succeeded", startedAt: old, usage: { totalTokens: 1_000_000 } },
        ],
      }).store.execute((store) => assertBudgetAvailable(store, now)),
    ).resolves.toBeUndefined();
  });
});

describe("explicit planning and evidence scope", () => {
  it("loads and fingerprints prerequisite versions across sprints without adding repository access", async () => {
    const fixture = setup();
    const plan = await fixture.store.execute((store) =>
      selectPlanningContext(store, investigation),
    );
    expect(plan.tasks).toEqual([task]);
    expect(plan.dependencies).toEqual([dependency]);
    const original = await fixture.store.execute((store) => planningDigest(store, investigation));
    fixture.tasks.set(dependency.id, { ...dependency, version: 2 });
    expect(await fixture.store.execute((store) => planningDigest(store, investigation))).not.toBe(
      original,
    );
    expect(Object.isFrozen(plan.tasks)).toBe(true);
    expect(
      evidenceInScope(
        evidence({ taskId: dependency.id, sprintId: dependency.sprintId }),
        investigation,
        attempt,
        plan,
      ),
    ).toBe(true);
    expect(
      evidenceInScope(
        evidence({ repositoryId: "private", taskId: dependency.id, sprintId: dependency.sprintId }),
        investigation,
        attempt,
        plan,
      ),
    ).toBe(false);
  });

  it("loads sprint-wide context deterministically and rejects missing or mismatched planning records", async () => {
    const fixture = setup();
    expect(
      (
        await fixture.store.execute((store) =>
          selectPlanningContext(store, { sprintId: sprint.id }),
        )
      ).tasks,
    ).toEqual([task]);
    for (const [seed, scope, code] of [
      [{ sprints: [] }, investigation, "sprint_not_found"],
      [{ tasks: [] }, investigation, "task_not_found"],
      [{ tasks: [task] }, investigation, "task_not_found"],
      [{}, { sprintId: sprint.id, taskId: dependency.id }, "task_scope_mismatch"],
    ] as const)
      await expect(
        setup(seed).store.execute((store) => selectPlanningContext(store, scope)),
      ).rejects.toMatchObject({ code });
  });

  it("bounds context size and traversal work instead of silently omitting prerequisites", async () => {
    const tasks = Array.from({ length: 1_001 }, (_, index) => ({
      ...task,
      id: String(index),
      dependencyIds: [],
    }));
    await expect(
      setup({ tasks }).store.execute((store) =>
        selectPlanningContext(store, { sprintId: sprint.id }),
      ),
    ).rejects.toBeInstanceOf(DomainInvariantError);
    const repeated = Array.from({ length: 11 }, (_, index) => ({
      ...task,
      id: String(index),
      dependencyIds: Array.from({ length: 1_000 }, () => "0"),
    }));
    await expect(
      setup({ tasks: repeated }).store.execute((store) =>
        selectPlanningContext(store, { sprintId: sprint.id }),
      ),
    ).rejects.toBeInstanceOf(DomainInvariantError);
  });

  it("fails closed without authority and never takes repository permission from metadata", () => {
    const observation = evidence();
    expect(evidenceInScope(observation, investigation)).toBe(false);
    const missing = { ...attempt };
    delete missing.authority;
    expect(evidenceInScope(observation, investigation, missing)).toBe(false);
    expect(
      evidenceInScope(observation, investigation, { ...attempt, investigationId: "other" }),
    ).toBe(false);
    expect(
      evidenceInScope(
        {
          ...observation,
          repositoryId: undefined,
          metadata: { repositoryId: "web" },
        } as unknown as EvidenceItem,
        investigation,
        attempt,
      ),
    ).toBe(false);
    expect(evidenceInScope(observation, investigation, attempt)).toBe(true);
    expect(
      evidenceInScope(
        evidence({ repositoryId: "private", metadata: { repositoryId: "web" } }),
        investigation,
        attempt,
      ),
    ).toBe(false);
    expect(evidenceInScope(evidence({ sprintId: "other" }), investigation, attempt)).toBe(false);
    expect(evidenceInScope(evidence({ taskId: "other" }), investigation, attempt)).toBe(false);
  });

  it("scopes non-repository plan evidence and validates prerequisite sprint hints", async () => {
    const plan = await setup().store.execute((store) =>
      selectPlanningContext(store, investigation),
    );
    const planEvidence = {
      ...evidence(),
      repositoryId: undefined,
      source: "user",
      kind: "task_state_change",
    } as unknown as EvidenceItem;
    expect(evidenceInScope(planEvidence, investigation, attempt)).toBe(false);
    expect(evidenceInScope({ ...planEvidence, sprintId: sprint.id }, investigation, attempt)).toBe(
      true,
    );
    expect(
      evidenceInScope(
        { ...planEvidence, taskId: dependency.id, sprintId: dependency.sprintId },
        investigation,
        attempt,
        plan,
      ),
    ).toBe(true);
    expect(
      evidenceInScope(
        { ...planEvidence, taskId: dependency.id, sprintId: "wrong" },
        investigation,
        attempt,
        plan,
      ),
    ).toBe(false);
    expect(
      evidenceMatchesScope(evidence({ taskId: "unknown" }), {
        sprintId: sprint.id,
        repositoryIds: ["web"],
      }),
    ).toBe(false);
    expect(
      evidenceMatchesScope(evidence(), { sprintId: "wrong", repositoryIds: ["web"] }, plan),
    ).toBe(false);
    expect(evidenceMatchesScope(evidence(), { sprintId: sprint.id, repositoryIds: [] }, plan)).toBe(
      false,
    );
  });
});

describe("authorized context reads", () => {
  it("reads allowed stored evidence and denies mixed, missing, or malformed requests atomically", async () => {
    const fixture = setup({
      evidence: [evidence(), evidence({ id: "private", repositoryId: "private" })],
    });
    const read = new GetInvestigationEvidence(fixture.store, clock);
    const result = await read.execute(token, [" evidence "]);
    expect(result.map((item) => item.id)).toEqual(["evidence"]);
    expect(Object.isFrozen(result)).toBe(true);
    await expect(read.execute(token, ["evidence", "private"])).rejects.toMatchObject({
      code: "evidence_scope_mismatch",
    });
    await expect(read.execute(token, ["missing"])).rejects.toMatchObject({
      code: "evidence_not_found",
    });
    for (const ids of [
      [],
      ["evidence", " evidence "],
      Array.from({ length: 51 }, (_, index) => String(index)),
    ])
      await expect(read.execute(token, ids)).rejects.toBeInstanceOf(DomainInvariantError);
    expect(fixture.attempts()[0]?.authority?.toolCalls).toBe(6);
  });

  it("charges repeated authenticated read failures so missing IDs cannot bypass the call limit", async () => {
    const fixture = setup();
    const read = new GetInvestigationEvidence(fixture.store, clock);
    for (let call = 0; call < 12; call += 1)
      await expect(read.execute(token, ["missing"])).rejects.toMatchObject({
        code: "evidence_not_found",
      });
    expect(fixture.attempts()[0]?.authority?.toolCalls).toBe(12);
    await expect(read.execute(token, ["missing"])).rejects.toMatchObject({
      code: "tool_budget_exhausted",
    });
  });

  it("includes approved reusable observations and prerequisite evidence but omits other repositories", async () => {
    const fixture = setup({
      evidence: [
        evidence(),
        evidence({ id: "prerequisite", taskId: dependency.id, sprintId: dependency.sprintId }),
        evidence({ id: "denied", repositoryId: "private", sprintId: sprint.id }),
      ],
    });
    const context = await new GetInvestigationContext(fixture.store, clock).execute(token);
    expect(context.dependencies).toEqual([dependency]);
    expect(context.evidence.map((item) => item.id).sort()).toEqual(["evidence", "prerequisite"]);
    expect(context.findings).toEqual([]);
    expect(context.limitations.join(" ")).toContain("bounded sample");
    expect(Object.isFrozen(context)).toBe(true);
  });

  it("includes prior findings and current feedback only when their authority and citations remain allowed", async () => {
    const saved = receipt();
    const fixture = setup({
      attempts: [attempt, priorAttempt],
      receipts: [saved],
      feedback: [
        {
          id: "feedback",
          findingId: "finding",
          kind: "correct",
          correction: { statement: "API is ready" },
          actor: "user",
          source: "dashboard",
          createdAt: now,
        },
      ],
    });
    const context = await new GetInvestigationContext(fixture.store, clock).execute(token);
    expect(context.findings).toEqual(saved.findings);
    expect(context.citations).toEqual(saved.citations);
    expect(context.feedback).toHaveLength(1);
    for (const seed of [
      { receipts: [saved] },
      {
        receipts: [saved],
        attempts: [
          attempt,
          { ...priorAttempt, authority: { ...authority, repositoryIds: ["private"] } },
        ],
      },
      { receipts: [saved], attempts: [attempt, priorAttempt], evidence: [] },
      {
        receipts: [saved],
        attempts: [attempt, priorAttempt],
        evidence: [evidence({ repositoryId: "private" })],
      },
      {
        receipts: [
          {
            ...saved,
            findings: [
              {
                ...(saved.findings.at(0) as NonNullable<
                  SubmittedInvestigationResult["findings"][number]
                >),
                sprintId: "other",
              },
            ],
          },
        ],
        attempts: [attempt, priorAttempt],
      },
    ]) {
      const hidden = await new GetInvestigationContext(setup(seed).store, clock).execute(token);
      expect(hidden.findings).toEqual([]);
      expect(hidden.citations).toEqual([]);
      expect(hidden.feedback).toEqual([]);
      expect(hidden.limitations.join(" ")).toContain("could not be verified");
    }
  });

  it("labels truncated context rather than presenting it as a full review", async () => {
    const tasks = Array.from({ length: 101 }, (_, index) => ({
      ...task,
      id: String(index),
      dependencyIds: [],
    }));
    const sprintReview = { ...investigation };
    delete sprintReview.taskId;
    const fixture = setup({
      tasks,
      investigations: [sprintReview],
      evidence: Array.from({ length: 21 }, (_, index) => evidence({ id: String(index) })),
    });
    const context = await new GetInvestigationContext(fixture.store, clock).execute(token);
    expect(context.tasks).toHaveLength(100);
    expect(context.evidence).toHaveLength(20);
    expect(context.limitations.join(" ")).toContain("does not cover the entire plan");
  });

  it("checks retained findings against their original authority, independently of the containing receipt", async () => {
    const saved = receipt();
    const original = {
      ...saved.investigation,
      id: "original-review",
      executionAttemptId: "original-attempt",
    };
    const originalAttempt = {
      ...priorAttempt,
      id: "original-attempt",
      investigationId: original.id,
    };
    const retained = {
      ...(saved.findings[0] as SubmittedInvestigationResult["findings"][number]),
      investigationId: original.id,
    };
    const retainedReceipt = {
      ...saved,
      findings: [retained, { ...retained, id: "other-retained" }],
      citations: [],
    };
    const allowed = setup({
      investigations: [investigation, original],
      attempts: [
        attempt,
        { ...priorAttempt, authority: { ...authority, repositoryIds: ["private"] } },
        originalAttempt,
      ],
      receipts: [retainedReceipt],
    });
    expect(
      (await new GetInvestigationContext(allowed.store, clock).execute(token)).findings,
    ).toEqual(retainedReceipt.findings);
    for (const originSeed of [
      { investigations: [investigation], attempts: [attempt, priorAttempt, originalAttempt] },
      { investigations: [investigation, original], attempts: [attempt, priorAttempt] },
      {
        investigations: [investigation, original],
        attempts: [
          attempt,
          priorAttempt,
          { ...originalAttempt, authority: { ...authority, repositoryIds: ["private"] } },
        ],
      },
      {
        investigations: [investigation, original],
        attempts: [attempt, priorAttempt, { ...originalAttempt, investigationId: "other" }],
      },
      {
        investigations: [investigation, { ...original, status: "running" as const }],
        attempts: [attempt, priorAttempt, originalAttempt],
      },
      {
        investigations: [investigation, original],
        attempts: [attempt, priorAttempt, { ...originalAttempt, status: "failed" as const }],
      },
    ]) {
      const fixture = setup({ ...originSeed, receipts: [retainedReceipt] });
      const context = await new GetInvestigationContext(fixture.store, clock).execute(token);
      expect(context.findings).toEqual([]);
      expect(context.limitations.join(" ")).toContain("could not be verified");
    }
    const lostCitation = setup({
      investigations: [investigation, original],
      attempts: [attempt, priorAttempt, originalAttempt],
      receipts: [{ ...retainedReceipt, findings: [retained], citations: saved.citations }],
      evidence: [evidence({ repositoryId: "private" })],
    });
    expect(
      (await new GetInvestigationContext(lostCitation.store, clock).execute(token)).findings,
    ).toEqual([]);
  });
});

describe("local cancellation and history", () => {
  it("cancels the current attempt and dispatch without releasing its reservation, and is idempotent", async () => {
    const fixture = setup({ attempts: [ownedAttempt], dispatches: [dispatch] });
    const cancel = new CancelInvestigationAttempt(fixture.store, clock);
    await cancel.execute({ investigationId: investigation.id, executionAttemptId: attempt.id });
    await cancel.execute({ investigationId: investigation.id, executionAttemptId: attempt.id });
    expect(fixture.investigations()[0]).toMatchObject({
      status: "failed",
      failure: { retryable: false, code: "execution_cancelled" },
    });
    expect(fixture.attempts()[0]).toMatchObject({
      status: "cancelled",
      authority: { reservedTokens: 20_000 },
      durationMs: 0,
    });
    expect(fixture.dispatches()[0]).toMatchObject({
      status: "dead",
      failureCode: "execution_cancelled",
    });
    expect(fixture.dispatches()[0]).not.toHaveProperty("leaseExpiresAt");
    await expect(
      new GetInvestigationEvidence(fixture.store, clock).execute(token, ["evidence"]),
    ).rejects.toMatchObject({ code: "execution_lease_lost" });
  });

  it("cancels queued work and leaves no active dispatch for it", async () => {
    const queued = createInvestigation({ ...investigation });
    const fixture = setup({
      investigations: [queued],
      attempts: [],
      dispatches: [{ ...dispatch, status: "pending" }],
    });
    await new CancelInvestigationAttempt(fixture.store, clock).execute({
      investigationId: investigation.id,
    });
    expect(fixture.investigations()[0]?.status).toBe("failed");
    expect(fixture.dispatches()[0]?.status).toBe("dead");
    const cancelled = fixture.investigations(),
      dispatches = fixture.dispatches();
    await new CancelInvestigationAttempt(fixture.store, { now: () => leaseUntil }).execute({
      investigationId: investigation.id,
    });
    expect(fixture.investigations()).toEqual(cancelled);
    expect(fixture.dispatches()).toEqual(dispatches);
    const noDispatch = setup({ investigations: [queued], attempts: [] });
    await new CancelInvestigationAttempt(noDispatch.store, clock).execute({
      investigationId: investigation.id,
    });
  });

  it("rejects missing/stale cancellation targets and rolls back when dispatch fencing fails", async () => {
    const fixture = setup();
    await expect(
      new CancelInvestigationAttempt(fixture.store, clock).execute({ investigationId: "missing" }),
    ).rejects.toMatchObject({ code: "investigation_not_found" });
    await expect(
      new CancelInvestigationAttempt(fixture.store, clock).execute({
        investigationId: investigation.id,
      }),
    ).rejects.toMatchObject({ code: "execution_lease_lost" });
    await expect(
      new CancelInvestigationAttempt(fixture.store, clock).execute({
        investigationId: investigation.id,
        executionAttemptId: "old",
      }),
    ).rejects.toMatchObject({ code: "execution_lease_lost" });
    const fenced = setup({ attempts: [ownedAttempt], dispatches: [dispatch], failFenced: true });
    await expect(
      new CancelInvestigationAttempt(fenced.store, clock).execute({
        investigationId: investigation.id,
        executionAttemptId: attempt.id,
      }),
    ).rejects.toMatchObject({ code: "execution_lease_lost" });
    expect(fenced.investigations()).toEqual([investigation]);
    expect(fenced.attempts()).toEqual([ownedAttempt]);
    const mismatched = setup({ dispatches: [dispatch] });
    await expect(
      new CancelInvestigationAttempt(mismatched.store, clock).execute({
        investigationId: investigation.id,
        executionAttemptId: attempt.id,
      }),
    ).rejects.toMatchObject({ code: "execution_lease_lost" });
  });

  it("lists bounded sprint history with pending, expired, running, and terminal states", async () => {
    const records = [
      { ...investigation, id: "pending", executionLeaseUntil: undefined },
      { ...investigation, id: "expired", executionLeaseUntil: now },
      investigation,
      { ...investigation, id: "completed", status: "completed" },
      { ...investigation, id: "failed", status: "failed" },
    ] as unknown as (typeof investigation)[];
    const fixture = setup({ investigations: records });
    const list = new ListSprintInvestigations(fixture.store, clock);
    const history = await list.execute(sprint.id, 5);
    expect(history.investigations.map((item) => item.executionState)).toEqual([
      "pending",
      "lease_expired",
      "running",
      "completed",
      "failed",
    ]);
    expect(history.hasMore).toBe(false);
    expect((await list.execute(sprint.id, 1)).hasMore).toBe(true);
    expect(() => list.execute(sprint.id, 0)).toThrow(DomainInvariantError);
    expect(() => list.execute(sprint.id, 21)).toThrow(DomainInvariantError);
    await expect(list.execute("absent", 1)).rejects.toBeInstanceOf(ApplicationError);
  });
});
