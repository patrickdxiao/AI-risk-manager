import { describe, expect, it, vi } from "vitest";
import type {
  Repository,
  RepositoryRegistrationInspection,
} from "../../../src/core/repository/repositoryModel.js";
import { RegisterRepository } from "../../../src/core/repository/repositoryService.js";
import {
  RepositoryConflictError,
  type RepositoryStore,
  type TransactionContext,
  type UnitOfWorkPort,
} from "../../../src/core/storageContracts.js";

const request = { path: "/approved/worktree", approvedRoot: "/approved", stateDirectory: "/state" };
const inspected = { canonicalRoot: "/approved/worktree", identityDigest: "identity-1" };

function setup() {
  let records: Repository[] = [];
  let previous: Promise<unknown> = Promise.resolve();
  let inTransaction = false;
  let nextId = 0;
  const store: UnitOfWorkPort = {
    execute<T>(work: (context: TransactionContext) => Promise<T>): Promise<T> {
      const pending = previous.then(async () => {
        const next = [...records];
        const repositories: RepositoryStore = {
          list: () => Promise.resolve([...next]),
          findById: (id) => Promise.resolve(next.find((record) => record.id === id)),
          add: (record) => {
            if (next.some((item) => item.id === record.id))
              throw new RepositoryConflictError("id", record.id);
            if (next.some((item) => item.canonicalPath === record.canonicalPath))
              throw new RepositoryConflictError("canonical_path", record.canonicalPath);
            next.push(record);
            return Promise.resolve();
          },
        };
        inTransaction = true;
        try {
          const result = await work(
            new Proxy({} as TransactionContext, {
              get(_target, key) {
                if (key === "repositories") return repositories;
                throw new Error(`Unexpected registration dependency: ${String(key)}`);
              },
            }),
          );
          records = next;
          return result;
        } finally {
          inTransaction = false;
        }
      });
      previous = pending.catch(() => undefined);
      return pending;
    },
  };
  const inspectRegistration = vi.fn((): Promise<RepositoryRegistrationInspection> => {
    expect(inTransaction).toBe(false);
    return Promise.resolve(inspected);
  });
  const ids = { next: vi.fn(() => `repository-${String(++nextId)}`) };
  const service = new RegisterRepository(store, { inspectRegistration }, ids, {
    now: () => "2026-09-24T08:00:00Z",
  });
  return { service, inspectRegistration, ids, records: () => records };
}

describe("repository registration", () => {
  it("saves the inspected identity without requiring a sprint and preserves path spaces", async () => {
    const fixture = setup();
    fixture.inspectRegistration.mockResolvedValue({
      ...inspected,
      canonicalRoot: "/approved/worktree ",
    });
    const repository = await fixture.service.execute(request);
    expect(fixture.inspectRegistration).toHaveBeenCalledWith(request);
    expect(repository).toEqual({
      id: "repository-1",
      approvedRoot: "/approved",
      canonicalPath: "/approved/worktree ",
      gitRoot: "/approved/worktree ",
      identityDigest: "identity-1",
      registeredAt: "2026-09-24T08:00:00.000Z",
    });
    expect(fixture.records()).toEqual([repository]);
    expect(Object.isFrozen(repository)).toBe(true);
  });

  it("retains the inspected approval when the caller mutates its input during inspection", async () => {
    const fixture = setup();
    const mutable = { ...request };
    const pending = fixture.service.execute(mutable);
    mutable.approvedRoot = "/";
    expect((await pending).approvedRoot).toBe("/approved");
    expect(fixture.inspectRegistration).toHaveBeenCalledWith(request);
  });

  it("coalesces concurrent registration of the same inspected identity", async () => {
    const fixture = setup();
    const results = await Promise.all([
      fixture.service.execute(request),
      fixture.service.execute(request),
    ]);
    expect(results[0]).toBe(results[1]);
    expect(fixture.records()).toHaveLength(1);
    expect(fixture.ids.next).toHaveBeenCalledTimes(1);
  });

  it("does not replace a registered identity when the path points to another repository", async () => {
    const fixture = setup();
    const original = await fixture.service.execute(request);
    fixture.inspectRegistration.mockResolvedValue({ ...inspected, identityDigest: "replacement" });
    await expect(fixture.service.execute(request)).rejects.toMatchObject({
      conflict: "canonical_path",
    });
    expect(fixture.records()).toEqual([original]);
  });

  it("keeps prior approval unchanged when registering the same identity again", async () => {
    const fixture = setup();
    const original = await fixture.service.execute(request);
    expect(await fixture.service.execute({ ...request, approvedRoot: "/" })).toBe(original);
    expect(fixture.records()[0]?.approvedRoot).toBe("/approved");
  });

  it("does not persist failed inspection or invalid returned identity", async () => {
    const fixture = setup();
    fixture.inspectRegistration.mockRejectedValueOnce(new Error("outside approved roots"));
    await expect(fixture.service.execute(request)).rejects.toThrow("outside approved roots");
    fixture.inspectRegistration.mockResolvedValue({ ...inspected, identityDigest: " " });
    await expect(fixture.service.execute(request)).rejects.toThrow();
    expect(fixture.records()).toEqual([]);
  });
});
