import { createEvidenceItem, type EvidenceItem } from "../../src/core/evidence/evidenceModel.js";
import { createFinding, type Finding } from "../../src/core/investigation/findingModel.js";
import {
  createSprint,
  createTask,
  type Sprint,
  type Task,
} from "../../src/core/planning/planningModel.js";
import { createRepository, type Repository } from "../../src/core/repository/repositoryModel.js";
import type { FindingFeedback } from "../../src/core/risk/findingFeedback.js";
import type { RiskSnapshot, RiskTransition } from "../../src/core/risk/riskModel.js";
import type {
  SubmittedInvestigationResult,
  TransactionContext,
  UnitOfWorkPort,
} from "../../src/core/storageContracts.js";
import { planningFixture } from "./planningFixture.js";

export const before = "2026-09-20T00:00:00.000Z";
export const reviewedAt = "2026-09-24T01:00:00.000Z";
export const now = "2026-09-24T02:00:00.000Z";
export const repository = createRepository({
  id: "repo",
  canonicalPath: "/repo",
  gitRoot: "/repo",
  identityDigest: "identity",
  registeredAt: before,
});
export const evidence = createEvidenceItem({
  id: "evidence",
  eventId: "event",
  repositoryId: repository.id,
  source: "git",
  kind: "commit",
  occurredAt: before,
  locator: "HEAD",
  summary: "Saved observation",
  digest: "digest",
  privacyMode: "metadata_only",
  metadata: {},
});
export const sprint = (id = "sprint", overrides: Partial<Sprint> = {}) =>
  createSprint({
    id,
    startAt: "2026-09-24T00:00:00Z",
    endAt: "2026-10-01T00:00:00Z",
    createdAt: before,
    pointTarget: 8,
    reviewCadenceMinutes: 30,
    state: "active",
    ...overrides,
  });
export const task = (id = "task", overrides: Partial<Task> = {}) =>
  createTask({
    id,
    sprintId: "sprint",
    title: id,
    points: 3,
    startAt: "2026-09-24T00:00:00Z",
    endAt: "2026-10-01T00:00:00Z",
    createdAt: before,
    ...overrides,
  });
export const finding = (id = "finding", overrides: Partial<Finding> = {}) =>
  createFinding(
    {
      id,
      investigationId: "investigation",
      sprintId: "sprint",
      taskId: "task",
      state: "blocked",
      riskType: "dependency_blocker",
      rationale: "Waiting for the API",
      confidence: 0.8,
      nextCheckCondition: "When the API lands",
      createdAt: reviewedAt,
      ...overrides,
      evidenceCitations: [{ evidenceId: evidence.id }],
    },
    new Map([[evidence.id, evidence]]),
  ).finding;

export function receipt(
  id: string,
  findings: readonly Finding[],
  scope: { sprintId?: string; taskId?: string; completedAt?: string } = {},
): SubmittedInvestigationResult {
  return Object.freeze({
    investigation: Object.freeze({
      id,
      sprintId: scope.sprintId ?? "sprint",
      ...(scope.taskId === undefined ? {} : { taskId: scope.taskId }),
      triggerId: "manual",
      status: "completed",
      requestedAt: before,
      completedAt: scope.completedAt ?? reviewedAt,
    }),
    resultDigest: id,
    findings: Object.freeze([...findings]),
    citations: Object.freeze(
      findings.map((item) => Object.freeze({ findingId: item.id, evidenceId: evidence.id })),
    ),
    riskSnapshots: Object.freeze([]),
    riskTransitions: Object.freeze([]),
  });
}

