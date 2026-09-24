import { describe, expect, it } from "vitest";
import {
  RequestReview,
  type RequestReviewInput,
} from "../../../src/core/triggers/requestReview.js";
import { MAX_PENDING_REVIEWS } from "../../../src/core/triggers/triggerService.js";
import {
  pendingTriggerDispatch,
  type TriggerQueueRecord,
} from "../../../src/core/triggers/triggerModel.js";
import { reviewQueueFixture } from "../../fixtures/reviewQueueFixture.js";
import { now, repository, sprint, task } from "../../fixtures/riskFixture.js";

const manual = (requestId = "click-1"): RequestReviewInput => ({
  type: "manual_review",
  requestId,
  sprintId: "sprint",
  repositoryIds: [],
});
function setup(seed: Parameters<typeof reviewQueueFixture>[0] = {}) {
  const fixture = reviewQueueFixture({
    sprints: [sprint()],
    tasks: [task()],
    repositories: [repository],
    ...seed,
  });
  let sequence = 0;
  const requests = new RequestReview(
    fixture.store,
    { next: () => `request-${String(++sequence)}` },
    { now: () => now },
  );
  return { ...fixture, requests };
}

describe("manual and plan review requests", () => {
  it("admits one explicit manual action across concurrent retries and later plan edits", async () => {
    const tasks = [task()];
    const fixture = setup({ tasks });
    const [first, retry] = await Promise.all([
      fixture.requests.execute(manual()),
      fixture.requests.execute(manual()),
    ]);
    expect(first.status).toBe("queued");
    expect(retry).toEqual({ status: "existing", trigger: first.trigger });
    tasks[0] = task("task", { title: "Edited later", version: 2 });
    expect(await fixture.requests.execute(manual())).toEqual(retry);
    expect(first.trigger).toMatchObject({
      type: "manual_review",
      repositoryIds: [],
      evidenceCitations: [],
      inputSummary: { requestId: "click-1" },
    });
    expect(await fixture.requests.execute(manual("another-click"))).toMatchObject({
      status: "queued",
    });
    expect(fixture.dispatches()).toHaveLength(2);
  });

  it("rejects reuse of a manual request ID for a different target or repository scope", async () => {
    const fixture = setup({ sprints: [sprint(), sprint("other")] });
    await fixture.requests.execute(manual());
    for (const scope of [
      { repositoryIds: [repository.id] },
      { sprintId: "other" },
      { taskId: "task" },
    ])
      await expect(fixture.requests.execute({ ...manual(), ...scope })).rejects.toMatchObject({
        field: "dedupKey",
      });
    expect(fixture.triggers()).toHaveLength(1);
  });

  it("captures the current saved plan digest, including prerequisite versions, in admission", async () => {
    const tasks = [
      task("task", { dependencyIds: ["earlier"] }),
      task("earlier", { sprintId: "previous" }),
    ];
    const fixture = setup({ tasks });
    const input: RequestReviewInput = {
      type: "plan_changed",
      sprintId: "sprint",
      taskId: "task",
      repositoryIds: [repository.id],
    };
    const first = await fixture.requests.execute(input);
    expect(first.trigger.inputSummary["planningDigest"]).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.trigger.inputSummary).not.toHaveProperty("requestedAt");
    expect(await fixture.requests.execute(input)).toMatchObject({
      status: "existing",
      trigger: { id: first.trigger.id },
    });
    tasks[1] = task("earlier", { sprintId: "previous", version: 2 });
    const changed = await fixture.requests.execute(input);
    expect(changed.status).toBe("queued");
    expect(changed.trigger.dedupKey).not.toBe(first.trigger.dedupKey);
    expect(changed.trigger.evidenceCitations).toEqual([]);
  });

  it("snapshots explicit scope and ignores arbitrary caller summaries", async () => {
    const fixture = setup();
    const repositoryIds = [repository.id, repository.id];
    const input = {
      type: "manual_review" as const,
      requestId: "click",
      sprintId: "sprint",
      repositoryIds,
      inputSummary: { repositoryIds: ["unapproved"] },
      reason: "Arbitrary model instructions",
    };
    const pending = fixture.requests.execute(input);
    input.sprintId = "missing";
    repositoryIds.push("unapproved");
    const result = await pending;
    expect(result.trigger.repositoryIds).toEqual([repository.id]);
    expect(result.trigger.inputSummary).toEqual({ requestId: "click" });
    expect(result.trigger.reason).toBe("The user requested a review.");
  });

  it("rejects invalid scope, absent request IDs and unsupported request types without writes", async () => {
    const fixture = setup();
    for (const input of [
      { ...manual(), sprintId: "missing" },
      { ...manual(), taskId: "missing" },
      { ...manual(), repositoryIds: ["unapproved"] },
      { ...manual(), requestId: " " },
      { ...manual(), type: "git_change" } as unknown as RequestReviewInput,
      { type: "plan_changed" as const, sprintId: "missing", repositoryIds: [] },
    ])
      await expect(fixture.requests.execute(input)).rejects.toBeInstanceOf(Error);
    expect(fixture.triggers()).toEqual([]);
  });

  it("uses the same global unfinished queue capacity as observed reviews", async () => {
    const triggers: TriggerQueueRecord[] = Array.from(
      { length: MAX_PENDING_REVIEWS },
      (_, index) => ({
        version: "trigger-queue-record.v1",
        id: String(index),
        type: "manual_review",
        sprintId: "sprint",
        repositoryIds: [],
        dedupKey: String(index),
        reason: "Earlier request",
        inputSummary: {},
        evidenceDigests: [],
        evidenceCitations: [],
        observedAt: now,
        cooldownUntil: now,
      }),
    );
    const fixture = setup({
      triggers,
      dispatches: triggers.map((item) => pendingTriggerDispatch(item.id, now)),
    });
    await expect(fixture.requests.execute(manual())).rejects.toMatchObject({
      code: "investigation_queue_full",
    });
    expect(fixture.triggers()).toHaveLength(MAX_PENDING_REVIEWS);
  });
});
