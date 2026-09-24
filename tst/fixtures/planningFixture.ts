import type { Sprint, Task } from "../../src/core/planning/planningModel.js";
import {
  PlanningEntityAlreadyExistsError,
  type PlanningStore,
  type TransactionContext,
  type UnitOfWorkPort,
} from "../../src/core/storageContracts.js";

/** Serial, copy-on-commit planning transactions; unrelated ports fail immediately if accessed. */
export function planningFixture(
  seed: { sprints?: readonly Sprint[]; tasks?: readonly Task[] } = {},
) {
  let sprints = new Map(seed.sprints?.map((sprint) => [sprint.id, sprint]));
  let tasks = new Map(seed.tasks?.map((task) => [task.id, task]));
  let previous: Promise<unknown> = Promise.resolve();
  const store: UnitOfWorkPort = {
    execute<T>(work: (context: TransactionContext) => Promise<T>): Promise<T> {
      const run = previous.then(async () => {
        const nextSprints = new Map(sprints);
        const nextTasks = new Map(tasks);
        const planning: PlanningStore = {
          listSprints: () => Promise.resolve([...nextSprints.values()]),
          listTasks: () => Promise.resolve([...nextTasks.values()]),
          countOpenTasks: () =>
            Promise.resolve([...nextTasks.values()].filter((task) => task.state !== "done").length),
          findActiveSprint: () =>
            Promise.resolve([...nextSprints.values()].find((sprint) => sprint.state === "active")),
          findSprintById: (id) => Promise.resolve(nextSprints.get(id)),
          findTaskById: (id) => Promise.resolve(nextTasks.get(id)),
          findTasksBySprintId: (id) =>
            Promise.resolve([...nextTasks.values()].filter((task) => task.sprintId === id)),
          addSprint: (sprint) => {
            if (nextSprints.has(sprint.id))
              throw new PlanningEntityAlreadyExistsError("sprint", sprint.id);
            nextSprints.set(sprint.id, sprint);
            return Promise.resolve();
          },
          addTask: (task) => {
            if (nextTasks.has(task.id)) throw new PlanningEntityAlreadyExistsError("task", task.id);
            nextTasks.set(task.id, task);
            return Promise.resolve();
          },
          saveSprint: (sprint) => {
            nextSprints.set(sprint.id, sprint);
            return Promise.resolve();
          },
          saveTask: (task) => {
            nextTasks.set(task.id, task);
            return Promise.resolve();
          },
        };
        const context = new Proxy({} as TransactionContext, {
          get(_target, key) {
            if (key === "planning") return planning;
            throw new Error(`Unexpected planning dependency: ${String(key)}`);
          },
        });
        const result = await work(context);
        sprints = nextSprints;
        tasks = nextTasks;
        return result;
      });
      previous = run.catch(() => undefined);
      return run;
    },
  };
  return { store, sprints: () => [...sprints.values()], tasks: () => [...tasks.values()] };
}
