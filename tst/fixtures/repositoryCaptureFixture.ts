import type { EvidenceItem, EvidenceQuery } from "../../src/core/evidence/evidenceModel.js";
import type {
  Repository,
  RepositoryObservation,
} from "../../src/core/repository/repositoryModel.js";
import type { Sprint } from "../../src/core/planning/planningModel.js";
import type {
  EvidenceIdentity,
  TransactionContext,
  UnitOfWorkPort,
} from "../../src/core/storageContracts.js";
import type { TriggerDispatch, TriggerQueueRecord } from "../../src/core/triggers/triggerModel.js";

/** Supplies the serialized contract and injected write failures, not a SQLite isolation test. */
export function repositoryCaptureFixture(seed: {
  repository: Repository;
  sprint?: Sprint;
  evidence?: readonly EvidenceItem[];
  observation?: RepositoryObservation;
}) {
  let evidence = new Map(seed.evidence?.map((item) => [item.id, item]));
  let observation = seed.observation;
  let triggers = new Map<string, TriggerQueueRecord>();
  let dispatches = new Map<string, TriggerDispatch>();
  let repository: Repository | undefined = seed.repository;
  let previous: Promise<unknown> = Promise.resolve();
  let inTransaction = false;
  let failWrite: "evidence" | "observation" | "dispatch" | "mark" | "fence" | undefined;
  let pendingCount = 0;
  const identity = (item: EvidenceIdentity) =>
    JSON.stringify([
      item.repositoryId,
      item.sprintId,
      item.taskId,
      item.source,
      item.kind,
      item.digest,
    ]);
  const port = <K extends keyof TransactionContext>(
    name: K,
    methods: Partial<TransactionContext[K]>,
  ) =>
    new Proxy(methods, {
      get(target, key) {
        if (key in target) return Reflect.get(target, key) as unknown;
        throw new Error(`Unexpected capture dependency: ${name}.${String(key)}`);
      },
    }) as TransactionContext[K];
  const store: UnitOfWorkPort = {
    execute<T>(work: (context: TransactionContext) => Promise<T>): Promise<T> {
      const run = previous.then(async () => {
        const nextEvidence = new Map(evidence),
          nextTriggers = new Map(triggers),
          nextDispatches = new Map(dispatches);
        let nextObservation = observation;
        const context = {
          repositories: port("repositories", {
            findById: (id) => Promise.resolve(repository?.id === id ? repository : undefined),
          }),
          repositoryObservations: port("repositoryObservations", {
            findByRepositoryId: (id) =>
              Promise.resolve(nextObservation?.repositoryId === id ? nextObservation : undefined),
            save: (value) => {
              if (failWrite === "observation") throw new Error("Observation write failed");
              nextObservation = value;
              return Promise.resolve();
            },
            listPendingEvaluation: (limit) =>
              Promise.resolve(
                nextObservation !== undefined &&
                  nextObservation.evaluatedSnapshotDigest !==
                    nextObservation.snapshot.snapshotDigest
                  ? [nextObservation].slice(0, limit)
                  : [],
              ),
            markEvaluated: (id, digest, observedAt) => {
              if (failWrite === "mark") throw new Error("Cursor write failed");
              if (failWrite === "fence") return Promise.resolve(false);
              if (
                nextObservation?.repositoryId !== id ||
                nextObservation.snapshot.snapshotDigest !== digest ||
                nextObservation.observedAt !== observedAt
              )
                return Promise.resolve(false);
              nextObservation = Object.freeze({
                ...nextObservation,
                evaluatedSnapshotDigest: digest,
              });
              return Promise.resolve(true);
            },
          }),
          evidence: port("evidence", {
            findById: (id) => Promise.resolve(nextEvidence.get(id)),
            findByIdentity: (value) =>
              Promise.resolve(
                [...nextEvidence.values()].find((item) => identity(item) === identity(value)),
              ),
            findScoped: (query: EvidenceQuery) =>
              Promise.resolve(
                [...nextEvidence.values()]
                  .filter(
                    (item) =>
                      (query.repositoryId === undefined ||
                        item.repositoryId === query.repositoryId) &&
                      (query.source === undefined || item.source === query.source),
                  )
                  .slice(0, query.limit),
              ),
            add: (value) => {
              if (failWrite === "evidence") throw new Error("Evidence write failed");
              if (nextEvidence.has(value.id)) throw new Error("Duplicate evidence ID");
              nextEvidence.set(value.id, value);
              return Promise.resolve();
            },
          }),
          planning: port("planning", {
            findActiveSprint: () =>
              Promise.resolve(seed.sprint?.state === "active" ? seed.sprint : undefined),
            findSprintById: (id) =>
              Promise.resolve(seed.sprint?.id === id ? seed.sprint : undefined),
            findTasksBySprintId: () => Promise.resolve([]),
          }),
          investigations: port("investigations", {
            findLatestSubmittedResult: () => Promise.resolve(undefined),
          }),
          triggerQueue: port("triggerQueue", {
            findByDedupKey: (key) =>
              Promise.resolve([...nextTriggers.values()].find((value) => value.dedupKey === key)),
            findLatestByCooldownScope: () => Promise.resolve(undefined),
            add: (value) => {
              nextTriggers.set(value.id, value);
              return Promise.resolve();
            },
          }),
          triggerDispatches: port("triggerDispatches", {
            countPending: () => Promise.resolve(pendingCount + nextDispatches.size),
            findByTriggerId: (id) => Promise.resolve(nextDispatches.get(id)),
            add: (value) => {
              if (failWrite === "dispatch") throw new Error("Dispatch write failed");
              nextDispatches.set(value.triggerId, value);
              return Promise.resolve();
            },
          }),
        };
        inTransaction = true;
        try {
          const result = await work(
            new Proxy(context, {
              get(target, key) {
                if (key in target) return Reflect.get(target, key) as unknown;
                throw new Error(`Unexpected capture dependency: ${String(key)}`);
              },
            }) as TransactionContext,
          );
          evidence = nextEvidence;
          observation = nextObservation;
          triggers = nextTriggers;
          dispatches = nextDispatches;
          return result;
        } finally {
          inTransaction = false;
        }
      });
      previous = run.catch(() => undefined);
      return run;
    },
  };
  return {
    store,
    evidence: () => [...evidence.values()],
    observation: () => observation,
    triggers: () => [...triggers.values()],
    dispatches: () => [...dispatches.values()],
    inTransaction: () => inTransaction,
    replaceRepository: (value: Repository | undefined) => {
      repository = value;
    },
    replaceObservation: (value: RepositoryObservation | undefined) => {
      observation = value;
    },
    failWrite: (value?: typeof failWrite) => {
      failWrite = value;
    },
    fillQueue: (count: number) => {
      pendingCount = count;
    },
  };
}
