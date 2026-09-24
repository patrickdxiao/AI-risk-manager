import { createEvidenceItem, type EvidenceItem } from "../evidence/evidenceModel.js";
import {
  ApplicationError,
  DomainInvariantError,
  normalizeStringList,
  requireNonBlank,
  requireTimestampOrder,
  requireUtcTimestamp,
  type ClockPort,
  type IdGeneratorPort,
} from "../primitives.js";
import type { EvidenceIdentity, UnitOfWorkPort } from "../storageContracts.js";
import { EvaluateStoredTriggers } from "../triggers/storedTriggerEvaluation.js";
import {
  createRepository,
  createRepositoryObservationSnapshot,
  type Repository,
  type RepositoryObservation,
  type RepositoryObservationPort,
} from "./repositoryModel.js";

/** A concurrent registration or observation change requires a fresh capture. */
export class RepositoryObservationConflictError extends ApplicationError {
  readonly retryable = true;
  constructor(message = "Repository registration or observation changed during capture") {
    super("repository_observation_conflict", message, "repositoryId");
  }
}

export interface ReconcileRepositoryResult {
  readonly changed: boolean;
  readonly snapshotDigest: string;
  readonly evidence: readonly EvidenceItem[];
}

/** Capture externally, then atomically persist immutable observations and their pending handoff. */
export class ReconcileRepository {
  constructor(
    private readonly store: UnitOfWorkPort,
    private readonly observer: RepositoryObservationPort,
    private readonly ids: IdGeneratorPort,
    private readonly clock: ClockPort,
  ) {}

  async execute(input: { readonly repositoryId: string }): Promise<ReconcileRepositoryResult> {
    const repositoryId = requireNonBlank(input.repositoryId, "repositoryId", 200);
    const loaded = await this.store.execute(async (store) => {
      const saved = await store.repositories.findById(repositoryId);
      if (saved?.id !== repositoryId)
        throw new ApplicationError(
          "repository_not_found",
          "Repository is not registered",
          "repositoryId",
        );
      const previous = await store.repositoryObservations.findByRepositoryId(repositoryId);
      return {
        repository: createRepository(saved),
        previous:
          previous === undefined
            ? undefined
            : Object.freeze({
                ...previous,
                snapshot: createRepositoryObservationSnapshot(previous.snapshot),
                evidenceIds: normalizeStringList(previous.evidenceIds, "evidenceIds", 100, 200),
              }),
      };
    });
    const observedAt = requireUtcTimestamp(this.clock.now(), "observedAt");
    requireTimestampOrder(
      loaded.previous?.observedAt ?? loaded.repository.registeredAt,
      observedAt,
      "observedAt",
    );
    const captured = await this.observer.capture({
      repository: loaded.repository,
      ...(loaded.previous === undefined ? {} : { previous: loaded.previous.snapshot }),
      observedAt,
      nextEvidenceId: () => this.ids.next(),
      nextEventId: () => this.ids.next(),
    });
    const snapshot = createRepositoryObservationSnapshot(captured.snapshot);
    if (snapshot.rootPath !== loaded.repository.canonicalPath)
      throw new DomainInvariantError(
        "scope_mismatch",
        "Capture belongs to another repository root",
        "rootPath",
      );
    if (captured.evidenceItems.length > 100)
      throw new DomainInvariantError(
        "out_of_range",
        "Capture exceeds 100 evidence records",
        "evidenceItems",
      );
    const evidence = captured.evidenceItems.map((value) => {
      const item = createEvidenceItem(value);
      if (
        item.repositoryId !== repositoryId ||
        item.sprintId !== undefined ||
        item.taskId !== undefined ||
        item.source !== "git" ||
        item.privacyMode !== "metadata_only"
      )
        throw new DomainInvariantError(
          "scope_mismatch",
          "Capture must contain reusable repository metadata",
          "evidenceItems",
        );
      requireTimestampOrder(item.occurredAt, observedAt, "evidence.occurredAt");
      return item;
    });
    return this.store.execute(async (store) => {
      const repository = await store.repositories.findById(repositoryId);
      const current = await store.repositoryObservations.findByRepositoryId(repositoryId);
      if (
        repository === undefined ||
        !sameRegistration(repository, loaded.repository) ||
        !sameObservation(current, loaded.previous)
      )
        throw new RepositoryObservationConflictError();
      if (snapshot.snapshotDigest === current?.snapshot.snapshotDigest)
        return Object.freeze({
          changed: false,
          snapshotDigest: snapshot.snapshotDigest,
          evidence: Object.freeze([]),
        });
      if (current !== undefined)
        requireTimestampOrder(current.observedAt, observedAt, "observedAt", false);
      if (
        current !== undefined &&
        current.evaluatedSnapshotDigest !== current.snapshot.snapshotDigest
      )
        throw new RepositoryObservationConflictError(
          "The previous observation still has a pending review handoff",
        );
      if (evidence.length === 0)
        throw new DomainInvariantError(
          "required",
          "A changed snapshot requires stored evidence",
          "evidenceItems",
        );
      const persisted = new Map<string, EvidenceItem>();
      for (const item of evidence) {
        const identity = evidenceIdentity(item);
        const existing = await store.evidence.findByIdentity(identity);
        const saved = existing === undefined ? item : createEvidenceItem(existing);
        if (
          JSON.stringify(evidenceIdentity(saved)) !== JSON.stringify(identity) ||
          saved.privacyMode !== "metadata_only"
        )
          throw new DomainInvariantError(
            "scope_mismatch",
            "Stored evidence has different provenance",
            "evidenceItems",
          );
        requireTimestampOrder(saved.occurredAt, observedAt, "evidence.occurredAt");
        if (existing === undefined) await store.evidence.add(item);
        persisted.set(saved.id, saved);
      }
      await store.repositoryObservations.save(
        Object.freeze({
          repositoryId,
          observedAt,
          snapshot,
          evidenceIds: Object.freeze([...persisted.keys()]),
        }),
      );
      return Object.freeze({
        changed: true,
        snapshotDigest: snapshot.snapshotDigest,
        evidence: Object.freeze([...persisted.values()]),
      });
    });
  }
}

