import { afterEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  OpenClawCliAdapter,
  systemOpenClawRunner,
  type OpenClawRunner,
} from "../../../src/adapters/openclaw/openClawCli.js";
import { agentId, answer, inventory, openClawFixture } from "../../fixtures/openClawFixture.js";
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function setup(change?: (method: string, value: Record<string, unknown>) => unknown) {
  const f = openClawFixture();
  cleanups.push(f.cleanup);
  const runner = vi.fn<OpenClawRunner>((_executable, argv) => {
    if (argv[0] === "--version") return Promise.resolve("OpenClaw 2026.7.1-2 (fixture)");
    const params = JSON.parse(argv[argv.indexOf("--params") + 1] ?? "{}") as Record<
      string,
      unknown
    >;
    const method = argv[2] ?? "";
    let result: Record<string, unknown>;
    if (method === "sessions.create")
      result = { ok: true, key: params["key"], sessionId: "session", runStarted: false };
    else if (method === "tools.effective") result = inventory();
    else if (method === "agent")
      result = {
        runId: params["idempotencyKey"],
        status: "ok",
        result: {
          payloads: [{ text: JSON.stringify(answer) }],
          meta: {
            durationMs: 17,
            agentMeta: {
              sessionId: "session",
              provider: "scripted",
              model: "fixture",
              usage: { input: 10, output: 20, total: 35 },
            },
          },
        },
      };
    else result = { ok: true };
    return Promise.resolve(JSON.stringify(change?.(method, result) ?? result));
  });
  return {
    ...f,
    runner,
    adapter: new OpenClawCliAdapter({
      investigationAgentId: agentId,
      credentialsDirectory: f.directory,
      runner,
    }),
  };
}
describe("pinned OpenClaw Gateway adapter", () => {
  it("checks the exact effective policy, binds fresh sessions, preserves telemetry and keeps credentials out of prompts", async () => {
    const f = setup((method, value) => {
      if (method === "agent") {
        const saved = JSON.parse(
          readFileSync(join(f.directory, readdirSync(f.directory)[0] ?? ""), "utf8"),
        ) as { token: string };
        expect(saved.token).toBe(f.input.attemptToken);
      }
      return value;
    });
    const first = await f.adapter.runInvestigation(f.input);
    const second = await f.adapter.runInvestigation(f.input);
    expect(first.sessionKey).not.toBe(second.sessionKey);
    expect(first).toMatchObject({
      structuredResult: answer,
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 35 },
      latencyMs: 17,
      runtimeVersion: "2026.7.1-2",
    });
    expect(first.usage).not.toHaveProperty("estimatedCostUsd");
    expect(JSON.stringify(f.runner.mock.calls)).not.toContain(f.input.attemptToken);
    expect(f.runner.mock.calls[3]?.[1]).toContain("--expect-final");
    expect(readdirSync(f.directory)).toEqual([]);
  });
  it("fails closed before model work if the policy, session or version cannot be verified", async () => {
    for (const change of [
      (method: string, value: Record<string, unknown>) =>
        method === "sessions.create" ? { ...value, runStarted: true } : value,
      (method: string, value: Record<string, unknown>) =>
        method === "sessions.create" ? { ...value, key: "wrong" } : value,
      (method: string, value: Record<string, unknown>) =>
        method === "tools.effective" ? { agentId, groups: [] } : value,
    ]) {
      const f = setup(change);
      await expect(f.adapter.runInvestigation(f.input)).rejects.toMatchObject({ retryable: false });
      expect(f.runner.mock.calls.some((call) => call[1][2] === "agent")).toBe(false);
      expect(readdirSync(f.directory)).toEqual([]);
    }
    const f = setup();
    f.runner.mockResolvedValueOnce("OpenClaw 2026.9.1");
    await expect(f.adapter.runInvestigation(f.input)).rejects.toMatchObject({ retryable: false });
    expect(f.runner).toHaveBeenCalledTimes(1);
  });
  it("cleans up and requests best-effort abort after failed, oversized or mismatched runs", async () => {
    for (const response of [
      "invalid JSON",
      "x".repeat(2_097_153),
      JSON.stringify({ status: "error" }),
    ]) {
      const f = setup();
      const original = f.runner.getMockImplementation();
      f.runner.mockImplementation(async (...args) =>
        args[1][2] === "agent" ? response : ((await original?.(...args)) ?? ""),
      );
      await expect(f.adapter.runInvestigation(f.input)).rejects.toMatchObject({ retryable: false });
      expect(f.runner.mock.calls.at(-1)?.[1][2]).toBe("chat.abort");
      expect(readdirSync(f.directory)).toEqual([]);
    }
    const f = setup((method, value) => (method === "agent" ? { ...value, runId: "other" } : value));
    await expect(f.adapter.runInvestigation(f.input)).rejects.toMatchObject({ retryable: false });
  });
  it("retains usage when final answer format is invalid and does not invent absent counters", async () => {
    const f = setup((method, value) =>
      method === "agent"
        ? {
            ...value,
            result: {
              payloads: [{ text: "not valid JSON" }],
              meta: { agentMeta: { sessionId: "session", usage: { output: 12 } } },
            },
          }
        : value,
    );
    const result = await f.adapter.runInvestigation(f.input);
    expect(result.structuredResult).toBeUndefined();
    expect(result.usage).toEqual({ outputTokens: 12 });
    const g = setup((method, value) =>
      method === "agent"
        ? {
            ...value,
            result: {
              payloads: [{ text: JSON.stringify(answer) }],
              meta: { agentMeta: { sessionId: "session" } },
            },
          }
        : value,
    );
    expect((await g.adapter.runInvestigation(g.input)).usage).toBeUndefined();
  });
  it("snapshots invocation data and cancels before starting, with failures containing no provider details", async () => {
    const f = setup();
    const input = { ...f.input };
    const pending = f.adapter.runInvestigation(input);
    input.attemptToken = "changed";
    input.prompt = "changed";
    await pending;
    expect(f.runner.mock.calls[3]?.[1].join()).not.toContain("changed");
    const controller = new AbortController();
    controller.abort();
    const calls = f.runner.mock.calls.length;
    await expect(
      f.adapter.runInvestigation({ ...f.input, signal: controller.signal }),
    ).rejects.toThrow("Investigation runtime failed");
    expect(f.runner).toHaveBeenCalledTimes(calls);
    for (const timeoutMs of [0, 600_001, NaN])
      await expect(f.adapter.runInvestigation({ ...f.input, timeoutMs })).rejects.toThrow();
    await expect(
      f.adapter.runInvestigation({ ...f.input, prompt: f.input.attemptToken }),
    ).rejects.toThrow();
    f.runner.mockRejectedValue(new Error("secret provider detail"));
    await expect(f.adapter.runInvestigation(f.input)).rejects.toThrow(
      "Investigation runtime failed",
    );
  });
  it("revokes credentials and aborts the remote run when cancelled during execution", async () => {
    const f = setup();
    const original = f.runner.getMockImplementation();
    const controller = new AbortController();
    f.runner.mockImplementation(async (...args) => {
      if (args[1][2] !== "agent") return (await original?.(...args)) ?? "";
      controller.abort();
      throw new Error("cancelled transport");
    });
    await expect(
      f.adapter.runInvestigation({ ...f.input, signal: controller.signal }),
    ).rejects.toThrow("Investigation runtime failed");
    expect(readdirSync(f.directory)).toEqual([]);
    expect(f.runner.mock.calls.at(-1)?.[1][2]).toBe("chat.abort");
    expect(f.runner.mock.calls.at(-1)?.[2].signal).toBeUndefined();
  });

  it("bounds a launcher whose child inherits the output pipe and rejects already-aborted work", async () => {
    const started = performance.now();
    await expect(
      systemOpenClawRunner(
        process.execPath,
        [
          "-e",
          "require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',process.stdout,process.stderr]});setInterval(()=>{},1000)",
        ],
        { timeoutMs: 80, maxOutputBytes: 1024 },
      ),
    ).rejects.toThrow();
    expect(performance.now() - started).toBeLessThan(2000);
    const controller = new AbortController();
    controller.abort();
    await expect(
      systemOpenClawRunner(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
        timeoutMs: 1000,
        maxOutputBytes: 1024,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });

  it("runs real child processes without a shell and bounds bytes, exit failures, timeout and cancellation", async () => {
    const options = { timeoutMs: 1_000, maxOutputBytes: 1_024 };
    expect(
      await systemOpenClawRunner(
        process.execPath,
        ["-e", "process.stdout.write(process.argv[1])", "$(touch never)"],
        options,
      ),
    ).toBe("$(touch never)");
    await expect(
      systemOpenClawRunner(
        process.execPath,
        ["-e", "process.stdout.write('x'.repeat(2048))"],
        options,
      ),
    ).rejects.toMatchObject({ code: "invalid_runtime_result", retryable: false });
    await expect(
      systemOpenClawRunner(process.execPath, ["-e", "process.exit(2)"], options),
    ).rejects.toMatchObject({ code: "runtime_unavailable" });
    await expect(
      systemOpenClawRunner(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
        ...options,
        timeoutMs: 30,
      }),
    ).rejects.toThrow();
    const controller = new AbortController();
    const running = systemOpenClawRunner(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      ...options,
      signal: controller.signal,
    });
    controller.abort();
    await expect(running).rejects.toThrow();
  });
});
