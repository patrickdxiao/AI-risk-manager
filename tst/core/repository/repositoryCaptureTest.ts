import { describe, expect, it } from "vitest";
import { createEvidenceItem, type EvidenceItem } from "../../../src/core/evidence/evidenceModel.js";
import { createSprint } from "../../../src/core/planning/planningModel.js";
import {
  createRepository,
  createRepositoryObservationSnapshot,
  type RepositoryObservationCapture,
  type RepositoryObservationPort,
  type RepositoryObservationSnapshot,
} from "../../../src/core/repository/repositoryModel.js";
import {
  EvaluatePendingRepository,
  ReconcileAndEvaluateRepository,
  ReconcileRepository,
} from "../../../src/core/repository/repositoryCapture.js";
import { EvaluateStoredTriggers } from "../../../src/core/triggers/storedTriggerEvaluation.js";
import type { UnitOfWorkPort } from "../../../src/core/storageContracts.js";
import { repositoryCaptureFixture } from "../../fixtures/repositoryCaptureFixture.js";

const time = "2026-09-24T12:00:00.000Z";
const repository = createRepository({
  id: "web",
  canonicalPath: "/approved/web",
  gitRoot: "/approved/web",
  approvedRoot: "/approved",
  identityDigest: "identity",
  registeredAt: time,
});
const sprint = createSprint({
  id: "sprint",
  startAt: time,
  endAt: "2026-09-30T00:00:00Z",
  createdAt: time,
  pointTarget: 5,
  reviewCadenceMinutes: 60,
  state: "active",
});
const snapshot = (snapshotDigest = "a"): RepositoryObservationSnapshot => ({
  rootPath: repository.canonicalPath,
  head: "head",
  branch: "main",
  detached: false,
  snapshotDigest,
  status: {
    clean: true,
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
    totalPathCount: 0,
    paths: [],
    pathsTruncated: false,
  },
});
type CaptureInput = Parameters<RepositoryObservationPort["capture"]>[0];
function captured(input: CaptureInput, digest = "a", count = 1): RepositoryObservationCapture {
  return {
    snapshot: snapshot(digest),
    evidenceItems: Array.from({ length: count }, (_, index) =>
      createEvidenceItem({
        id: input.nextEvidenceId(),
        eventId: input.nextEventId(),
        repositoryId: input.repository.id,
        source: "git",
        kind: "repository_snapshot",
        occurredAt: input.observedAt,
        locator: `git:${input.repository.id}`,
        summary: `Observed ${digest}`,
        digest: `${digest}-${String(index)}`,
        privacyMode: "metadata_only",
        metadata: {},
      }),
    ),
  };
}
function setup(extra: Partial<Parameters<typeof repositoryCaptureFixture>[0]> = {}) {
  const fixture = repositoryCaptureFixture({ repository, sprint, ...extra });
  let now = time,
    sequence = 0;
  let nextCapture = (input: CaptureInput) => Promise.resolve(captured(input));
  const ids = { next: () => `id-${String(++sequence)}` };
  const clock = { now: () => now };
  const observer: RepositoryObservationPort = {
    capture: (input) => {
      expect(fixture.inTransaction()).toBe(false);
      return nextCapture(input);
    },
  };
  return {
    ...fixture,
    capture: new ReconcileRepository(fixture.store, observer, ids, clock),
    pending: new EvaluatePendingRepository(fixture.store, ids, clock),
    reconcile: new ReconcileAndEvaluateRepository(fixture.store, observer, ids, clock),
    evaluate: new EvaluateStoredTriggers(fixture.store, ids, clock),
    setNow: (value: string) => {
      now = value;
    },
    setCapture: (value: typeof nextCapture) => {
      nextCapture = value;
    },
  };
}

