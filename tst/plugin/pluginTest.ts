import { afterEach, describe, expect, it, vi } from "vitest";
import plugin, { type RiskPluginApi } from "../../src/plugin/index.js";
import { AttemptCredentials } from "../../src/adapters/openclaw/attemptCredentials.js";
import { createRiskTools } from "../../src/plugin/riskTools.js";
import { INVESTIGATOR_TOOL_NAMES } from "../../src/contracts/investigationTools.js";
import { investigationResultSchema } from "../../src/contracts/investigationResult.js";
import { agentId, answer, openClawFixture } from "../fixtures/openClawFixture.js";
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});
function setup() {
  const f = openClawFixture();
  cleanups.push(f.cleanup);
  const store = new AttemptCredentials(f.directory, agentId);
  const remove = store.save(f.credential);
  const hooks = new Map<string, (...args: unknown[]) => unknown>();
  let factory: Parameters<RiskPluginApi["registerTool"]>[0] | undefined;
  const registerTool: RiskPluginApi["registerTool"] = (value, options) => {
    factory = value;
    expect(options).toEqual({ names: INVESTIGATOR_TOOL_NAMES, optional: true });
  };
  const api: RiskPluginApi = {
    pluginConfig: { credentialsDirectory: f.directory, investigationAgentId: agentId },
    registerTool,
    on: ((name: string, handler: (...args: unknown[]) => unknown) => {
      hooks.set(name, handler);
    }) as RiskPluginApi["on"],
  };
  plugin.register(api);
  return {
    ...f,
    api,
    store,
    remove,
    hooks,
    context: { agentId, sessionKey: f.credential.sessionKey },
    tools: (context: Parameters<NonNullable<typeof factory>>[0]) => factory?.(context),
  };
}
describe("four-tool OpenClaw plugin", () => {
  it("registers only managed sessions, injects credentials outside model arguments and revokes created closures", async () => {
    const f = setup();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"context":{}}'));
    vi.stubGlobal("fetch", fetcher);
    expect(f.tools({ agentId: "other", sessionKey: f.credential.sessionKey })).toBeNull();
    expect(f.tools({ agentId })).toBeNull();
    expect(f.tools({ agentId, sessionKey: `agent:${agentId}:main` })).toBeNull();
    const tools = f.tools(f.context);
    expect(tools?.map((tool) => tool.name)).toEqual(INVESTIGATOR_TOOL_NAMES);
    const tool = tools?.find((tool) => tool.name === "risk_get_context");
    expect(await tool?.execute("call", {})).toEqual({
      content: [{ type: "text", text: '{"context":{}}' }],
      details: { context: {} },
    });
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: `Bearer ${f.input.attemptToken}`,
    });
    expect(JSON.stringify(tools)).not.toContain(f.input.attemptToken);
    f.remove();
    expect(f.tools(f.context)).toBeNull();
    await expect(tool?.execute("late", {})).rejects.toThrow("authority unavailable");
  });
  it("validates strict bounded arguments before transport and propagates abort signals", async () => {
    const invoke = vi.fn(() => Promise.resolve({ evidence: [] }));
    const tools = createRiskTools(invoke);
    for (const [name, input] of [
      ["risk_get_context", { token: "injected" }],
      ["risk_get_evidence", { evidenceIds: [] }],
      ["risk_list_evidence", { limit: 51 }],
      ["risk_inspect_git", { repositoryId: " " }],
    ] as const)
      await expect(
        tools.find((tool) => tool.name === name)?.execute("call", input),
      ).rejects.toThrow("Invalid investigation tool arguments");
    expect(invoke).not.toHaveBeenCalled();
    const signal = new AbortController().signal;
    await tools.find((tool) => tool.name === "risk_list_evidence")?.execute("call", {}, signal);
    expect(invoke).toHaveBeenCalledWith("risk_list_evidence", { limit: 20 }, signal);
  });
  it("blocks unrelated tools, missing credentials and the thirteenth managed tool call, without changing other agents", () => {
    const f = setup();
    const call = f.hooks.get("before_tool_call");
    expect(call?.({ toolName: "exec" }, { agentId: "other" })).toBeUndefined();
    expect(call?.({ toolName: "exec" }, f.context)).toMatchObject({ block: true });
    expect(call?.({ toolName: "risk_get_context" }, { agentId })).toMatchObject({ block: true });
    for (let count = 0; count < 12; count++)
      expect(call?.({ toolName: "risk_get_context" }, f.context)).toBeUndefined();
    expect(call?.({ toolName: "risk_get_context" }, f.context)).toMatchObject({ block: true });
    f.hooks.get("agent_end")?.({}, { agentId: "other" });
    expect(call?.({ toolName: "risk_get_context" }, f.context)).toMatchObject({ block: true });
    f.hooks.get("agent_end")?.({}, f.context);
    expect(call?.({ toolName: "risk_get_context" }, f.context)).toBeUndefined();
    f.remove();
    expect(call?.({ toolName: "risk_get_context" }, f.context)).toMatchObject({ block: true });
  });
  it("allows at most one natural-finalization correction and never extends expired authority", () => {
    const f = setup();
    const finalize = f.hooks.get("before_agent_finalize");
    const event = { sessionId: "session", stopHookActive: false, lastAssistantMessage: "bad" };
    expect(finalize?.(event, { agentId: "other" })).toBeUndefined();
    expect(finalize?.(event, f.context)).toMatchObject({
      action: "revise",
      retry: { maxAttempts: 1 },
    });
    expect(finalize?.({ ...event, stopHookActive: true }, f.context)).toEqual({
      action: "continue",
    });
    expect(
      finalize?.({ ...event, lastAssistantMessage: JSON.stringify(answer) }, f.context),
    ).toEqual({ action: "continue" });
    expect(
      finalize?.({ ...event, lastAssistantMessage: "x".repeat(1_048_577) }, f.context),
    ).toMatchObject({ action: "revise" });
    f.remove();
    expect(finalize?.(event, f.context)).toEqual({ action: "continue" });
  });
  it("permits only exact Codex relay aliases without double-charging the real tool call", () => {
    const f = setup();
    const call = f.hooks.get("before_tool_call");
    for (const name of ["openclawexec", "openclawrisk_get_context_extra", "otherrisk_get_context"])
      expect(call?.({ toolName: name }, f.context)).toMatchObject({ block: true });
    for (let round = 0; round < 3; round++)
      for (const name of INVESTIGATOR_TOOL_NAMES) {
        expect(call?.({ toolName: `openclaw${name}` }, f.context)).toBeUndefined();
        expect(call?.({ toolName: name }, f.context)).toBeUndefined();
      }
    expect(call?.({ toolName: "openclawrisk_get_context" }, f.context)).toMatchObject({
      block: true,
    });
    f.hooks.get("agent_end")?.({}, f.context);
    f.remove();
    expect(call?.({ toolName: "openclawrisk_get_context" }, f.context)).toMatchObject({
      block: true,
    });
  });
  it("rejects unsupported result mutations and missing risk support before finalization", () => {
    expect(investigationResultSchema.safeParse(answer).success).toBe(true);
    for (const value of [
      { ...answer, completedTasks: [] },
      { ...answer, projectId: "project" },
      { ...answer, findings: [{ ...answer.findings[0], state: "blocked" }] },
      { ...answer, findings: [{ ...answer.findings[0], nextCheckCondition: undefined }] },
      { ...answer, findings: [{ ...answer.findings[0], uncertainty: undefined }] },
      {
        ...answer,
        findings: [
          {
            ...answer.findings[0],
            evidenceCitations: [{ evidenceId: "one" }, { evidenceId: "one" }],
          },
        ],
      },
    ])
      expect(investigationResultSchema.safeParse(value).success).toBe(false);
    const f = setup();
    expect(() => {
      plugin.register({ ...f.api, pluginConfig: { token: "global-secret" } });
    }).toThrow("Invalid development-risk plugin configuration");
  });
});
