import type { EvidenceItem } from "../../src/core/evidence/evidenceModel.js";
import type {
  Investigation,
  InvestigationAttempt,
} from "../../src/core/investigation/investigationModel.js";
import type { Sprint, Task } from "../../src/core/planning/planningModel.js";
import type { Repository } from "../../src/core/repository/repositoryModel.js";
import type { Finding, FindingEvidence } from "../../src/core/investigation/findingModel.js";
import type { RiskSnapshot, RiskTransition } from "../../src/core/risk/riskModel.js";
import type { FindingFeedback } from "../../src/core/risk/findingFeedback.js";
import type {
  SubmittedInvestigationResult,
  TransactionContext,
  UnitOfWorkPort,
} from "../../src/core/storageContracts.js";
import type { TriggerDispatch } from "../../src/core/triggers/triggerModel.js";

/** This fixture supplies the serialized transaction contract; it does not test SQLite isolation. */
export function investigationFixture(
  seed: {
    sprints?: readonly Sprint[];
    tasks?: readonly Task[];
    repositories?: readonly Repository[];
    evidence?: readonly EvidenceItem[];
    investigations?: readonly Investigation[];
    attempts?: readonly InvestigationAttempt[];
    dispatches?: readonly TriggerDispatch[];
    receipts?: readonly SubmittedInvestigationResult[];
    feedback?: readonly FindingFeedback[];
    findings?: readonly Finding[];
    snapshots?: readonly RiskSnapshot[];
    failFenced?: boolean;
  } = {},
) {
  let investigations = new Map(seed.investigations?.map((item) => [item.id, item]));
  let attempts = new Map(seed.attempts?.map((item) => [item.id, item]));
  let dispatches = new Map(seed.dispatches?.map((item) => [item.triggerId, item]));
  const sprints = new Map(seed.sprints?.map((item) => [item.id, item]));
  const tasks = new Map(seed.tasks?.map((item) => [item.id, item]));
  const repositories = new Map(seed.repositories?.map((item) => [item.id, item]));
  const evidence = new Map(seed.evidence?.map((item) => [item.id, item]));
  const evidenceReads: string[] = [];
  let receipts = new Map(seed.receipts?.map((item) => [item.investigation.id, item]));
  let findings = new Map(
    [...(seed.findings ?? []), ...(seed.receipts ?? []).flatMap((item) => item.findings)].map(
      (item) => [item.id, item],
    ),
  );
  let citations: FindingEvidence[] = [];
  let snapshots = [...(seed.snapshots ?? [])],
    transitions: RiskTransition[] = [];
  let failReceipt = false;
  let previous: Promise<unknown> = Promise.resolve();
  function port<K extends keyof TransactionContext>(
    name: K,
    methods: Partial<TransactionContext[K]>,
  ): TransactionContext[K] {
    return new Proxy(methods, {
      get(target, key) {
        if (key in target) return Reflect.get(target, key) as unknown;
        throw new Error(`Unexpected call: ${name}.${String(key)}`);
      },
    }) as TransactionContext[K];
  }
  const store: UnitOfWorkPort = {
    execute<T>(work: (context: TransactionContext) => Promise<T>): Promise<T> {
      const run = previous.then(async () => {
        const nextInvestigations = new Map(investigations),
          nextAttempts = new Map(attempts),
          nextDispatches = new Map(dispatches),
          nextReceipts = new Map(receipts),
          nextFindings = new Map(findings);
        const nextCitations = [...citations],
          nextSnapshots = [...snapshots],
          nextTransitions = [...transitions];
        const context = new Proxy(
          {
            planning: port("planning", {
              findSprintById: (id) => Promise.resolve(sprints.get(id)),
              findTaskById: (id) => Promise.resolve(tasks.get(id)),
              findTasksBySprintId: (id) =>
                Promise.resolve([...tasks.values()].filter((task) => task.sprintId === id)),
            }),
            repositories: port("repositories", {
              findById: (id) => Promise.resolve(repositories.get(id)),
            }),
            investigations: port("investigations", {
              findById: (id) => Promise.resolve(nextInvestigations.get(id)),
              findAttemptById: (id) => Promise.resolve(nextAttempts.get(id)),
              findActive: (now) =>
                Promise.resolve(
                  [...nextInvestigations.values()].find(
                    (item) =>
                      item.status === "running" &&
                      Date.parse(item.executionLeaseUntil ?? "") > Date.parse(now),
                  ),
                ),
              listAttemptsSince: (since) =>
                Promise.resolve(
                  [...nextAttempts.values()].filter(
                    (item) => Date.parse(item.startedAt) >= Date.parse(since),
                  ),
                ),
              listUnsettledAttempts: () =>
                Promise.resolve(
                  [...nextAttempts.values()].filter(
                    (item) => item.status === "running" || item.usage?.totalTokens === undefined,
                  ),
                ),
              saveAttempt: (item) => {
                nextAttempts.set(item.id, item);
                return Promise.resolve();
              },
              save: (item) => {
                nextInvestigations.set(item.id, item);
                return Promise.resolve();
              },
              findLatestSubmittedResult: (sprintId, taskId) =>
                Promise.resolve(
                  [...nextReceipts.values()]
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
              findSubmittedResult: (id) => Promise.resolve(nextReceipts.get(id)),
              saveSubmittedResult: (item) => {
                if (failReceipt) throw new Error("receipt write failed");
                nextReceipts.set(item.investigation.id, item);
                return Promise.resolve();
              },
              findRecentBySprintId: (id, _now, limit) =>
                Promise.resolve(
                  [...nextInvestigations.values()]
                    .filter((item) => item.sprintId === id)
                    .slice(0, limit)
                    .map((investigation) => {
                      const latestAttempt = [...nextAttempts.values()].find(
                        (attempt) => attempt.investigationId === investigation.id,
                      );
                      return {
                        investigation,
                        ...(latestAttempt === undefined ? {} : { latestAttempt }),
                      };
                    }),
                ),
            }),
            findings: port("findings", {
              findById: (id) => Promise.resolve(nextFindings.get(id)),
              add: (item) => {
                if (nextFindings.has(item.id)) throw new Error("duplicate finding");
                nextFindings.set(item.id, item);
                return Promise.resolve();
              },
              addEvidence: (item) => {
                nextCitations.push(item);
                return Promise.resolve();
              },
            }),
            risks: port("risks", {
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
                nextTransitions.push(item);
                return Promise.resolve();
              },
            }),
            evidence: port("evidence", {
              findById: (id) => {
                evidenceReads.push(id);
                return Promise.resolve(evidence.get(id));
              },
              findScoped: (query) =>
                Promise.resolve(
                  [...evidence.values()]
                    .filter(
                      (item) =>
                        (query.sprintId === undefined || item.sprintId === query.sprintId) &&
                        (query.repositoryId === undefined ||
                          item.repositoryId === query.repositoryId) &&
                        (query.taskId === undefined || item.taskId === query.taskId),
                    )
                    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
                    .slice(0, query.limit),
                ),
            }),
            findingFeedback: port("findingFeedback", {
              findCurrentByFindingId: (id) =>
                Promise.resolve(
                  (seed.feedback ?? []).filter((item) => item.findingId === id).slice(0, 2),
                ),
            }),
            triggerDispatches: port("triggerDispatches", {
              findByTriggerId: (id) => Promise.resolve(nextDispatches.get(id)),
              findByInvestigationId: (id) =>
                Promise.resolve(
                  [...nextDispatches.values()].find((item) => item.investigationId === id),
                ),
              saveFenced: (item, version, status) => {
                const current = nextDispatches.get(item.triggerId);
                if (
                  seed.failFenced ||
                  current?.leaseVersion !== version ||
                  current.status !== status
                )
                  return Promise.resolve(false);
                nextDispatches.set(item.triggerId, item);
                return Promise.resolve(true);
              },
            }),
          },
          {
            get(target, key) {
              if (key in target) return Reflect.get(target, key) as unknown;
              throw new Error(`Unexpected port: ${String(key)}`);
            },
          },
        ) as TransactionContext;
        const result = await work(context);
        investigations = nextInvestigations;
        attempts = nextAttempts;
        dispatches = nextDispatches;
        receipts = nextReceipts;
        findings = nextFindings;
        citations = nextCitations;
        snapshots = nextSnapshots;
        transitions = nextTransitions;
        return result;
      });
      previous = run.catch(() => undefined);
      return run;
    },
  };
  return {
    store,
    evidenceReads,
    tasks,
    sprints,
    evidence,
    repositories,
    investigations: () => [...investigations.values()],
    attempts: () => [...attempts.values()],
    dispatches: () => [...dispatches.values()],
    receipts: () => [...receipts.values()],
    findings: () => [...findings.values()],
    citations: () => citations,
    snapshots: () => snapshots,
    transitions: () => transitions,
    failReceiptWrites(value: boolean) {
      failReceipt = value;
    },
  };
}
