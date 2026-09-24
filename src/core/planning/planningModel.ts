import {
  DomainInvariantError,
  normalizeStringList,
  optionalNonBlank,
  requireInteger,
  requireNonBlank,
  requireTimestampOrder,
  requireUtcTimestamp,
  type SprintId,
  type TaskId,
  type UtcTimestamp,
} from "../primitives.js";

const SPRINT_STATES = ["planned", "active", "completed"] as const;
export type SprintState = (typeof SPRINT_STATES)[number];

export interface Sprint {
  readonly id: SprintId;
  readonly startAt: UtcTimestamp;
  readonly endAt: UtcTimestamp;
  readonly goal?: string;
  readonly assumptions?: readonly string[];
  readonly reviewCadenceMinutes: number;
  readonly pointTarget: number;
  readonly state: SprintState;
  readonly createdAt: UtcTimestamp;
}

export interface CreateSprintInput {
  readonly id: SprintId;
  readonly startAt: string;
  readonly endAt: string;
  readonly goal?: string;
  readonly assumptions?: readonly string[];
  readonly reviewCadenceMinutes: number;
  readonly pointTarget: number;
  readonly state?: SprintState;
  readonly createdAt: string;
}

/** Validate a sprint before it enters storage. */
export function createSprint(input: CreateSprintInput): Sprint {
  const startAt = requireUtcTimestamp(input.startAt, "startAt");
  const endAt = requireUtcTimestamp(input.endAt, "endAt");
  requireTimestampOrder(startAt, endAt, "endAt", false);
  const goal = optionalNonBlank(input.goal, "goal");
  const state = input.state ?? "planned";
  if (!SPRINT_STATES.includes(state))
    throw new DomainInvariantError("invalid_value", "Sprint state is invalid", "state");
  return Object.freeze({
    id: requireNonBlank(input.id, "id", 200),
    startAt,
    endAt,
    ...(goal === undefined ? {} : { goal }),
    assumptions: normalizeStringList(input.assumptions ?? [], "assumptions"),
    reviewCadenceMinutes: requireInteger(input.reviewCadenceMinutes, "reviewCadenceMinutes", 1),
    pointTarget: requireInteger(input.pointTarget, "pointTarget", 0),
    state,
    createdAt: requireUtcTimestamp(input.createdAt, "createdAt"),
  });
}

const TASK_STATES = ["planned", "in_progress", "needs_confirmation", "done"] as const;
export type TaskState = (typeof TASK_STATES)[number];

const TASK_TRANSITION_ACTORS = ["user", "investigation"] as const;
export type TaskTransitionActor = (typeof TASK_TRANSITION_ACTORS)[number];

export interface Task {
  readonly id: TaskId;
  readonly sprintId: SprintId;
  readonly title: string;
  readonly description?: string;
  readonly points: number;
  readonly state: TaskState;
  readonly startAt: UtcTimestamp;
  readonly endAt: UtcTimestamp;
  readonly version: number;
  readonly dependencyIds: readonly TaskId[];
  readonly completionCriteria: readonly string[];
  readonly pathHints: readonly string[];
  readonly createdAt: UtcTimestamp;
  readonly updatedAt: UtcTimestamp;
}

export interface CreateTaskInput {
  readonly id: TaskId;
  readonly sprintId: SprintId;
  readonly title: string;
  readonly description?: string;
  readonly points: number;
  readonly state?: TaskState;
  readonly startAt?: string;
  readonly endAt?: string;
  readonly version?: number;
  readonly dependencyIds?: readonly TaskId[];
  readonly completionCriteria?: readonly string[];
  readonly pathHints?: readonly string[];
  readonly createdAt: string;
  readonly updatedAt?: string;
}

export interface TaskStateTransition {
  readonly taskId: TaskId;
  readonly from: TaskState;
  readonly to: TaskState;
  readonly actor: TaskTransitionActor;
  readonly occurredAt: UtcTimestamp;
}

const USER_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  planned: ["in_progress", "done"],
  in_progress: ["planned", "done"],
  needs_confirmation: ["in_progress", "done"],
  done: ["in_progress"],
};

/** The dashboard offers the same explicit actions accepted by task edits. */
export function getUserTaskTransitions(state: TaskState): readonly TaskState[] {
  return Object.freeze([...USER_TRANSITIONS[state]]);
}

/** Validate task details after the caller supplies explicit or inherited sprint dates. */
export function createTask(input: CreateTaskInput & Pick<Task, "startAt" | "endAt">): Task {
  const id = requireNonBlank(input.id, "id", 200);
  const createdAt = requireUtcTimestamp(input.createdAt, "createdAt");
  const updatedAt = requireUtcTimestamp(input.updatedAt ?? input.createdAt, "updatedAt");
  requireTimestampOrder(createdAt, updatedAt, "updatedAt");
  const startAt = requireUtcTimestamp(input.startAt, "startAt");
  const endAt = requireUtcTimestamp(input.endAt, "endAt");
  requireTimestampOrder(startAt, endAt, "endAt", false);
  const description = optionalNonBlank(input.description, "description");
  const state = input.state ?? "planned";
  if (!TASK_STATES.includes(state))
    throw new DomainInvariantError("invalid_value", "Task state is invalid", "state");
  const dependencyIds = normalizeStringList(input.dependencyIds ?? [], "dependencyIds", 1_000, 200);
  if (dependencyIds.includes(id))
    throw new DomainInvariantError(
      "self_dependency",
      "A task cannot depend on itself",
      "dependencyIds",
    );
  if (new Set(dependencyIds).size !== dependencyIds.length)
    throw new DomainInvariantError(
      "duplicate_reference",
      "Task dependencies must be unique",
      "dependencyIds",
    );
  return Object.freeze({
    id,
    sprintId: requireNonBlank(input.sprintId, "sprintId", 200),
    title: requireNonBlank(input.title, "title", 500),
    ...(description === undefined ? {} : { description }),
    points: requireInteger(input.points, "points", 1),
    state,
    startAt,
    endAt,
    version: requireInteger(input.version ?? 1, "version", 1),
    dependencyIds,
    completionCriteria: normalizeStringList(
      input.completionCriteria ?? [],
      "completionCriteria",
      50,
    ),
    pathHints: normalizeStringList(input.pathHints ?? [], "pathHints", 100, 4_096),
    createdAt,
    updatedAt,
  });
}

/** Investigations may request confirmation; only a user can mark work done or reopen it. */
export function transitionTaskState(
  task: Task,
  input: {
    readonly to: TaskState;
    readonly actor: TaskTransitionActor;
    readonly occurredAt: string;
  },
): { readonly task: Task; readonly transition: TaskStateTransition } {
  const occurredAt = requireUtcTimestamp(input.occurredAt, "occurredAt");
  requireTimestampOrder(task.updatedAt, occurredAt, "occurredAt");
  const allowed =
    TASK_TRANSITION_ACTORS.includes(input.actor) &&
    (input.actor === "investigation"
      ? (task.state === "planned" || task.state === "in_progress") &&
        input.to === "needs_confirmation"
      : USER_TRANSITIONS[task.state].includes(input.to));
  if (!allowed)
    throw new DomainInvariantError(
      "invalid_transition",
      `${input.actor} cannot move a task from ${task.state} to ${input.to}`,
      "state",
    );
  return Object.freeze({
    task: Object.freeze({
      ...task,
      state: input.to,
      updatedAt: occurredAt,
      version: requireInteger(task.version + 1, "version", 1),
    }),
    transition: Object.freeze({
      taskId: task.id,
      from: task.state,
      to: input.to,
      actor: input.actor,
      occurredAt,
    }),
  });
}
