import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApplicationError, type ClockPort, type IdGeneratorPort } from "../core/primitives.js";
import { createSprint, type Sprint, type Task } from "../core/planning/planningModel.js";
import { CreateSprint, CreateTask, EditTask } from "../core/planning/planningService.js";
import { GetSprintOverview } from "../core/risk/riskAssessment.js";
import type { UnitOfWorkPort } from "../core/storageContracts.js";
import { RequestReview } from "../core/triggers/requestReview.js";
import {
  defined,
  newSprint,
  newTask,
  params,
  scope,
  sprintSettings,
  taskEdit,
} from "./apiSchemas.js";

export interface PlanningRouteServices {
  readonly store: UnitOfWorkPort;
  readonly ids: IdGeneratorPort;
  readonly clock: ClockPort;
  readonly investigationsEnabled: boolean;
  readonly wakeWorker: () => void;
}

/** Save plans and their explicitly scoped review requests in the same transaction. */
export function registerPlanningRoutes(
  server: FastifyInstance,
  services: PlanningRouteServices,
): void {
  const { store, ids, clock } = services;
  async function save<T extends Sprint | Task>(
    repositories: readonly string[],
    mutate: (tx: UnitOfWorkPort) => Promise<T>,
  ): Promise<T> {
    const saved = await store.execute(async (context) => {
      const tx: UnitOfWorkPort = { execute: (work) => work(context) };
      const result = await mutate(tx);
      if (services.investigationsEnabled)
        await new RequestReview(tx, ids, clock).execute({
          type: "plan_changed",
          sprintId: "sprintId" in result ? result.sprintId : result.id,
          ...("sprintId" in result ? { taskId: result.id } : {}),
          repositoryIds: repositories,
        });
      return result;
    });
    if (services.investigationsEnabled) services.wakeWorker();
    return saved;
  }
  server.get("/api/status", () => ({ investigationsEnabled: services.investigationsEnabled }));
  server.get("/api/sprints", async () => ({
    sprints: await store.execute((tx) => tx.planning.listSprints()),
  }));
  server.post("/api/sprints", async (request, reply) => {
    const { repositoryIds, ...input } = defined(newSprint.parse(request.body));
    const sprint = await save(repositoryIds, (tx) =>
      new CreateSprint(tx, ids, clock).execute(input),
    );
    return reply.code(201).send({ sprint });
  });
  server.patch("/api/sprints/:id", async (request) => {
    const { id } = params.parse(request.params);
    const { repositoryIds, ...patch } = defined(sprintSettings.extend(scope).parse(request.body));
    const sprint = await save(repositoryIds, (tx) =>
      tx.execute(async ({ planning }) => {
        const current = await planning.findSprintById(id);
        if (current === undefined)
          throw new ApplicationError("sprint_not_found", "Sprint does not exist", "id");
        const next = createSprint({ ...current, ...patch });
        await planning.saveSprint(next);
        return next;
      }),
    );
    return { sprint };
  });
  server.get("/api/sprints/:id/overview", (request) =>
    new GetSprintOverview(store, clock).execute(params.parse(request.params).id),
  );
  server.post("/api/tasks", async (request, reply) => {
    const { repositoryIds, ...input } = defined(newTask.parse(request.body));
    const task = await save(repositoryIds, (tx) => new CreateTask(tx, ids, clock).execute(input));
    return reply.code(201).send({ task });
  });
  server.patch("/api/tasks/:id", async (request) => {
    const { id: taskId } = params.parse(request.params);
    const { repositoryIds, ...input } = defined(taskEdit.parse(request.body));
    return {
      task: await save(repositoryIds, (tx) =>
        new EditTask(tx, clock).execute({ ...input, taskId }),
      ),
    };
  });
  server.get("/api/tasks", async (request) => {
    z.object({ view: z.literal("archive") })
      .strict()
      .parse(request.query);
    return {
      tasks: await store.execute(async ({ planning }) => {
        const archived: Task[] = [];
        for (const sprint of await planning.listSprints()) {
          if (sprint.state !== "completed" && Date.parse(sprint.endAt) > Date.parse(clock.now()))
            continue;
          for (const task of await planning.findTasksBySprintId(sprint.id))
            if (task.state === "done") archived.push(task);
        }
        return archived.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 1_000);
      }),
    };
  });
}
