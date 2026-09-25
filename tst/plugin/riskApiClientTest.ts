import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RiskApiClient, type RiskApiClientOptions } from "../../src/plugin/riskApiClient.js";
import type { InvestigationToolName } from "../../src/contracts/investigationTools.js";
import { newAttemptToken } from "../../src/core/investigation/attemptAuthority.js";
const options: RiskApiClientOptions = {
  apiBaseUrl: "http://127.0.0.1:4317",
  token: newAttemptToken("fixture", "fixture"),
  timeoutMs: 100,
  maxResponseBytes: 1_024,
};
afterEach(() => vi.restoreAllMocks());
describe("loopback risk tool client", () => {
  it("sends direct arguments and per-attempt bearer credentials to a real local HTTP endpoint", async () => {
    const observed: unknown[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        observed.push({
          path: req.url,
          authorization: req.headers.authorization,
          body: JSON.parse(Buffer.concat(chunks).toString()) as unknown,
        });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ evidence: [] }));
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (typeof address !== "object" || address === null) throw new Error("No port");
      const client = new RiskApiClient({
        ...options,
        timeoutMs: 2_000,
        apiBaseUrl: `http://127.0.0.1:${String(address.port)}`,
      });
      expect(await client.invokeTool("risk_get_evidence", { evidenceIds: ["stored"] })).toEqual({
        evidence: [],
      });
      expect(observed).toEqual([
        {
          path: "/api/investigation-tools/risk_get_evidence",
          authorization: `Bearer ${options.token}`,
          body: { evidenceIds: ["stored"] },
        },
      ]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  });
  it("rejects other origins, URL credentials, malformed token and unbounded configuration", () => {
    for (const apiBaseUrl of [
      "https://127.0.0.1",
      "http://localhost",
      "http://127.0.0.1.evil.test",
      "http://user@127.0.0.1",
      "http://127.0.0.1/path",
      "http://127.0.0.1?x",
      "http://127.0.0.1#x",
      "bad",
    ])
      expect(() => new RiskApiClient({ ...options, apiBaseUrl })).toThrow();
    for (const change of [
      { token: "all-access" },
      { timeoutMs: 1 },
      { timeoutMs: 30_001 },
      { maxResponseBytes: 1 },
      { maxResponseBytes: 2_097_153 },
    ])
      expect(() => new RiskApiClient({ ...options, ...change })).toThrow();
  });
  it("bounds actual response bytes, rejects redirects/errors and does not leak response bodies", async () => {
    for (const response of [
      new Response("x".repeat(1_025)),
      new Response("x", { headers: { "content-length": "1025" } }),
    ]) {
      const client = new RiskApiClient({
        ...options,
        fetch: vi.fn<typeof fetch>().mockResolvedValue(response),
      });
      await expect(client.invokeTool("risk_get_context", {})).rejects.toMatchObject({
        code: "response_too_large",
      });
    }
    for (const [response, code] of [
      [new Response("private", { status: 403 }), "http_error"],
      [new Response("notjson"), "invalid_response"],
      [new Response(null), "invalid_response"],
    ] as const) {
      const request = vi.fn<typeof fetch>().mockResolvedValue(response);
      await expect(
        new RiskApiClient({ ...options, fetch: request }).invokeTool("risk_get_context", {}),
      ).rejects.toMatchObject({ code });
      expect(request.mock.calls[0]?.[1]?.redirect).toBe("error");
    }
  });
  it("snapshots configuration and aborts unavailable, timed-out or cancelled requests", async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValue(new Error("private connection string"));
    const mutable = { ...options, fetch: request };
    const client = new RiskApiClient(mutable);
    mutable.token = "changed";
    await expect(client.invokeTool("risk_get_context", {})).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: `Bearer ${options.token}`,
    });
    const wait = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              reject(new Error("aborted"));
            },
            { once: true },
          );
          if (init?.signal?.aborted === true) reject(new Error("aborted"));
        }),
    );
    await expect(
      new RiskApiClient({ ...options, fetch: wait }).invokeTool("risk_get_context", {}),
    ).rejects.toMatchObject({ code: "timeout" });
    const controller = new AbortController();
    const pending = new RiskApiClient({ ...options, fetch: wait }).invokeTool(
      "risk_get_context",
      {},
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "timeout" });
    await expect(client.invokeTool("other" as InvestigationToolName, {})).rejects.toMatchObject({
      code: "invalid_config",
    });
  });
});
