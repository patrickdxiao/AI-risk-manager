import type { EvidenceItem } from "../../src/core/evidence/evidenceModel.js";
import type {
  Investigation,
  InvestigationAttempt,
} from "../../src/core/investigation/investigationModel.js";
import type { Sprint, Task } from "../../src/core/planning/planningModel.js";
import type { Repository } from "../../src/core/repository/repositoryModel.js";
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
          nextDispatches = new Map(dispatches);
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
                  seed.receipts?.find(
                    (item) =>
                      item.investigation.sprintId === sprintId &&
                      item.investigation.taskId === taskId,
                  ),
                ),
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
    repositories,
    investigations: () => [...investigations.values()],
    attempts: () => [...attempts.values()],
    dispatches: () => [...dispatches.values()],
  };
}
