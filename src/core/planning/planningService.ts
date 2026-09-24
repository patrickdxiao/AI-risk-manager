import {
  ApplicationError,
  DomainInvariantError,
  requireInteger,
  requireNonBlank,
  requireTimestampOrder,
  requireUtcTimestamp,
  type ClockPort,
  type IdGeneratorPort,
} from "../primitives.js";
import type { PlanningStore, UnitOfWorkPort } from "../storageContracts.js";
import {
  createSprint,
  createTask,
  transitionTaskState,
  type CreateSprintInput as SprintInput,
  type CreateTaskInput as TaskInput,
  type Sprint,
  type Task,
} from "./planningModel.js";

export const MAX_OPEN_TASKS = 1_000;
const MAX_DEPENDENCY_VISITS = 1_000;
export type CreateSprintInput = Omit<SprintInput, "id" | "createdAt">;
export type CreateTaskInput = Omit<TaskInput, "id" | "createdAt" | "updatedAt" | "version">;
export type EditTaskInput = Partial<
  Pick<
    Task,
    | "title"
    | "points"
    | "startAt"
    | "endAt"
    | "completionCriteria"
    | "pathHints"
    | "dependencyIds"
    | "state"
  >
> & { readonly taskId: string; readonly version: number; readonly description?: string | null };

export class CreateSprint {
  constructor(
    private readonly store: UnitOfWorkPort,
    private readonly ids: IdGeneratorPort,
    private readonly clock: ClockPort,
  ) {}

  /** A new active sprint closes the previous one in the same transaction. */
  execute(input: CreateSprintInput): Promise<Sprint> {
    return this.store.execute(async ({ planning }) => {
      const sprint = createSprint({ ...input, id: this.ids.next(), createdAt: this.clock.now() });
      if (sprint.state === "active") {
        const previous = await planning.findActiveSprint();
        if (previous !== undefined)
          await planning.saveSprint(Object.freeze({ ...previous, state: "completed" }));
      }
      await planning.addSprint(sprint);
      return sprint;
    });
  }
}

export class CreateTask {
  constructor(
    private readonly store: UnitOfWorkPort,
    private readonly ids: IdGeneratorPort,
    private readonly clock: ClockPort,
  ) {}

  /** Inherit missing dates from the saved sprint and validate prerequisites before admission. */
  execute(input: CreateTaskInput): Promise<Task> {
    return this.store.execute(async ({ planning }) => {
      const sprintId = requireNonBlank(input.sprintId, "sprintId", 200);
      const sprint = await planning.findSprintById(sprintId);
      if (sprint === undefined)
        throw new ApplicationError("sprint_not_found", "Sprint does not exist", "sprintId");
      const now = this.clock.now();
      const task = createTask({
        ...input,
        sprintId,
        id: this.ids.next(),
        createdAt: now,
        updatedAt: now,
        version: 1,
        startAt: input.startAt ?? sprint.startAt,
        endAt: input.endAt ?? sprint.endAt,
      });
      await validateDependencies(planning, task);
      if (task.state !== "done") await requireOpenTaskCapacity(planning);
      await planning.addTask(task);
      return task;
    });
  }
}

export class EditTask {
  constructor(
    private readonly store: UnitOfWorkPort,
    private readonly clock: ClockPort,
  ) {}

  /** Match the caller's version, then save one validated edit without changing task identity. */
  execute(input: EditTaskInput): Promise<Task> {
    return this.store.execute(async ({ planning }) => {
      const id = requireNonBlank(input.taskId, "taskId", 200);
      requireInteger(input.version, "version", 1);
      const previous = await planning.findTaskById(id);
      if (previous === undefined)
        throw new ApplicationError("task_not_found", "Task does not exist", "taskId");
      if (previous.version !== input.version)
        throw new ApplicationError(
          "task_version_conflict",
          "Task changed; reload before saving",
          "version",
        );
      const now = requireUtcTimestamp(this.clock.now(), "updatedAt");
      requireTimestampOrder(previous.updatedAt, now, "updatedAt");
      if (input.state !== undefined && input.state !== previous.state)
        transitionTaskState(previous, { to: input.state, actor: "user", occurredAt: now });
      const { description: oldDescription, ...previousFields } = previous;
      const { description: newDescription, ...patch } = input;
      const description = newDescription === null ? undefined : (newDescription ?? oldDescription);
      const task = createTask({
        ...previousFields,
        ...patch,
        ...(description === undefined ? {} : { description }),
        id: previous.id,
        sprintId: previous.sprintId,
        createdAt: previous.createdAt,
        updatedAt: now,
        version: previous.version + 1,
      });
      await validateDependencies(planning, task);
      if (previous.state === "done" && task.state !== "done")
        await requireOpenTaskCapacity(planning);
      await planning.saveTask(task);
      return task;
    });
  }
}

async function requireOpenTaskCapacity(planning: PlanningStore): Promise<void> {
  if ((await planning.countOpenTasks()) >= MAX_OPEN_TASKS)
    throw new DomainInvariantError(
      "out_of_range",
      `At most ${String(MAX_OPEN_TASKS)} unfinished tasks are supported`,
      "tasks",
    );
}

/** Existing links are validated on write; a newly introduced cycle must reach this task. */
async function validateDependencies(planning: PlanningStore, task: Task): Promise<void> {
  const pending = [...task.dependencyIds];
  const visited = new Set<string>();
  let visits = 0;
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined) break;
    if (++visits > MAX_DEPENDENCY_VISITS)
      throw new DomainInvariantError(
        "out_of_range",
        "Dependency graph exceeds 1,000 references",
        "dependencyIds",
      );
    if (id === task.id)
      throw new DomainInvariantError(
        "invalid_value",
        "Task dependencies must not form a cycle",
        "dependencyIds",
      );
    if (visited.has(id)) continue;
    visited.add(id);
    const dependency = await planning.findTaskById(id);
    if (dependency === undefined)
      throw new ApplicationError(
        "task_not_found",
        `Dependency ${id} does not exist`,
        "dependencyIds",
      );
    pending.push(...dependency.dependencyIds);
  }
}