describe("repository capture", () => {
  it("captures outside transactions and saves reusable evidence with its pending observation atomically", async () => {
    const fixture = setup();
    let raw: RepositoryObservationCapture | undefined;
    fixture.setCapture((input) => {
      raw = captured(input);
      return Promise.resolve(raw);
    });
    const request = { repositoryId: "web" };
    const running = fixture.capture.execute(request);
    request.repositoryId = "other";
    const result = await running;
    expect(result.changed).toBe(true);
    expect(fixture.observation()).toMatchObject({
      repositoryId: "web",
      snapshot: snapshot(),
      evidenceIds: result.evidence.map((item) => item.id),
    });
    expect(fixture.observation()).not.toHaveProperty("evaluatedSnapshotDigest");
    expect(result.evidence[0]).not.toHaveProperty("sprintId");
    expect(result.evidence[0]).not.toHaveProperty("taskId");
    expect(Object.isFrozen(fixture.observation()?.snapshot.status.paths)).toBe(true);
    if (raw === undefined) throw new Error("Capture did not run");
    (raw.snapshot as { branch: string }).branch = "mutated";
    expect(fixture.observation()?.snapshot.branch).toBe("main");
    expect(fixture.evidence()).toEqual(result.evidence);
  });

  it("deduplicates the full evidence identity and retains reused IDs on A to B to A", async () => {
    const fixture = setup();
    const first = await fixture.capture.execute({ repositoryId: "web" });
    await fixture.pending.execute("web");
    fixture.setNow("2026-09-24T12:00:01.000Z");
    fixture.setCapture((input) => Promise.resolve(captured(input, "b")));
    await fixture.capture.execute({ repositoryId: "web" });
    await fixture.pending.execute("web");
    fixture.setNow("2026-09-24T12:00:02.000Z");
    fixture.setCapture((input) => Promise.resolve(captured(input, "a")));
    const repeated = await fixture.capture.execute({ repositoryId: "web" });
    expect(repeated.evidence).toEqual(first.evidence);
    expect(fixture.evidence()).toHaveLength(2);
    expect(fixture.observation()?.evidenceIds).toEqual(first.evidence.map((item) => item.id));
    const saved = fixture.observation();
    expect(await fixture.capture.execute({ repositoryId: "web" })).toMatchObject({
      changed: false,
      evidence: [],
    });
    expect(fixture.observation()).toBe(saved);
  });

  it("does not coalesce matching digests across repository, source, kind, or planning provenance", async () => {
    const original = captured({
      repository,
      observedAt: time,
      nextEvidenceId: () => "old",
      nextEventId: () => "event",
    }).evidenceItems[0] as EvidenceItem;
    for (const fields of [
      { repositoryId: "other" },
      { source: "replay" as const },
      { kind: "commit" as const },
      { sprintId: "sprint" },
      { taskId: "task" },
    ]) {
      const fixture = setup({ evidence: [{ ...original, ...fields }] });
      const result = await fixture.capture.execute({ repositoryId: "web" });
      expect(result.evidence[0]?.id).not.toBe("old");
      expect(fixture.evidence()).toHaveLength(2);
    }
  });

  it.each(["evidence", "observation"] as const)(
    "rolls back all writes when the %s write fails",
    async (failure) => {
      const fixture = setup();
      fixture.failWrite(failure);
      await expect(fixture.capture.execute({ repositoryId: "web" })).rejects.toThrow();
      expect(fixture.evidence()).toEqual([]);
      expect(fixture.observation()).toBeUndefined();
      fixture.failWrite();
      expect((await fixture.capture.execute({ repositoryId: "web" })).changed).toBe(true);
    },
  );

  it("fences repository identity, path, approval, registration time, and revocation after external capture", async () => {
    for (const replacement of [
      undefined,
      { ...repository, identityDigest: "replaced" },
      { ...repository, canonicalPath: "/other" },
      { ...repository, gitRoot: "/other" },
      { ...repository, approvedRoot: "/" },
      { ...repository, registeredAt: "2026-09-24T12:00:01.000Z" },
    ]) {
      const fixture = setup();
      fixture.setCapture((input) => {
        fixture.replaceRepository(replacement);
        return Promise.resolve(captured(input));
      });
      await expect(fixture.capture.execute({ repositoryId: "web" })).rejects.toMatchObject({
        code: "repository_observation_conflict",
        retryable: true,
      });
      expect(fixture.evidence()).toEqual([]);
      expect(fixture.observation()).toBeUndefined();
    }
  });

  it("rejects a concurrent capture rather than overwriting its newer observation", async () => {
    const fixture = setup();
    const captures: {
      input: CaptureInput;
      finish: (value: RepositoryObservationCapture) => void;
    }[] = [];
    fixture.setCapture(
      (input) =>
        new Promise((finish) => {
          captures.push({ input, finish });
          if (captures.length === 2)
            for (const capture of captures) capture.finish(captured(capture.input));
        }),
    );
    const results = await Promise.allSettled([
      fixture.capture.execute({ repositoryId: "web" }),
      fixture.capture.execute({ repositoryId: "web" }),
    ]);
    expect(results.map((item) => item.status)).toEqual(["fulfilled", "rejected"]);
    expect(results[1]).toMatchObject({ reason: { code: "repository_observation_conflict" } });
    expect(fixture.evidence()).toHaveLength(1);
  });

  it("rejects malformed, out-of-scope, content-bearing, and future captures without advancing progress", async () => {
    for (const alter of [
      (value: RepositoryObservationCapture) => ({
        ...value,
        snapshot: { ...value.snapshot, rootPath: "/other" },
      }),
      (value: RepositoryObservationCapture) => ({ ...value, evidenceItems: [] }),
      ...[
        { repositoryId: "other" },
        { taskId: "task" },
        { sprintId: "sprint" },
        { source: "user" as const },
        {
          privacyMode: "selected_content" as const,
          selectedContent: { text: "source code", truncated: false },
        },
        { occurredAt: "2026-09-25T00:00:00Z" },
      ].map((fields) => (value: RepositoryObservationCapture) => ({
        ...value,
        evidenceItems: value.evidenceItems.map((item) => ({ ...item, ...fields })),
      })),
    ]) {
      const fixture = setup();
      fixture.setCapture((input) => Promise.resolve(alter(captured(input))));
      await expect(fixture.capture.execute({ repositoryId: "web" })).rejects.toThrow();
      expect(fixture.evidence()).toEqual([]);
      expect(fixture.observation()).toBeUndefined();
    }
  });

  it("requires a later capture time for changed snapshots and retains the existing handoff", async () => {
    const fixture = setup();
    await fixture.capture.execute({ repositoryId: "web" });
    fixture.setCapture((input) => Promise.resolve(captured(input, "b")));
    await expect(fixture.capture.execute({ repositoryId: "web" })).rejects.toMatchObject({
      code: "invalid_date_range",
    });
    expect(fixture.observation()?.snapshot.snapshotDigest).toBe("a");
  });

  it("fences an updated observation time even when its snapshot digest is unchanged", async () => {
    const fixture = setup();
    await fixture.capture.execute({ repositoryId: "web" });
    const original = fixture.observation();
    if (original === undefined) throw new Error("Missing observation");
    const later = { ...original, observedAt: "2026-09-24T12:00:02.000Z" };
    fixture.setNow("2026-09-24T12:00:01.000Z");
    fixture.setCapture((input) => {
      fixture.replaceObservation(later);
      return Promise.resolve(captured(input, "b"));
    });
    await expect(fixture.capture.execute({ repositoryId: "web" })).rejects.toMatchObject({
      code: "repository_observation_conflict",
    });
    expect(fixture.observation()).toBe(later);
    expect(fixture.evidence()).toHaveLength(1);
  });

  it("does not reuse previously selected source content in a metadata-only capture", async () => {
    const item = captured({
      repository,
      observedAt: time,
      nextEvidenceId: () => "old",
      nextEventId: () => "event",
    }).evidenceItems[0] as EvidenceItem;
    const fixture = setup({
      evidence: [
        {
          ...item,
          privacyMode: "selected_content",
          selectedContent: { text: "private source", truncated: false },
        },
      ],
    });
    await expect(fixture.capture.execute({ repositoryId: "web" })).rejects.toMatchObject({
      code: "scope_mismatch",
    });
    expect(fixture.observation()).toBeUndefined();
    fixture.setCapture((input) => Promise.resolve(captured(input, "too-many", 101)));
    await expect(fixture.capture.execute({ repositoryId: "web" })).rejects.toMatchObject({
      code: "out_of_range",
    });
  });

  it("rejects missing registrations and capture failures without writing", async () => {
    const fixture = setup();
    await expect(fixture.capture.execute({ repositoryId: "absent" })).rejects.toMatchObject({
      code: "repository_not_found",
    });
    fixture.setCapture(() => Promise.reject(new Error("Identity changed on disk")));
    await expect(fixture.capture.execute({ repositoryId: "web" })).rejects.toThrow(
      "Identity changed on disk",
    );
    expect(fixture.observation()).toBeUndefined();
  });
});