function evidenceIdentity(item: EvidenceItem): EvidenceIdentity {
  return {
    ...(item.repositoryId === undefined ? {} : { repositoryId: item.repositoryId }),
    ...(item.sprintId === undefined ? {} : { sprintId: item.sprintId }),
    ...(item.taskId === undefined ? {} : { taskId: item.taskId }),
    source: item.source,
    kind: item.kind,
    digest: item.digest,
  };
}

function sameRegistration(left: Repository, right: Repository): boolean {
  return (
    ["id", "canonicalPath", "gitRoot", "identityDigest", "approvedRoot", "registeredAt"] as const
  ).every((field) => left[field] === right[field]);
}

function sameObservation(
  left: RepositoryObservation | undefined,
  right: RepositoryObservation | undefined,
): boolean {
  return (
    left?.snapshot.snapshotDigest === right?.snapshot.snapshotDigest &&
    left?.observedAt === right?.observedAt
  );
}

/** Retry saved captures; an absent active sprint or deferred review leaves its cursor pending. */
export class EvaluatePendingRepository {
  constructor(
    private readonly store: UnitOfWorkPort,
    private readonly ids: IdGeneratorPort,
    private readonly clock: ClockPort,
  ) {}

  execute(repositoryIdInput: string) {
    const repositoryId = requireNonBlank(repositoryIdInput, "repositoryId", 200);
    return this.store.execute(async (store) => {
      const repository = await store.repositories.findById(repositoryId);
      if (repository?.id !== repositoryId)
        throw new ApplicationError(
          "repository_not_found",
          "Repository is not registered",
          "repositoryId",
        );
      const observation = await store.repositoryObservations.findByRepositoryId(repositoryId);
      if (
        observation === undefined ||
        observation.evaluatedSnapshotDigest === observation.snapshot.snapshotDigest
      )
        return Object.freeze({ triggerIds: Object.freeze([]), evaluated: false, deferred: false });
      if (observation.snapshot.rootPath !== repository.canonicalPath)
        throw new RepositoryObservationConflictError();
      const evaluation = await new EvaluateStoredTriggers(
        { execute: (work) => work(store) },
        this.ids,
        this.clock,
      ).execute({ repositoryIds: [repositoryId], cooldownMinutes: 15 });
      const evaluated =
        evaluation.deferred.length === 0 &&
        evaluation.fired.some((candidate) => candidate.type === "git_change");
      if (
        evaluated &&
        !(await store.repositoryObservations.markEvaluated(
          repositoryId,
          observation.snapshot.snapshotDigest,
          observation.observedAt,
        ))
      )
        throw new RepositoryObservationConflictError();
      return Object.freeze({
        triggerIds: Object.freeze(
          [...evaluation.queued, ...evaluation.existing].map((item) => item.id),
        ),
        evaluated,
        deferred: evaluation.deferred.length > 0,
      });
    });
  }

  async recover() {
    const pending = await this.store.execute((store) =>
      store.repositoryObservations.listPendingEvaluation(100),
    );
    const outcomes: (
      | {
          readonly repositoryId: string;
          readonly result: Awaited<ReturnType<EvaluatePendingRepository["execute"]>>;
        }
      | { readonly repositoryId: string; readonly error: unknown }
    )[] = [];
    for (const observation of pending) {
      try {
        outcomes.push(
          Object.freeze({
            repositoryId: observation.repositoryId,
            result: await this.execute(observation.repositoryId),
          }),
        );
      } catch (error: unknown) {
        outcomes.push(Object.freeze({ repositoryId: observation.repositoryId, error }));
      }
    }
    return Object.freeze(outcomes);
  }
}

/** A same-snapshot retry still completes any interrupted capture-to-review handoff. */
export class ReconcileAndEvaluateRepository {
  private readonly capture: ReconcileRepository;
  private readonly pending: EvaluatePendingRepository;
  constructor(
    store: UnitOfWorkPort,
    observer: RepositoryObservationPort,
    ids: IdGeneratorPort,
    clock: ClockPort,
  ) {
    this.capture = new ReconcileRepository(store, observer, ids, clock);
    this.pending = new EvaluatePendingRepository(store, ids, clock);
  }
  async execute(input: { readonly repositoryId: string }) {
    const repositoryId = requireNonBlank(input.repositoryId, "repositoryId", 200);
    const previous = await this.pending.execute(repositoryId);
    const result = await this.capture.execute({ repositoryId });
    const current = await this.pending.execute(repositoryId);
    return Object.freeze({
      ...result,
      ...current,
      evaluated: previous.evaluated || current.evaluated,
      triggerIds: Object.freeze([...new Set([...previous.triggerIds, ...current.triggerIds])]),
    });
  }
}
