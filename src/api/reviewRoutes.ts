import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { createEvidenceItem } from "../core/evidence/evidenceModel.js";
import {
  CancelInvestigationAttempt,
  ListSprintInvestigations,
} from "../core/investigation/investigationLifecycle.js";
import { ApplicationError, DomainInvariantError } from "../core/primitives.js";
import type { Repository } from "../core/repository/repositoryModel.js";
import type { ReconcileRepositoryResult } from "../core/repository/repositoryCapture.js";
import { SubmitFindingFeedback } from "../core/risk/submitFindingFeedback.js";
import { EvaluateStoredTriggers } from "../core/triggers/storedTriggerEvaluation.js";
import { RequestReview } from "../core/triggers/requestReview.js";
import { defined, id, params, repositoryIds, text } from "./apiSchemas.js";
import type { PlanningRouteServices } from "./planningRoutes.js";

export interface ReviewRouteServices extends PlanningRouteServices {
  readonly registerRepository: (input: {
    path: string;
    approvedRoot?: string;
  }) => Promise<Repository>;
  readonly discoverRepositories: (input: {
    roots: readonly string[];
    exclusions?: readonly string[];
  }) => Promise<{
    readonly repositories: readonly Repository[];
    readonly incomplete: boolean;
    readonly issues: readonly string[];
  }>;
  readonly reconcile: (input: { repositoryId: string }) => Promise<ReconcileRepositoryResult>;
}
const path = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => !value.includes("\0"));
const review = z
  .object({
    sprintId: id,
    taskId: id.optional(),
    repositoryIds,
    requestId: id,
    resync: z.boolean().default(false),
  })
  .strict();
const answer = z.object({ answer: text, requestId: id, repositoryIds }).strict();
const feedback = z
  .object({
    id,
    kind: z.enum(["confirm", "dismiss", "resolve", "correct"]),
    note: text.max(4_000).optional(),
    correction: z.object({ statement: text }).strict().optional(),
  })
  .strict();

