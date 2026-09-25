import { z } from "zod";
import {
  AttemptCredentials,
  dedicatedAgentId,
  managedSessionId,
} from "../adapters/openclaw/attemptCredentials.js";
import { INVESTIGATOR_TOOL_NAMES } from "../contracts/investigationTools.js";
import { registerInvestigatorHooks, type InvestigatorHookApi } from "./investigatorHooks.js";
import { RiskApiClient } from "./riskApiClient.js";
import { createRiskTools, type RiskTool } from "./riskTools.js";

export interface RiskPluginApi extends InvestigatorHookApi {
  readonly pluginConfig?: Record<string, unknown>;
  registerTool(
    factory: (context: { agentId?: string; sessionKey?: string }) => RiskTool[] | null,
    options: { names: string[]; optional: true },
  ): void;
}
const configSchema = z
  .object({
    credentialsDirectory: z.string().min(1),
    investigationAgentId: z.string().min(1),
    apiBaseUrl: z.string().default("http://127.0.0.1:4317"),
    timeoutMs: z.number().int().min(100).max(30_000).default(5_000),
    maxResponseBytes: z.number().int().min(1_024).max(2_097_152).default(524_288),
  })
  .strict();

export default {
  id: "development-risk",
  name: "Development Risk",
  description: "Four attempt-scoped tools for local development risk investigations",
  register(api: RiskPluginApi): void {
    const parsed = configSchema.safeParse(api.pluginConfig);
    if (!parsed.success) throw new Error("Invalid development-risk plugin configuration");
    const config = parsed.data;
    const agentId = dedicatedAgentId(config.investigationAgentId);
    const credentials = new AttemptCredentials(config.credentialsDirectory, agentId);
    registerInvestigatorHooks(api, agentId, credentials);
    api.registerTool(
      (context) => {
        const key = context.sessionKey;
        if (
          context.agentId !== agentId ||
          key === undefined ||
          managedSessionId(key, agentId) === undefined
        )
          return null;
        try {
          credentials.load(key);
        } catch {
          return null;
        }
        return createRiskTools((name, input, signal) => {
          // Re-read for every call, so removal and expiry also revoke already-created tool closures.
          let token: string;
          try {
            token = credentials.load(key).token;
          } catch {
            throw new Error("Investigation tool authority unavailable");
          }
          return new RiskApiClient({ ...config, token }).invokeTool(name, input, signal);
        });
      },
      { names: [...INVESTIGATOR_TOOL_NAMES], optional: true },
    );
  },
};
