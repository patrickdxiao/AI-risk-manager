import type { EvidenceItem } from "../../src/core/evidence/evidenceModel.js";
import type {
  Investigation,
  InvestigationAttempt,
} from "../../src/core/investigation/investigationModel.js";
import type { Sprint, Task } from "../../src/core/planning/planningModel.js";
import type {
  Repository,
  RepositoryObservation,
} from "../../src/core/repository/repositoryModel.js";
import type { Finding, FindingEvidence } from "../../src/core/investigation/findingModel.js";
import type { RiskSnapshot, RiskTransition } from "../../src/core/risk/riskModel.js";
import type { FindingFeedback } from "../../src/core/risk/findingFeedback.js";
import type {
  SubmittedInvestigationResult,
  TransactionContext,
  UnitOfWorkPort,
} from "../../src/core/storageContracts.js";
import type {
  TriggerDispatch,
  TriggerQueueRecord,
  TriggerCooldownScope,
} from "../../src/core/triggers/triggerModel.js";

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
    triggers?: readonly TriggerQueueRecord[];
    observations?: readonly RepositoryObservation[];
  } = {},
) {
  let investigations = new Map(seed.investigations?.map((item) => [item.id, item]));
  let attempts = new Map(seed.attempts?.map((item) => [item.id, item]));
  let dispatches = new Map(seed.dispatches?.map((item) => [item.triggerId, item]));
  let triggers = new Map(seed.triggers?.map((item) => [item.id, item]));
  let observations = new Map(seed.observations?.map((item) => [item.repositoryId, item]));
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
          nextTriggers = new Map(triggers),
          nextObservations = new Map(observations),
          nextFindings = new Map(findings);
        const nextCitations = [...citations],
          nextSnapshots = [...snapshots],
          nextTransitions = [...transitions];
        const context = new Proxy(
          {
            planning: port("planning", {
              listSprints: () => Promise.resolve([...sprints.values()]),
              findOpenTasks: () =>
                Promise.resolve([...tasks.values()].filter((item) => item.state !== "done")),
              findActiveSprint: () =>
                Promise.resolve([...sprints.values()].find((item) => item.state === "active")),
              findSprintById: (id) => Promise.resolve(sprints.get(id)),
              findTaskById: (id) => Promise.resolve(tasks.get(id)),
              findTasksBySprintId: (id) =>
                Promise.resolve([...tasks.values()].filter((task) => task.sprintId === id)),
            }),
            repositories: port("repositories", {
              findById: (id) => Promise.resolve(repositories.get(id)),
            }),
            repositoryObservations: port("repositoryObservations", {
              findByRepositoryId: (id) => Promise.resolve(nextObservations.get(id)),
              markEvaluated: (id, digest, observedAt) => {
                const current = nextObservations.get(id);
                if (
                  current?.snapshot.snapshotDigest !== digest ||
                  current.observedAt !== observedAt
                )
                  return Promise.resolve(false);
                nextObservations.set(id, { ...current, evaluatedSnapshotDigest: digest });
                return Promise.resolve(true);
              },
            }),
            triggerQueue: port("triggerQueue", {
              findById: (id) => Promise.resolve(nextTriggers.get(id)),
              findByDedupKey: (key) =>
                Promise.resolve([...nextTriggers.values()].find((item) => item.dedupKey === key)),
              findLatestByCooldownScope: (scope) => {
                const key = (value: TriggerCooldownScope) =>
                  JSON.stringify([
                    value.type,
                    value.sprintId,
                    value.taskId ?? null,
                    value.repositoryIds,
                  ]);
                return Promise.resolve(
                  [...nextTriggers.values()]
                    .filter((item) => key(item) === key(scope))
                    .sort(
                      (a, b) =>
                        b.observedAt.localeCompare(a.observedAt) || b.id.localeCompare(a.id),
                    )[0],
                );
              },
              add: (item) => {
                if (
                  nextTriggers.has(item.id) ||
                  [...nextTriggers.values()].some((other) => other.dedupKey === item.dedupKey)
                )
                  throw new Error("Duplicate trigger");
                nextTriggers.set(item.id, item);
                return Promise.resolve();
              },
            }),
            investigations: port("investigations", {
              add: (item) => {
                nextInvestigations.set(item.id, item);
                return Promise.resolve();
              },
              findByDedupKey: (key) =>
                Promise.resolve(
                  [...nextInvestigations.values()].find(
                    (item) =>
                      item.sprintId === key.sprintId &&
                      item.taskId === key.taskId &&
                      item.triggerId === key.triggerId,
                  ),
                ),
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
              add: (item) => {
                nextDispatches.set(item.triggerId, item);
                return Promise.resolve();
              },
              countPending: () =>
                Promise.resolve(
                  [...nextDispatches.values()].filter(
                    (item) => item.status !== "completed" && item.status !== "dead",
                  ).length,
                ),
              findNextDue: (now) =>
                Promise.resolve(
                  [...nextDispatches.values()]
                    .filter(
                      (item) =>
                        ((item.status === "pending" || item.status === "retry_wait") &&
                          item.dueAt <= now) ||
                        (item.status === "leased" && (item.leaseExpiresAt ?? "") <= now),
                    )
                    .sort(
                      (a, b) =>
                        a.dueAt.localeCompare(b.dueAt) || a.triggerId.localeCompare(b.triggerId),
                    )[0],
                ),
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
        triggers = nextTriggers;
        observations = nextObservations;
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
    triggers: () => [...triggers.values()],
    observations: () => [...observations.values()],
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