/** Local-user endpoints; attempt credentials are never accepted here. */
export function registerReviewRoutes(server: FastifyInstance, services: ReviewRouteServices): void {
  const { store, ids, clock } = services;
  function available(reply: FastifyReply): boolean {
    if (services.investigationsEnabled) return true;
    void reply.code(503).send({
      error: {
        code: "review_unavailable",
        message: "Configure a dedicated OpenClaw investigator to enable reviews",
      },
    });
    return false;
  }
  server.get("/api/repositories", async () => ({
    repositories: await store.execute((tx) => tx.repositories.list()),
  }));
  server.post("/api/repositories", async (request, reply) => {
    const input = defined(
      z.object({ path, approvedRoot: path.optional() }).strict().parse(request.body),
    );
    return reply.code(201).send({ repository: await services.registerRepository(input) });
  });
  server.post("/api/repositories/discover", (request) =>
    services.discoverRepositories(
      defined(
        z
          .object({
            roots: z.array(path).min(1).max(8),
            exclusions: z.array(z.string().min(1).max(255)).max(100).optional(),
          })
          .strict()
          .parse(request.body),
      ),
    ),
  );
  server.post("/api/repositories/:id/reconcile", async (request) => {
    const repositoryId = params.parse(request.params).id;
    z.object({})
      .strict()
      .parse(request.body ?? {});
    return services.reconcile({ repositoryId });
  });
  server.post("/api/reviews", async (request, reply) => {
    if (!available(reply)) return reply;
    const { resync, ...input } = defined(review.parse(request.body));
    if (resync)
      for (const repositoryId of input.repositoryIds) await services.reconcile({ repositoryId });
    const queued = await new RequestReview(store, ids, clock).execute({
      type: "manual_review",
      ...input,
    });
    services.wakeWorker();
    return reply.code(202).send(queued);
  });
  server.post("/api/reviews/due", async (request, reply) => {
    if (!available(reply)) return reply;
    const input = z.object({ repositoryIds }).strict().parse(request.body);
    const result = await new EvaluateStoredTriggers(store, ids, clock).execute({
      ...input,
      cooldownMinutes: 15,
    });
    services.wakeWorker();
    return result;
  });
  server.get("/api/sprints/:id/investigations", async (request) => {
    const sprintId = params.parse(request.params).id;
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(20).default(20) })
      .strict()
      .parse(request.query);
    const history = await new ListSprintInvestigations(store, clock).execute(sprintId, limit);
    const pending = await store.execute(async (tx) => {
      const requests = await tx.triggerQueue.listPendingBySprintId(sprintId, 100);
      return Promise.all(
        requests.map(async (trigger) => {
          const dispatch = await tx.triggerDispatches.findByTriggerId(trigger.id);
          if (dispatch === undefined) throw new Error("Saved review has no dispatch");
          return { trigger, dispatch };
        }),
      );
    });
    return { ...history, pending };
  });
  server.get("/api/investigations/:id", async (request) => {
    const id = params.parse(request.params).id;
    return store.execute(async (tx) => {
      const investigation = await tx.investigations.findById(id);
      if (investigation === undefined)
        throw new ApplicationError("investigation_not_found", "Review does not exist", "id");
      return {
        investigation,
        attempts: await tx.investigations.findAttempts(id),
        receipt: await tx.investigations.findSubmittedResult(id),
      };
    });
  });
  server.post("/api/investigations/:id/cancel", async (request, reply) => {
    const investigationId = params.parse(request.params).id;
    const input = defined(
      z
        .object({ executionAttemptId: id.optional() })
        .strict()
        .parse(request.body ?? {}),
    );
    await new CancelInvestigationAttempt(store, clock).execute({ investigationId, ...input });
    return reply.code(204).send();
  });
  server.get("/api/evidence/:id", async (request) => {
    const id = params.parse(request.params).id;
    return store.execute(async (tx) => {
      const evidence = await tx.evidence.findById(id);
      if (evidence === undefined)
        throw new ApplicationError("evidence_not_found", "Evidence does not exist", "id");
      return { evidence };
    });
  });
  server.post("/api/findings/:id/feedback", (request) =>
    new SubmitFindingFeedback(store, ids, clock).execute({
      ...defined(feedback.parse(request.body)),
      findingId: params.parse(request.params).id,
      actor: "user",
      source: "dashboard",
    }),
  );
  server.get("/api/findings/:id/feedback", async (request) => ({
    feedback: await store.execute((tx) =>
      tx.findingFeedback.findByFindingId(params.parse(request.params).id, 50),
    ),
  }));
  server.post("/api/investigations/:id/answer", async (request, reply) => {
    if (!available(reply)) return reply;
    const investigationId = params.parse(request.params).id;
    const input = answer.parse(request.body);
    const queued = await store.execute(async (context) => {
      const receipt = await context.investigations.findSubmittedResult(investigationId);
      if (receipt?.question === undefined)
        throw new DomainInvariantError(
          "invalid_value",
          "This review has no saved question",
          "investigationId",
        );
      const digest = hash(JSON.stringify([receipt.question.id, input.answer]));
      const evidenceId = `answer:${digest}`;
      const existing = await context.evidence.findById(evidenceId);
      if (existing === undefined)
        await context.evidence.add(
          createEvidenceItem({
            id: evidenceId,
            eventId: ids.next(),
            sprintId: receipt.investigation.sprintId,
            ...(receipt.question.taskId === undefined ? {} : { taskId: receipt.question.taskId }),
            source: "user",
            kind: "runtime_status",
            occurredAt: clock.now(),
            locator: receipt.question.id,
            summary: input.answer,
            digest,
            privacyMode: "metadata_only",
            metadata: { question: receipt.question.question },
          }),
        );
      return new RequestReview({ execute: (work) => work(context) }, ids, clock).execute({
        type: "manual_review",
        requestId: `answer:${hash(JSON.stringify([receipt.question.id, input.requestId]))}`,
        evidenceIds: [evidenceId],
        sprintId: receipt.investigation.sprintId,
        ...(receipt.question.taskId === undefined ? {} : { taskId: receipt.question.taskId }),
        repositoryIds: input.repositoryIds,
      });
    });
    services.wakeWorker();
    return reply.code(202).send(queued);
  });
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