describe("durable capture handoff", () => {
  it("queues the exact saved observation, preserving A to B to A as three requests without duplicate content", async () => {
    const fixture = setup();
    const first = await fixture.reconcile.execute({ repositoryId: "web" });
    fixture.setNow("2026-09-24T12:00:01.000Z");
    fixture.setCapture((input) => Promise.resolve(captured(input, "b")));
    await fixture.reconcile.execute({ repositoryId: "web" });
    fixture.setNow("2026-09-24T12:00:02.000Z");
    fixture.setCapture((input) => Promise.resolve(captured(input, "a")));
    const last = await fixture.reconcile.execute({ repositoryId: "web" });
    expect(last.evaluated).toBe(true);
    expect(fixture.triggers()).toHaveLength(3);
    expect(fixture.triggers().map((item) => item.inputSummary["snapshotDigest"])).toEqual([
      "a",
      "b",
      "a",
    ]);
    expect(fixture.triggers()[2]?.evidenceCitations).toEqual(
      fixture.triggers()[0]?.evidenceCitations,
    );
    expect(first.evidence).toEqual(last.evidence);
    expect(fixture.evidence()).toHaveLength(2);
    expect(await fixture.reconcile.execute({ repositoryId: "web" })).toMatchObject({
      changed: false,
      evaluated: false,
      triggerIds: [],
    });
    expect(fixture.triggers()).toHaveLength(3);
  });

  it("keeps failed handoffs pending and retries them even when capture reports no change", async () => {
    const fixture = setup();
    fixture.failWrite("dispatch");
    await expect(fixture.reconcile.execute({ repositoryId: "web" })).rejects.toThrow(
      "Dispatch write failed",
    );
    expect(fixture.observation()).not.toHaveProperty("evaluatedSnapshotDigest");
    expect(fixture.evidence()).toHaveLength(1);
    expect(fixture.triggers()).toEqual([]);
    fixture.failWrite();
    expect(await fixture.reconcile.execute({ repositoryId: "web" })).toMatchObject({
      changed: false,
      evaluated: true,
    });
    expect(fixture.triggers()).toHaveLength(1);
  });

  it("recovers after a lost handoff and leaves deferred observations pending until capacity returns", async () => {
    const fixture = setup();
    await fixture.capture.execute({ repositoryId: "web" });
    fixture.fillQueue(100);
    expect(await fixture.pending.execute("web")).toMatchObject({
      evaluated: false,
      deferred: true,
    });
    expect(fixture.observation()).not.toHaveProperty("evaluatedSnapshotDigest");
    fixture.fillQueue(0);
    await fixture.pending.recover();
    expect(fixture.observation()?.evaluatedSnapshotDigest).toBe("a");
    expect(fixture.triggers()).toHaveLength(1);
    await fixture.pending.recover();
    expect(fixture.triggers()).toHaveLength(1);
  });

  it("preserves an unqueued observation when a later capture changes, then hands off both in order", async () => {
    const fixture = setup();
    fixture.failWrite("dispatch");
    await expect(fixture.reconcile.execute({ repositoryId: "web" })).rejects.toThrow();
    fixture.failWrite();
    fixture.fillQueue(100);
    fixture.setNow("2026-09-24T12:00:01.000Z");
    fixture.setCapture((input) => Promise.resolve(captured(input, "b")));
    await expect(fixture.reconcile.execute({ repositoryId: "web" })).rejects.toMatchObject({
      code: "repository_observation_conflict",
      retryable: true,
    });
    expect(fixture.observation()?.snapshot.snapshotDigest).toBe("a");
    expect(fixture.evidence()).toHaveLength(1);
    expect(fixture.triggers()).toEqual([]);
    fixture.fillQueue(0);
    expect(await fixture.reconcile.execute({ repositoryId: "web" })).toMatchObject({
      changed: true,
      evaluated: true,
    });
    expect(fixture.triggers().map((item) => item.inputSummary["snapshotDigest"])).toEqual([
      "a",
      "b",
    ]);
    expect(fixture.evidence()).toHaveLength(2);
  });

  it("reports a revoked repository and still recovers later pending repositories", async () => {
    const fixture = setup();
    await fixture.capture.execute({ repositoryId: "web" });
    const observation = fixture.observation();
    if (observation === undefined) throw new Error("Missing observation");
    const recoveryStore: UnitOfWorkPort = {
      execute: (work) =>
        fixture.store.execute((context) =>
          work({
            ...context,
            repositoryObservations: {
              ...context.repositoryObservations,
              listPendingEvaluation: () =>
                Promise.resolve([{ ...observation, repositoryId: "revoked" }, observation]),
            },
          }),
        ),
    };
    const recovered = await new EvaluatePendingRepository(
      recoveryStore,
      { next: () => "recovered" },
      { now: () => time },
    ).recover();
    expect(recovered).toMatchObject([
      { repositoryId: "revoked", error: { code: "repository_not_found" } },
      { repositoryId: "web", result: { evaluated: true } },
    ]);
    expect(fixture.observation()?.evaluatedSnapshotDigest).toBe("a");
    expect(fixture.triggers()).toHaveLength(1);
  });

  it("retries an existing queued request after interrupted acknowledgement without duplicating it", async () => {
    const fixture = setup();
    await fixture.capture.execute({ repositoryId: "web" });
    await fixture.evaluate.execute({ repositoryIds: ["web"], cooldownMinutes: 15 });
    expect(fixture.observation()).not.toHaveProperty("evaluatedSnapshotDigest");
    fixture.failWrite("mark");
    await expect(fixture.pending.execute("web")).rejects.toThrow("Cursor write failed");
    fixture.failWrite();
    expect(await fixture.pending.execute("web")).toMatchObject({ evaluated: true });
    expect(fixture.triggers()).toHaveLength(1);
  });

  it("persists all capture evidence but bounds seeds and identifies partial seeding", async () => {
    const fixture = setup();
    fixture.setCapture((input) => Promise.resolve(captured(input, "many", 100)));
    await fixture.reconcile.execute({ repositoryId: "web" });
    expect(fixture.evidence()).toHaveLength(100);
    expect(fixture.observation()?.evidenceIds).toHaveLength(100);
    expect(fixture.triggers()[0]?.evidenceCitations).toHaveLength(50);
    expect(fixture.triggers()[0]?.inputSummary).toMatchObject({
      evidenceCount: 100,
      seedEvidenceCount: 50,
    });
  });

  it("rolls back newly queued work when acknowledgement loses its observation fence", async () => {
    const fixture = setup();
    await fixture.capture.execute({ repositoryId: "web" });
    fixture.failWrite("fence");
    await expect(fixture.pending.execute("web")).rejects.toMatchObject({
      code: "repository_observation_conflict",
    });
    expect(fixture.triggers()).toEqual([]);
    expect(fixture.dispatches()).toEqual([]);
    expect(fixture.observation()).not.toHaveProperty("evaluatedSnapshotDigest");
  });

  it("does not acknowledge missing, foreign, hinted, or future observation support", async () => {
    const original = captured({
      repository,
      observedAt: time,
      nextEvidenceId: () => "old",
      nextEventId: () => "event",
    }).evidenceItems[0] as EvidenceItem;
    for (const item of [
      undefined,
      { ...original, repositoryId: "other" },
      { ...original, source: "replay" as const },
      { ...original, taskId: "task" },
      { ...original, sprintId: "sprint" },
      { ...original, occurredAt: "2026-09-25T00:00:00.000Z" },
    ]) {
      const fixture = setup({
        evidence: item === undefined ? [] : [item],
        observation: {
          repositoryId: "web",
          observedAt: time,
          snapshot: snapshot(),
          evidenceIds: ["old"],
        },
      });
      await expect(fixture.pending.execute("web")).rejects.toThrow();
      expect(fixture.triggers()).toEqual([]);
      expect(fixture.observation()).not.toHaveProperty("evaluatedSnapshotDigest");
    }
    for (const changed of [
      { evidenceIds: [] },
      { observedAt: "2026-09-25T00:00:00.000Z" },
      { snapshot: { ...snapshot(), rootPath: "/other" } },
    ]) {
      const fixture = setup({
        evidence: [original],
        observation: {
          repositoryId: "web",
          observedAt: time,
          snapshot: snapshot(),
          evidenceIds: ["old"],
          ...changed,
        },
      });
      await expect(fixture.pending.execute("web")).rejects.toThrow();
      expect(fixture.triggers()).toEqual([]);
    }
  });

  it("retains pending captures without an active sprint and rejects revoked registrations", async () => {
    const fixture = setup({ sprint: { ...sprint, state: "completed" } });
    await fixture.capture.execute({ repositoryId: "web" });
    expect(await fixture.pending.execute("web")).toMatchObject({
      evaluated: false,
      deferred: false,
    });
    expect(fixture.observation()).not.toHaveProperty("evaluatedSnapshotDigest");
    fixture.replaceRepository(undefined);
    await expect(fixture.pending.execute("web")).rejects.toMatchObject({
      code: "repository_not_found",
    });
  });
});

