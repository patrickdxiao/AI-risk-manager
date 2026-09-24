import type { EvidenceItem, EvidenceQuery } from "../../src/core/evidence/evidenceModel.js";
import type { Sprint, Task } from "../../src/core/planning/planningModel.js";
import type {
  Repository,
  RepositoryObservation,
} from "../../src/core/repository/repositoryModel.js";
import type {
  SubmittedInvestigationResult,
  TransactionContext,
  UnitOfWorkPort,
} from "../../src/core/storageContracts.js";
import type {
  TriggerCooldownScope,
  TriggerDispatch,
  TriggerQueueRecord,
} from "../../src/core/triggers/triggerModel.js";

/** Test-only serialized transactions; delivery failures leave no accepted request behind. */
export function reviewQueueFixture(
  seed: {
    readonly sprints?: readonly Sprint[];
    readonly tasks?: readonly Task[];
    readonly repositories?: readonly Repository[];
    readonly evidence?: readonly EvidenceItem[];
    readonly reviews?: readonly SubmittedInvestigationResult[];
    readonly triggers?: readonly TriggerQueueRecord[];
    readonly dispatches?: readonly TriggerDispatch[];
    readonly observations?: readonly RepositoryObservation[];
  } = {},
) {
  let triggers = new Map(seed.triggers?.map((item) => [item.id, item]));
  let dispatches = new Map(seed.dispatches?.map((item) => [item.triggerId, item]));
  let previous: Promise<unknown> = Promise.resolve();
  let rejectDispatch = false;
  const evidence = [...(seed.evidence ?? [])];
  let observations = new Map(seed.observations?.map((item) => [item.repositoryId, item]));
  function scope(value: TriggerCooldownScope): string {
    return JSON.stringify([value.type, value.sprintId, value.taskId ?? null, value.repositoryIds]);
  }
  function findEvidence(query: EvidenceQuery): readonly EvidenceItem[] {
    return evidence
      .filter(
        (item) =>
          (query.repositoryId === undefined || item.repositoryId === query.repositoryId) &&
          (query.sprintId === undefined || (item.sprintId ?? null) === query.sprintId) &&
          (query.taskId === undefined || (item.taskId ?? null) === query.taskId) &&
          (query.source === undefined || item.source === query.source) &&
          (query.kinds === undefined || query.kinds.includes(item.kind)) &&
          (query.occurredThrough === undefined ||
            Date.parse(item.occurredAt) <= Date.parse(query.occurredThrough)),
      )
      .sort(
        (left, right) =>
          Date.parse(right.occurredAt) - Date.parse(left.occurredAt) ||
          (left.id < right.id ? 1 : -1),
      )
      .slice(0, query.limit);
  }
  const store: UnitOfWorkPort = {
    execute<T>(work: (context: TransactionContext) => Promise<T>): Promise<T> {
      const run = previous.then(async () => {
        const nextTriggers = new Map(triggers);
        const nextDispatches = new Map(dispatches);
        const nextObservations = new Map(observations);
        const ports = {
          planning: {
            findActiveSprint: () =>
              Promise.resolve(seed.sprints?.find((item) => item.state === "active")),
            findSprintById: (id: string) =>
              Promise.resolve(seed.sprints?.find((item) => item.id === id)),
            findTaskById: (id: string) =>
              Promise.resolve(seed.tasks?.find((item) => item.id === id)),
            findTasksBySprintId: (id: string) =>
              Promise.resolve(seed.tasks?.filter((item) => item.sprintId === id) ?? []),
          },
          repositories: {
            findById: (id: string) =>
              Promise.resolve(seed.repositories?.find((item) => item.id === id)),
          },
          repositoryObservations: {
            findByRepositoryId: (id: string) => Promise.resolve(nextObservations.get(id)),
            markEvaluated: (id: string, digest: string, observedAt: string) => {
              const observation = nextObservations.get(id);
              if (
                observation?.snapshot.snapshotDigest !== digest ||
                observation.observedAt !== observedAt
              )
                return Promise.resolve(false);
              nextObservations.set(id, { ...observation, evaluatedSnapshotDigest: digest });
              return Promise.resolve(true);
            },
          },
          evidence: {
            findById: (id: string) => Promise.resolve(evidence.find((item) => item.id === id)),
            findScoped: (query: EvidenceQuery) => Promise.resolve(findEvidence(query)),
          },
          investigations: {
            findLatestSubmittedResult: (sprintId: string) =>
              Promise.resolve(
                seed.reviews?.find(
                  (item) =>
                    item.investigation.sprintId === sprintId &&
                    item.investigation.taskId === undefined,
                ),
              ),
          },
          triggerQueue: {
            findByDedupKey: (key: string) =>
              Promise.resolve([...nextTriggers.values()].find((item) => item.dedupKey === key)),
            findLatestByCooldownScope: (input: TriggerCooldownScope) =>
              Promise.resolve(
                [...nextTriggers.values()]
                  .filter((item) => scope(item) === scope(input))
                  .sort(
                    (left, right) =>
                      Date.parse(right.observedAt) - Date.parse(left.observedAt) ||
                      (left.id < right.id ? 1 : -1),
                  )[0],
              ),
            add: (record: TriggerQueueRecord) => {
              if (
                nextTriggers.has(record.id) ||
                [...nextTriggers.values()].some((item) => item.dedupKey === record.dedupKey)
              )
                throw new Error("Duplicate trigger");
              nextTriggers.set(record.id, record);
              return Promise.resolve();
            },
          },
          triggerDispatches: {
            findByTriggerId: (id: string) => Promise.resolve(nextDispatches.get(id)),
            countPending: () =>
              Promise.resolve(
                [...nextDispatches.values()].filter(
                  (item) => item.status !== "completed" && item.status !== "dead",
                ).length,
              ),
            add: (dispatch: TriggerDispatch) => {
              if (rejectDispatch) throw new Error("Delivery write failed");
              nextDispatches.set(dispatch.triggerId, dispatch);
              return Promise.resolve();
            },
          },
        };
        const context = new Proxy({} as TransactionContext, {
          get(_target, key) {
            if (Object.hasOwn(ports, key)) return ports[key as keyof typeof ports];
            throw new Error(`Unexpected queue dependency: ${String(key)}`);
          },
        });
        const result = await work(context);
        triggers = nextTriggers;
        dispatches = nextDispatches;
        observations = nextObservations;
        return result;
      });
      previous = run.catch(() => undefined);
      return run;
    },
  };
  return {
    store,
    triggers: () => [...triggers.values()],
    dispatches: () => [...dispatches.values()],
    observations: () => [...observations.values()],
    addEvidence: (item: EvidenceItem) => {
      evidence.push(item);
    },
    saveObservation: (item: RepositoryObservation) => {
      observations.set(item.repositoryId, item);
    },
    failDispatch: (value = true) => {
      rejectDispatch = value;
    },
    completeDispatch: (id: string) => {
      const dispatch = dispatches.get(id);
      if (dispatch === undefined) throw new Error("Missing dispatch");
      dispatches.set(id, { ...dispatch, status: "completed", completedAt: dispatch.updatedAt });
    },
  };
}
