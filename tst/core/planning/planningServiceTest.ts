import { describe, expect, it } from "vitest";
import {
  createSprint,
  createTask,
  type Sprint,
  type Task,
} from "../../../src/core/planning/planningModel.js";
import {
  CreateSprint,
  CreateTask,
  EditTask,
  MAX_OPEN_TASKS,
} from "../../../src/core/planning/planningService.js";
import { ApplicationError, DomainInvariantError } from "../../../src/core/primitives.js";
import { PlanningEntityAlreadyExistsError } from "../../../src/core/storageContracts.js";
import { planningFixture } from "../../fixtures/planningFixture.js";

const now = "2026-09-24T00:00:00Z";
const sprintInput = {
  startAt: now,
  endAt: "2026-10-02T00:00:00Z",
  pointTarget: 8,
  reviewCadenceMinutes: 30,
};
const taskInput = { sprintId: "sprint", title: "Checkout", points: 3 };
const sprint = (id = "sprint") =>
  createSprint({ ...sprintInput, id, createdAt: now, state: "active" });
const task = (id: string, overrides: Partial<Task> = {}) =>
  createTask({
    ...taskInput,
    id,
    createdAt: now,
    startAt: sprintInput.startAt,
    endAt: sprintInput.endAt,
    ...overrides,
  });

function setup(
  seed: { sprints?: readonly Sprint[]; tasks?: readonly Task[] } = { sprints: [sprint()] },
) {
  const fixture = planningFixture(seed);
  let sequence = 0;
  let time = now;
  const ids = { next: () => `new-${String(++sequence)}` };
  const clock = { now: () => time };
  return {
    ...fixture,
    createSprint: new CreateSprint(fixture.store, ids, clock),
    createTask: new CreateTask(fixture.store, ids, clock),
    editTask: new EditTask(fixture.store, clock),
    setNow(value: string) {
      time = value;
    },
  };
}

describe("saved sprint plans", () => {
  it("closes the previous active sprint while retaining its unfinished work", async () => {
    const savedTask = task("old-task");
    const fixture = setup({ sprints: [sprint()], tasks: [savedTask] });
    const created = await fixture.createSprint.execute({ ...sprintInput, state: "active" });
    expect(fixture.sprints()).toEqual([{ ...sprint(), state: "completed" }, created]);
    expect(fixture.tasks()).toEqual([savedTask]);
    const planned = await fixture.createSprint.execute(sprintInput);
    expect(planned.state).toBe("planned");
    expect(fixture.sprints().filter((value) => value.state === "active")).toEqual([created]);
  });

  it("can start the first sprint and rolls back closure when the next insert fails", async () => {
    const fixture = setup({});
    const first = await fixture.createSprint.execute({ ...sprintInput, state: "active" });
    const duplicate = new CreateSprint(fixture.store, { next: () => first.id }, { now: () => now });
    await expect(duplicate.execute({ ...sprintInput, state: "active" })).rejects.toBeInstanceOf(
      PlanningEntityAlreadyExistsError,
    );
    expect(fixture.sprints()).toEqual([first]);
    // A failed transaction does not block subsequent commands.
    await expect(fixture.createSprint.execute(sprintInput)).resolves.toMatchObject({
      state: "planned",
    });
  });
});

