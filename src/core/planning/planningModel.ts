import type {
  PrivacyMode,
  ProjectId,
  RepositoryId,
  SprintId,
  TaskId,
  UtcTimestamp,
} from "../primitives.js";
export interface Project {
  readonly id: ProjectId;
  readonly name: string;
  readonly timezone: string;
  readonly privacyMode: PrivacyMode;
  readonly activeRepositoryId?: RepositoryId;
  readonly createdAt: UtcTimestamp;
}

export interface CreateProjectInput {
  readonly id: ProjectId;
  readonly name: string;
  readonly timezone: string;
  readonly privacyMode?: PrivacyMode;
  readonly activeRepositoryId?: RepositoryId;
  readonly createdAt: string;
}

export type SprintState = "planned" | "active" | "completed";

export interface Sprint {
  readonly id: SprintId;
  readonly projectId: ProjectId;
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
  readonly projectId: ProjectId;
  readonly startAt: string;
  readonly endAt: string;
  readonly goal?: string;
  readonly assumptions?: readonly string[];
  readonly reviewCadenceMinutes: number;
  readonly pointTarget: number;
  readonly state?: SprintState;
  readonly createdAt: string;
}

export type TaskState = "planned" | "in_progress" | "needs_confirmation" | "done";

export type TaskTransitionActor = "user" | "investigation";

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
