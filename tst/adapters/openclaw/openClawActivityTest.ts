import { describe, expect, it, vi } from "vitest";
import { OpenClawActivityAdapter } from "../../../src/adapters/openclaw/openClawActivity.js";
import type { OpenClawRunner } from "../../../src/adapters/openclaw/openClawCli.js";

describe("OpenClaw activity metadata", () => {
  it("uses explicit outcomes while giving current live activity precedence", async () => {
    const adapter = new OpenClawActivityAdapter(() =>
      Promise.resolve(
        JSON.stringify({
          sessions: [
            { key: "agent:a:one", status: "done", hasActiveRun: true },
            { key: "agent:a:two", status: "done", parentSessionKey: "agent:a:one" },
            { key: "agent:a:three", status: "failed" },
            { key: "agent:a:four", status: "timeout" },
            { key: "agent:a:five", status: "killed" },
            { key: "agent:a:six", status: "running" },
          ],
        }),
      ),
    );
    const result = await adapter.list();
    expect(result.sessions.map((s) => s.state)).toEqual([
      "running",
      "completed",
      "failed",
      "failed",
      "stopped",
      "unknown",
    ]);
    expect(result.sessions[1]?.kind).toBe("subagent");
  });
  it("reads bounded metadata, hides internal reviews, and does not infer liveness from recency", async () => {
    const runner = vi.fn<OpenClawRunner>().mockResolvedValue(
      JSON.stringify({
        sessions: [
          { key: "agent:dev:risk:internal", hasActiveRun: true },
          {
            key: "agent:dev:main",
            updatedAt: 900,
            label: "Checkout",
            hasActiveRun: false,
            lastMessage: "private",
          },
          {
            key: "agent:dev:subagent:tests",
            updatedAt: 800,
            displayName: "Test checkout",
            hasActiveRun: true,
            spawnedBy: "agent:dev:main",
            model: "test-model",
            totalTokens: 1234,
            totalTokensFresh: true,
          },
          { key: "agent:qa:main", updatedAt: 1000 },
          { key: "agent:ops:main", abortedLastRun: true },
        ],
      }),
    );
    const adapter = new OpenClawActivityAdapter(runner);
    const result = await adapter.list();
    expect(result.status).toBe("connected");
    expect(result.sessions.map((s) => s.state)).toEqual(["running", "unknown", "idle", "stopped"]);
    expect(result.sessions[0]).toMatchObject({
      agentId: "dev",
      kind: "subagent",
      label: "Test checkout",
      parentSessionKey: "agent:dev:main",
      model: "test-model",
      contextTokens: 1234,
    });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(JSON.stringify(result)).not.toContain("internal");
    const args = runner.mock.calls[0]?.[1] ?? [];
    expect(args.slice(0, 3)).toEqual(["gateway", "call", "sessions.list"]);
    expect(JSON.parse(args.at(-1) ?? "")).toEqual({
      limit: 30,
      includeGlobal: false,
      includeUnknown: false,
      includeDerivedTitles: false,
      includeLastMessage: false,
    });
    expect(runner.mock.calls[0]?.[2]).toEqual({ timeoutMs: 6000, maxOutputBytes: 262144 });
  });

  it.each([false, undefined])("omits stale or unknown token snapshots (%s)", async (fresh) => {
    const adapter = new OpenClawActivityAdapter(() =>
      Promise.resolve(
        JSON.stringify({
          sessions: [{ key: "agent:dev:main", totalTokens: 1234, totalTokensFresh: fresh }],
        }),
      ),
    );
    expect((await adapter.list()).sessions[0]).not.toHaveProperty("contextTokens");
  });

  it("coalesces polls and caches failures briefly, then recovers without exposing errors", async () => {
    let now = 0;
    const runner = vi
      .fn<OpenClawRunner>()
      .mockRejectedValueOnce(new Error("private credential"))
      .mockResolvedValue(JSON.stringify({ sessions: [] }));
    const adapter = new OpenClawActivityAdapter(runner, () => now);
    const results = await Promise.all([adapter.list(), adapter.list()]);
    expect(results).toEqual(Array(2).fill({ status: "unavailable", sessions: [] }));
    expect(runner).toHaveBeenCalledTimes(1);
    now = 15000;
    expect(await adapter.list()).toEqual({ status: "connected", sessions: [] });
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it.each([
    "not json",
    "{}",
    JSON.stringify({ sessions: [{ key: "x", hasActiveRun: "yes" }] }),
    "x".repeat(262145),
  ])("rejects malformed or oversized responses", async (output) => {
    const adapter = new OpenClawActivityAdapter(() => Promise.resolve(output));
    expect(await adapter.list()).toEqual({ status: "unavailable", sessions: [] });
  });
});
