import {
  requireNonBlank,
  requireUtcTimestamp,
  type ClockPort,
  type IdGeneratorPort,
} from "../core/primitives.js";
import { ReconcileRepository } from "../core/repository/repositoryCapture.js";
import type { RepositoryObservationPort } from "../core/repository/repositoryModel.js";
import type { UnitOfWorkPort } from "../core/storageContracts.js";

/** An explicit local refresh saves metadata without promising or authorizing a model review. */
export async function captureLocally(
  store: UnitOfWorkPort,
  observer: RepositoryObservationPort,
  ids: IdGeneratorPort,
  clock: ClockPort,
  repositoryIdInput: string,
) {
  const repositoryId = requireNonBlank(repositoryIdInput, "repositoryId", 200);
  // Deliberate refresh retires this handoff even if capture fails; evidence and queued jobs remain.
  await store.execute(async ({ repositoryObservations: observations }) => {
    const previous = await observations.findByRepositoryId(repositoryId);
    if (previous !== undefined)
      await observations.markEvaluated(
        repositoryId,
        previous.snapshot.snapshotDigest,
        previous.observedAt,
      );
  });
  const observedAt = requireUtcTimestamp(clock.now(), "observedAt");
  const result = await new ReconcileRepository(store, observer, ids, {
    now: () => observedAt,
  }).execute({ repositoryId });
  if (result.changed)
    await store.execute(({ repositoryObservations }) =>
      repositoryObservations.markEvaluated(repositoryId, result.snapshotDigest, observedAt),
    );
  return result;
}
