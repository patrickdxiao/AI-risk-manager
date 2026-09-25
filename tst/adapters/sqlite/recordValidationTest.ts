import { describe, expect, it } from "vitest";
import * as codec from "../../../src/adapters/sqlite/codecs.js";
import { parse } from "../../../src/adapters/sqlite/validation.js";
import { createInvestigation } from "../../../src/core/investigation/investigationModel.js";
import { before, now, evidence, repository, sprint, task } from "../../fixtures/riskFixture.js";
import { attempt, investigation, seeded, trigger } from "./fixture.js";

describe("validated SQLite record decoding", () => {
  it("fails closed on malformed stored authority, lifecycle, usage, and extra credential fields", async () => {
    const db = await seeded();
    await db.store.execute(async (tx) => {
      await tx.investigations.add(investigation());
      await tx.investigations.saveAttempt(attempt());
    });
    const valid = attempt();
    expect(() => {
      db.raw
        .prepare("UPDATE investigation_attempts SET data = ? WHERE id = ?")
        .run(JSON.stringify({ ...valid, version: 1.5 }), valid.id);
    }).toThrow("INTEGER");
    for (const corrupted of [
      { ...valid, authority: { ...valid.authority, credentialHash: "not-a-hash" } },
      { ...valid, authority: { ...valid.authority, repositoryIds: ["z", "a"] } },
      { ...valid, authority: { ...valid.authority, token: "risk_attempt.secret" } },
      { ...valid, authority: { ...valid.authority, reservedTokens: -1 } },
      { ...valid, usage: { totalTokens: -1 } },
      { ...valid, status: "unknown" },
      { ...valid, status: "succeeded" },
      { ...valid, leaseUntil: before },
      { ...valid, dispatchTriggerId: "trigger" },
      { ...valid, startedAt: "2026-09-24T02:00:00Z" },
    ]) {
      db.raw
        .prepare("UPDATE investigation_attempts SET data = ? WHERE id = ?")
        .run(JSON.stringify(corrupted), valid.id);
      await expect(
        db.store.execute((tx) => tx.investigations.findAttemptById(valid.id)),
      ).rejects.toThrow();
    }
    db.raw
      .prepare("UPDATE investigation_attempts SET data = ? WHERE id = ?")
      .run(JSON.stringify(valid), valid.id);
    expect(await db.store.execute((tx) => tx.investigations.findAttemptById(valid.id))).toEqual(
      valid,
    );
  });

  it("keeps missing attempt authority and usage absent and never upgrades them on read", () => {
    const unowned = { ...attempt() };
    delete unowned.authority;
    const restored = parse(JSON.stringify(unowned), codec.attempt);
    expect(restored).not.toHaveProperty("authority");
    expect(restored).not.toHaveProperty("usage");
    const request = createInvestigation({
      id: "request",
      sprintId: "sprint",
      taskId: "task",
      triggerId: "manual",
      requestedAt: now,
    });
    expect(parse(JSON.stringify(request), codec.investigation)).toEqual(request);
    for (const value of [
      { ...request, startedAt: now },
      { ...request, completedAt: now },
      { ...request, executionAttemptId: "attempt" },
    ])
      expect(() => codec.investigation(value)).toThrow();
  });

  it("rejects incompatible versions, unexpected legacy project fields and non-JSON values at writes", () => {
    for (const value of [
      { ...trigger(), version: "future" },
      { ...trigger(), inputSummary: { bad: Number.NaN } },
      { ...trigger(), inputSummary: { bad: {} } },
      { ...trigger(), repositoryIds: [repository.id, repository.id] },
    ])
      expect(() => codec.queue(value)).toThrow();
    expect(() => codec.sprint({ ...sprint(), projectId: "legacy" })).toThrow();
    expect(() => codec.task({ ...task(), sprintId: null })).toThrow();
    expect(() =>
      codec.evidence({ ...evidence, metadata: { value: Number.POSITIVE_INFINITY } }),
    ).toThrow();
    expect(() => codec.repository({ ...repository, gitRoot: 1 })).toThrow();
    expect(() => codec.repository({ ...repository, canonicalPath: " ".repeat(5_000) })).toThrow();
    expect(() => codec.repository([])).toThrow();
    expect(() => parse("{bad", codec.repository)).toThrow();
  });

  it("uses bound parameters for adversarial-looking IDs and scopes", async () => {
    const db = await seeded();
    const id = "id'; DROP TABLE evidence; --";
    await db.store.execute(async (tx) => {
      await tx.evidence.add({ ...evidence, id, digest: id });
      expect(await tx.evidence.findById(id)).toMatchObject({ id });
      expect(await tx.evidence.findScoped({ repositoryId: id, limit: 1 })).toEqual([]);
      expect(await tx.evidence.findById(evidence.id)).toEqual(evidence);
    });
  });
});
