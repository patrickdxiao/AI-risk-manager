import type { AttemptCredentials } from "../adapters/openclaw/attemptCredentials.js";
import { investigationResultSchema } from "../contracts/investigationResult.js";
import { INVESTIGATOR_TOOL_NAMES } from "../contracts/investigationTools.js";

interface Context {
  readonly agentId?: string;
  readonly sessionKey?: string;
}
export interface InvestigatorHookApi {
  on(
    name: "before_tool_call",
    handler: (
      event: { toolName: string },
      context: Context,
    ) => { block: true; blockReason: string } | undefined,
  ): void;
  on(
    name: "before_agent_finalize",
    handler: (
      event: { sessionId: string; stopHookActive: boolean; lastAssistantMessage?: string },
      context: Context,
    ) =>
      | {
          action: "continue" | "revise";
          reason?: string;
          retry?: { instruction: string; idempotencyKey: string; maxAttempts: number };
        }
      | undefined,
  ): void;
  on(name: "agent_end", handler: (event: unknown, context: Context) => void): void;
}

/** Hooks restrict the dedicated agent; the API independently enforces persisted authority and budget. */
export function registerInvestigatorHooks(
  api: InvestigatorHookApi,
  agentId: string,
  credentials: AttemptCredentials,
): void {
  const calls = new Map<string, { count: number; expiresAt: number }>();
  api.on("before_tool_call", (event, context) => {
    if (context.agentId !== agentId) return;
    const denied = {
      block: true as const,
      blockReason: "Investigation tool authority or budget unavailable",
    };
    try {
      const credential = credentials.load(context.sessionKey ?? "");
      for (const [key, value] of calls) if (value.expiresAt <= Date.now()) calls.delete(key);
      const count = calls.get(credential.sessionKey)?.count ?? 0;
      const name = INVESTIGATOR_TOOL_NAMES.find(
        (name) => event.toolName === name || event.toolName === `openclaw${name}`,
      );
      if (name === undefined || count >= 12) return denied;
      // The pinned Codex relay first checks an OpenClaw-prefixed alias; the real tool runs
      // the same hook with its bare name. Charge that invocation once, then the API charges it.
      if (event.toolName === name)
        calls.set(credential.sessionKey, { count: count + 1, expiresAt: credential.expiresAt });
      return undefined;
    } catch {
      return denied;
    }
  });
  api.on("before_agent_finalize", (event, context) => {
    if (context.agentId !== agentId) return;
    try {
      credentials.load(context.sessionKey ?? "");
    } catch {
      return { action: "continue" };
    }
    let valid = false;
    const text = event.lastAssistantMessage ?? "";
    if (Buffer.byteLength(text) <= 1_048_576) {
      try {
        valid = investigationResultSchema.safeParse(JSON.parse(text) as unknown).success;
      } catch {
        /* One bounded format correction is allowed before natural finalization. */
      }
    }
    if (valid || event.stopHookActive) return { action: "continue" };
    return {
      action: "revise",
      reason: "Return the required version-1 investigation result",
      retry: {
        instruction:
          "Return only valid investigation JSON with stored citations, uncertainty and a next check. Do not call more tools or mutate tasks.",
        idempotencyKey: `risk-finalize:${event.sessionId}`,
        maxAttempts: 1,
      },
    };
  });
  api.on("agent_end", (_event, context) => {
    if (context.agentId === agentId) calls.delete(context.sessionKey ?? "");
  });
}