describe("saved tasks", () => {
  it("assigns task identity, version, and timestamps even when a caller supplies extra fields", async () => {
    const fixture = setup();
    const input = {
      ...taskInput,
      id: "caller-id",
      version: 99,
      createdAt: "2099-01-01T00:00:00Z",
      updatedAt: "2099-01-01T00:00:00Z",
    };
    const created = await fixture.createTask.execute(input);
    expect(created).toMatchObject({
      id: "new-1",
      version: 1,
      createdAt: "2026-09-24T00:00:00.000Z",
      updatedAt: "2026-09-24T00:00:00.000Z",
    });
    await expect(
      fixture.editTask.execute({ taskId: created.id, version: 1, title: "Edited" }),
    ).resolves.toMatchObject({ version: 2 });
  });

  it("inherits sprint dates and allows prerequisites from another sprint", async () => {
    const prerequisite = task("api", { sprintId: "earlier" });
    const fixture = setup({ sprints: [sprint(), sprint("earlier")], tasks: [prerequisite] });
    const created = await fixture.createTask.execute({
      ...taskInput,
      sprintId: " sprint ",
      dependencyIds: ["api"],
    });
    expect(created).toMatchObject({
      sprintId: "sprint",
      version: 1,
      dependencyIds: ["api"],
      startAt: "2026-09-24T00:00:00.000Z",
      endAt: "2026-10-02T00:00:00.000Z",
    });
    const explicit = await fixture.createTask.execute({
      ...taskInput,
      startAt: "2026-09-25T00:00:00Z",
      endAt: "2026-09-26T00:00:00Z",
      state: "done",
    });
    expect(explicit).toMatchObject({
      startAt: "2026-09-25T00:00:00.000Z",
      endAt: "2026-09-26T00:00:00.000Z",
      state: "done",
    });
    expect(fixture.tasks()).toEqual([prerequisite, created, explicit]);
  });

  it("rejects missing sprint or dependency records without storing a partial task", async () => {
    const fixture = setup();
    await expect(
      fixture.createTask.execute({ ...taskInput, sprintId: "absent" }),
    ).rejects.toMatchObject({ code: "sprint_not_found" });
    await expect(
      fixture.createTask.execute({ ...taskInput, dependencyIds: ["absent"] }),
    ).rejects.toMatchObject({ code: "task_not_found", field: "dependencyIds" });
    expect(fixture.tasks()).toEqual([]);
  });

  it("rejects self-dependencies and cycles, while accepting shared prerequisites", async () => {
    const fixture = setup({
      sprints: [sprint()],
      tasks: [
        task("a"),
        task("b", { dependencyIds: ["a"] }),
        task("c", { dependencyIds: ["a", "b"] }),
      ],
    });
    await expect(
      fixture.createTask.execute({ ...taskInput, dependencyIds: ["new-1"] }),
    ).rejects.toBeInstanceOf(DomainInvariantError);
    await expect(
      fixture.editTask.execute({ taskId: "a", version: 1, dependencyIds: ["c"] }),
    ).rejects.toMatchObject({ code: "invalid_value", field: "dependencyIds" });
    expect(fixture.tasks().find((value) => value.id === "a")?.dependencyIds).toEqual([]);
    await expect(
      fixture.createTask.execute({ ...taskInput, dependencyIds: ["b", "c"] }),
    ).resolves.toMatchObject({ dependencyIds: ["b", "c"] });
  });

  it("bounds traversal even when prerequisites are archived", async () => {
    const archived = Array.from({ length: 1_001 }, (_, index) =>
      task(`archived-${String(index)}`, {
        state: "done",
        dependencyIds: index === 1_000 ? [] : [`archived-${String(index + 1)}`],
      }),
    );
    const fixture = setup({ sprints: [sprint()], tasks: archived });
    await expect(
      fixture.createTask.execute({ ...taskInput, dependencyIds: ["archived-0"] }),
    ).rejects.toMatchObject({ code: "out_of_range", field: "dependencyIds" });
    expect(fixture.tasks()).toEqual(archived);
  });

  it("caps unfinished work while still allowing completion and admission after space is freed", async () => {
    const open = Array.from({ length: MAX_OPEN_TASKS }, (_, index) =>
      task(`open-${String(index)}`),
    );
    const fixture = setup({
      sprints: [sprint()],
      tasks: [...open, task("done", { state: "done" })],
    });
    await expect(fixture.createTask.execute(taskInput)).rejects.toMatchObject({
      code: "out_of_range",
      field: "tasks",
    });
    await expect(
      fixture.editTask.execute({ taskId: "done", version: 1, state: "in_progress" }),
    ).rejects.toMatchObject({ code: "out_of_range", field: "tasks" });
    await fixture.editTask.execute({ taskId: "open-0", version: 1, state: "done" });
    await expect(
      fixture.editTask.execute({ taskId: "done", version: 1, state: "in_progress" }),
    ).resolves.toMatchObject({ version: 2 });
    await fixture.editTask.execute({ taskId: "open-1", version: 1, state: "done" });
    await fixture.createTask.execute(taskInput);
    expect(fixture.tasks().filter((value) => value.state !== "done")).toHaveLength(MAX_OPEN_TASKS);
  });
});

describe("versioned task edits", () => {
  it("preserves identity, edits criteria, clears descriptions, and requires explicit valid state changes", async () => {
    const original = task("task", { description: "Old context" });
    const fixture = setup({ sprints: [sprint()], tasks: [original] });
    const edited = await fixture.editTask.execute({
      taskId: "task",
      version: 1,
      title: "Updated checkout",
      completionCriteria: ["Formats dollars"],
    });
    expect(edited).toMatchObject({
      id: original.id,
      sprintId: original.sprintId,
      createdAt: original.createdAt,
      description: "Old context",
      version: 2,
    });
    const cleared = await fixture.editTask.execute({
      taskId: "task",
      version: 2,
      description: null,
      state: "in_progress",
    });
    expect(cleared).not.toHaveProperty("description");
    const described = await fixture.editTask.execute({
      taskId: "task",
      version: 3,
      description: "New context",
      state: "in_progress",
    });
    expect(described).toMatchObject({ description: "New context", version: 4 });
    await expect(
      fixture.editTask.execute({ taskId: "task", version: 4, state: "needs_confirmation" }),
    ).rejects.toBeInstanceOf(DomainInvariantError);
    expect(fixture.tasks()).toEqual([described]);
    expect(original.description).toBe("Old context");
  });

  it("serializes conflicting edits so exactly one current-version edit wins", async () => {
    const fixture = setup({ sprints: [sprint()], tasks: [task("task")] });
    const results = await Promise.allSettled([
      fixture.editTask.execute({ taskId: "task", version: 1, title: "First" }),
      fixture.editTask.execute({ taskId: "task", version: 1, title: "Second" }),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(results[1]).toMatchObject({
      reason: new ApplicationError(
        "task_version_conflict",
        "Task changed; reload before saving",
        "version",
      ),
    });
    expect(fixture.tasks()).toMatchObject([{ title: "First", version: 2 }]);
  });

  it("rejects missing tasks, stale clock values, and version overflow without changes", async () => {
    const current = task("task", { updatedAt: "2026-09-25T00:00:00.000Z" });
    const overflow = task("overflow", { version: Number.MAX_SAFE_INTEGER });
    const fixture = setup({ sprints: [sprint()], tasks: [current, overflow] });
    await expect(fixture.editTask.execute({ taskId: "absent", version: 1 })).rejects.toMatchObject({
      code: "task_not_found",
    });
    await expect(
      fixture.editTask.execute({ taskId: "task", version: 1, title: "Backdated" }),
    ).rejects.toMatchObject({ code: "invalid_date_range" });
    fixture.setNow("2026-09-25T00:00:00Z");
    await expect(
      fixture.editTask.execute({ taskId: "overflow", version: Number.MAX_SAFE_INTEGER }),
    ).rejects.toMatchObject({ code: "out_of_range", field: "version" });
    expect(fixture.tasks()).toEqual([current, overflow]);
  });
});