/** Serial domain callbacks commit feedback and projections together; failed writes roll back. */
export function riskFixture(
  seed: {
    sprints?: readonly Sprint[];
    tasks?: readonly Task[];
    receipts?: readonly SubmittedInvestigationResult[];
    findings?: readonly Finding[];
    evidence?: readonly EvidenceItem[];
    repositories?: readonly Repository[];
    feedback?: readonly FindingFeedback[];
    snapshots?: readonly RiskSnapshot[];
  } = {},
) {
  const planning = planningFixture({
    sprints: seed.sprints ?? [sprint()],
    tasks: seed.tasks ?? [task()],
  });
  const receipts = [...(seed.receipts ?? [])];
  const findings = new Map(
    [...(seed.findings ?? []), ...receipts.flatMap((item) => item.findings)].map((item) => [
      item.id,
      item,
    ]),
  );
  const observations = new Map((seed.evidence ?? [evidence]).map((item) => [item.id, item]));
  const repositories = new Map((seed.repositories ?? [repository]).map((item) => [item.id, item]));
  let feedback = [...(seed.feedback ?? [])];
  let snapshots = [...(seed.snapshots ?? [])];
  let transitions: RiskTransition[] = [];
  let failTransition = false;
  const store: UnitOfWorkPort = {
    execute<T>(work: (context: TransactionContext) => Promise<T>): Promise<T> {
      return planning.store.execute(async (original) => {
        const nextFeedback = [...feedback],
          nextSnapshots = [...snapshots],
          nextTransitions = [...transitions];
        const context = testPort<TransactionContext>({
          planning: original.planning,
          repositories: testPort<TransactionContext["repositories"]>({
            findById: (id) => Promise.resolve(repositories.get(id)),
          }),
          evidence: testPort<TransactionContext["evidence"]>({
            findById: (id) => Promise.resolve(observations.get(id)),
          }),
          findings: testPort<TransactionContext["findings"]>({
            findById: (id) => Promise.resolve(findings.get(id)),
          }),
          investigations: testPort<TransactionContext["investigations"]>({
            findLatestSubmittedResult: (sprintId, taskId) =>
              Promise.resolve(
                receipts
                  .filter(
                    (item) =>
                      item.investigation.sprintId === sprintId &&
                      item.investigation.taskId === taskId,
                  )
                  .sort(
                    (left, right) =>
                      (right.investigation.completedAt ?? "").localeCompare(
                        left.investigation.completedAt ?? "",
                      ) || right.investigation.id.localeCompare(left.investigation.id),
                  )[0],
              ),
          }),
          findingFeedback: testPort<TransactionContext["findingFeedback"]>({
            findById: (id) => Promise.resolve(nextFeedback.find((item) => item.id === id)),
            findCurrentByFindingId: (id) => {
              const history = nextFeedback
                .filter((item) => item.findingId === id)
                .sort(
                  (left, right) =>
                    right.createdAt.localeCompare(left.createdAt) ||
                    right.id.localeCompare(left.id),
                );
              return Promise.resolve(
                history.filter(
                  (item) =>
                    item ===
                    history.find(
                      (value) => (value.kind === "correct") === (item.kind === "correct"),
                    ),
                ),
              );
            },
            add: (item) => {
              nextFeedback.push(item);
              return Promise.resolve();
            },
          }),
          risks: testPort<TransactionContext["risks"]>({
            findLatestSnapshot: (sprintId, taskId) =>
              Promise.resolve(
                nextSnapshots
                  .filter((item) => item.sprintId === sprintId && item.taskId === taskId)
                  .at(-1),
              ),
            addSnapshot: (item) => {
              nextSnapshots.push(item);
              return Promise.resolve();
            },
            addTransition: (item) => {
              if (failTransition) throw new Error("transition write failed");
              nextTransitions.push(item);
              return Promise.resolve();
            },
          }),
        });
        const result = await work(context);
        feedback = nextFeedback;
        snapshots = nextSnapshots;
        transitions = nextTransitions;
        return result;
      });
    },
  };
  let sequence = 0;
  return {
    store,
    observations,
    findings,
    receipts,
    tasks: planning.tasks,
    ids: { next: () => `record-${String(++sequence)}` },
    feedback: () => feedback,
    snapshots: () => snapshots,
    transitions: () => transitions,
    failTransitions(value: boolean) {
      failTransition = value;
    },
  };
}

function testPort<T extends object>(methods: Partial<T>): T {
  return new Proxy(methods, {
    get(target, key) {
      if (key in target) return Reflect.get(target, key);
      throw new Error(`Unexpected test dependency: ${String(key)}`);
    },
  }) as T;
}
