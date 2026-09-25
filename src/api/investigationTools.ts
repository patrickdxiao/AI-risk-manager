import type { FastifyInstance, FastifyRequest } from "fastify";
import type { z } from "zod";
import { investigationToolSchemas } from "../contracts/investigationTools.js";
import { authorizeAttempt } from "../core/investigation/attemptAuthority.js";
import { evidenceInScope, selectPlanningContext } from "../core/investigation/evidenceScope.js";
import {
  GetInvestigationContext,
  GetInvestigationEvidence,
} from "../core/investigation/investigationLifecycle.js";
import { ApplicationError, type ClockPort } from "../core/primitives.js";
import type { EvidenceItem } from "../core/evidence/evidenceModel.js";
import type { ReconcileRepositoryResult } from "../core/repository/repositoryCapture.js";
import type { TransactionContext, UnitOfWorkPort } from "../core/storageContracts.js";

/** Four read tools: every authenticated invocation consumes one durable call, even on failure. */
export function registerInvestigationTools(
  server: FastifyInstance,
  services: {
    readonly store: UnitOfWorkPort;
    readonly clock: ClockPort;
    readonly capture: (input: { repositoryId: string }) => Promise<ReconcileRepositoryResult>;
  },
): void {
  const { store, clock } = services;
  const token = (request: FastifyRequest) =>
    request.headers.authorization?.slice("Bearer ".length) ?? "";
  async function input<T>(schema: z.ZodType<T>, request: FastifyRequest): Promise<T> {
    const parsed = schema.safeParse(request.body);
    if (parsed.success) return parsed.data;
    await store.execute((tx) => authorizeAttempt(tx, token(request), clock.now()));
    throw parsed.error;
  }
  async function read<T>(
    credential: string,
    consumeCall: boolean,
    operation: (
      tx: TransactionContext,
      owned: Awaited<ReturnType<typeof authorizeAttempt>>,
    ) => Promise<T> | T,
  ): Promise<T> {
    const outcome = await store.execute(async (tx) => {
      const owned = await authorizeAttempt(tx, credential, clock.now(), consumeCall);
      try {
        return { ok: true as const, value: await operation(tx, owned) };
      } catch (error: unknown) {
        return { ok: false as const, error };
      }
    });
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }
  server.post("/api/investigation-tools/risk_get_context", async (request) => {
    await input(investigationToolSchemas.risk_get_context, request);
    return { context: await new GetInvestigationContext(store, clock).execute(token(request)) };
  });
  server.post("/api/investigation-tools/risk_get_evidence", async (request) => {
    const { evidenceIds } = await input(investigationToolSchemas.risk_get_evidence, request);
    return {
      evidence: await new GetInvestigationEvidence(store, clock).execute(
        token(request),
        evidenceIds,
      ),
    };
  });
  server.post("/api/investigation-tools/risk_list_evidence", async (request) => {
    const { repositoryId, limit } = await input(
      investigationToolSchemas.risk_list_evidence,
      request,
    );
    return read(token(request), true, async (tx, { investigation, attempt }) => {
      if (repositoryId !== undefined && !attempt.authority.repositoryIds.includes(repositoryId))
        throw denied();
      const plan = await selectPlanningContext(tx, investigation);
      const queries =
        repositoryId === undefined
          ? [
              { sprintId: investigation.sprintId, limit: limit + 1 },
              ...attempt.authority.repositoryIds.map((id) => ({
                repositoryId: id,
                limit: limit + 1,
              })),
              ...plan.dependencies
                .slice(0, 100)
                .map((task) => ({ taskId: task.id, limit: limit + 1 })),
            ]
          : [{ repositoryId, limit: limit + 1 }];
      const records = new Map<string, EvidenceItem>();
      let truncated = repositoryId === undefined && plan.dependencies.length > 100;
      for (const query of queries) {
        const values = await tx.evidence.findScoped(query);
        truncated ||= values.length > limit;
        for (const item of values)
          if (evidenceInScope(item, investigation, attempt, plan)) records.set(item.id, item);
      }
      const ordered = [...records.values()].sort(
        (a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id),
      );
      return { evidence: ordered.slice(0, limit), truncated: truncated || ordered.length > limit };
    });
  });
  server.post("/api/investigation-tools/risk_inspect_git", async (request) => {
    const { repositoryId } = await input(investigationToolSchemas.risk_inspect_git, request);
    const credential = token(request);
    await read(credential, true, (_tx, { attempt }) => {
      if (!attempt.authority.repositoryIds.includes(repositoryId)) throw denied();
    });
    // External filesystem reads never hold the write transaction. Failed captures still cost a call.
    const captured = await services.capture({ repositoryId });
    return read(credential, false, async (tx, { investigation, attempt }) => {
      const plan = await selectPlanningContext(tx, investigation);
      if (
        !attempt.authority.repositoryIds.includes(repositoryId) ||
        captured.evidence.some((item) => !evidenceInScope(item, investigation, attempt, plan))
      )
        throw denied();
      return captured;
    });
  });
}

function denied(): ApplicationError {
  return new ApplicationError(
    "evidence_scope_mismatch",
    "Repository is outside the attempt scope",
    "repositoryId",
  );
}
