import { createHash } from "node:crypto";
import { requiresRepositoryId, type EvidenceItem } from "../evidence/evidenceModel.js";
import type { Sprint, Task } from "../planning/planningModel.js";
import { ApplicationError, DomainInvariantError } from "../primitives.js";
import type { TransactionContext } from "../storageContracts.js";
import type { Investigation, InvestigationAttempt } from "./investigationModel.js";

export interface PlanningContext {
  readonly sprint: Sprint;
  readonly tasks: readonly Task[];
  readonly dependencies: readonly Task[];
}

/** Load the saved task closure without expanding repository access. */
export async function selectPlanningContext(
  store: TransactionContext,
  investigation: Pick<Investigation, "sprintId" | "taskId">,
): Promise<PlanningContext> {
  const sprint = await store.planning.findSprintById(investigation.sprintId);
  if (sprint === undefined)
    throw new ApplicationError("sprint_not_found", "Sprint does not exist", "sprintId");
  const task =
    investigation.taskId === undefined
      ? undefined
      : await store.planning.findTaskById(investigation.taskId);
  if (investigation.taskId !== undefined && task === undefined)
    throw new ApplicationError("task_not_found", "Task does not exist", "taskId");
  if (task !== undefined && task.sprintId !== sprint.id)
    throw new ApplicationError(
      "task_scope_mismatch",
      "Task does not belong to the investigation sprint",
      "taskId",
    );
  const tasks = task === undefined ? await store.planning.findTasksBySprintId(sprint.id) : [task];
  const selected = new Map(tasks.map((item) => [item.id, item]));
  const pending = [...tasks];
  let references = 0;
  while (pending.length > 0) {
    if (selected.size > 1_000)
      throw new DomainInvariantError("out_of_range", "Plan context exceeds 1,000 tasks", "tasks");
    const current = pending.pop();
    if (current === undefined) break;
    for (const id of current.dependencyIds) {
      if (++references > 10_000)
        throw new DomainInvariantError(
          "out_of_range",
          "Plan context exceeds 10,000 dependency references",
          "dependencyIds",
        );
      if (selected.has(id)) continue;
      const dependency = await store.planning.findTaskById(id);
      if (dependency === undefined)
        throw new ApplicationError(
          "task_not_found",
          "A prerequisite task no longer exists",
          "dependencyIds",
        );
      selected.set(id, dependency);
      pending.push(dependency);
    }
  }
  const rootIds = new Set(tasks.map((item) => item.id));
  const byId = (a: Task, b: Task) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return Object.freeze({
    sprint,
    tasks: Object.freeze([...tasks].sort(byId)),
    dependencies: Object.freeze(
      [...selected.values()].filter((item) => !rootIds.has(item.id)).sort(byId),
    ),
  });
}

/** Task versions include prerequisites in earlier sprints; the sprint has no version yet. */
export async function planningDigest(
  store: TransactionContext,
  investigation: Pick<Investigation, "sprintId" | "taskId">,
): Promise<string> {
  const { sprint, tasks, dependencies } = await selectPlanningContext(store, investigation);
  return createHash("sha256")
    .update(
      JSON.stringify([
        sprint.id,
        sprint.startAt,
        sprint.endAt,
        sprint.goal ?? null,
        sprint.assumptions ?? [],
        sprint.reviewCadenceMinutes,
        sprint.pointTarget,
        sprint.state,
        tasks.map((task) => [task.id, task.sprintId, task.version]),
        dependencies.map((task) => [task.id, task.sprintId, task.version]),
      ]),
    )
    .digest("hex");
}

/** Task/sprint hints select relevance; only explicit attempt authority permits repository evidence. */
export function evidenceInScope(
  item: EvidenceItem,
  investigation: Investigation,
  attempt?: InvestigationAttempt,
  plan?: PlanningContext,
): boolean {
  const authority = attempt?.authority;
  if (
    attempt === undefined ||
    authority === undefined ||
    attempt.investigationId !== investigation.id
  )
    return false;
  return evidenceMatchesScope(
    item,
    { ...investigation, repositoryIds: authority.repositoryIds },
    plan,
  );
}

/** Use only a repository set already approved at admission or taken from authenticated authority. */
export function evidenceMatchesScope(
  item: EvidenceItem,
  scope: Pick<Investigation, "sprintId" | "taskId"> & { readonly repositoryIds: readonly string[] },
  plan?: PlanningContext,
): boolean {
  if (item.repositoryId === undefined) {
    if (requiresRepositoryId(item)) return false;
  } else if (!scope.repositoryIds.includes(item.repositoryId)) return false;
  if (plan !== undefined && plan.sprint.id !== scope.sprintId) return false;
  if (item.taskId !== undefined && plan === undefined && scope.taskId === undefined) return false;
  if (item.taskId !== undefined && plan !== undefined)
    return [...plan.tasks, ...plan.dependencies].some(
      (task) =>
        task.id === item.taskId && (item.sprintId === undefined || item.sprintId === task.sprintId),
    );
  if (item.sprintId !== undefined && item.sprintId !== scope.sprintId) return false;
  if (scope.taskId !== undefined && item.taskId !== undefined && item.taskId !== scope.taskId)
    return false;
  return item.repositoryId !== undefined || item.sprintId === scope.sprintId;
}