describe("bounded snapshot copying", () => {
  it("copies and freezes nested paths while preserving their exact names", () => {
    const value = {
      ...snapshot(),
      status: {
        clean: false,
        stagedCount: 1,
        unstagedCount: 0,
        untrackedCount: 0,
        totalPathCount: 1,
        paths: [{ path: " source.ts ", staged: true, unstaged: false, untracked: false }],
        pathsTruncated: false,
      },
    };
    const saved = createRepositoryObservationSnapshot(value);
    value.status.paths[0] = { path: "different", staged: true, unstaged: false, untracked: false };
    expect(saved.status.paths[0]?.path).toBe(" source.ts ");
    expect(Object.isFrozen(saved.status.paths[0])).toBe(true);
  });
  it("rejects invalid booleans, counts, paths, and oversized captured lists", () => {
    for (const value of [
      { ...snapshot(), detached: "yes" },
      { ...snapshot(), status: { ...snapshot().status, totalPathCount: -1 } },
      {
        ...snapshot(),
        status: {
          ...snapshot().status,
          totalPathCount: 1,
          paths: [{ path: "a", staged: 1, unstaged: false, untracked: false }],
        },
      },
      {
        ...snapshot(),
        status: {
          ...snapshot().status,
          totalPathCount: 201,
          paths: Array.from({ length: 201 }, () => ({
            path: "a",
            staged: true,
            unstaged: false,
            untracked: false,
          })),
        },
      },
    ])
      expect(() =>
        createRepositoryObservationSnapshot(value as RepositoryObservationSnapshot),
      ).toThrow();
  });
});
