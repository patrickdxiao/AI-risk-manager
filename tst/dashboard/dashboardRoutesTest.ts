import { afterEach, describe, expect, it } from "vitest";
import {
  DASHBOARD_ASSETS,
  DASHBOARD_CLIENT_JS,
  DASHBOARD_CSS,
  DASHBOARD_HTML,
  registerDashboardRoutes,
} from "../../src/dashboard/dashboardRoutes.js";
import { createDashboardAuth } from "../../src/dashboard/dashboardSession.js";

describe("dashboard assets", () => {
  it("serves a small accessible dashboard without inline code or unsafe HTML insertion", () => {
    expect(DASHBOARD_HTML).toContain('<html lang="en">');
    expect(DASHBOARD_HTML).toContain('class="skip-link"');
    expect(DASHBOARD_HTML).toContain('aria-live="polite"');
    expect(DASHBOARD_HTML).toContain('id="archive-panel"');
    expect(DASHBOARD_HTML).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/u);
    expect(DASHBOARD_HTML).not.toContain("<style");
    expect(DASHBOARD_CSS).toContain(":focus-visible");
    expect(DASHBOARD_CSS).toMatch(/@media \(max-width:/u);
    expect(DASHBOARD_CSS).toContain("@media (prefers-reduced-motion: reduce)");
    expect(DASHBOARD_CLIENT_JS).not.toMatch(/\.innerHTML\b|insertAdjacentHTML|document\.write/u);
  });
});

import Fastify, { type FastifyInstance } from "fastify";

describe("dashboard routes", () => {
  const HOST = "127.0.0.1:4317";
  const ORIGIN = `http://${HOST}`;
  const servers: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  describe("dashboard routes", () => {
    it("serves only the fixed GET and HEAD assets with restrictive headers", async () => {
      const server = build();

      for (const asset of DASHBOARD_ASSETS) {
        const get = await server.inject({
          method: "GET",
          url: asset.path,
          headers: { host: HOST },
        });
        expect(get.statusCode).toBe(200);
        expect(get.headers["content-type"]).toBe(asset.mimeType);
        expect(get.headers["cache-control"]).toBe("no-store");
        expect(get.headers["content-security-policy"]).toContain("default-src 'none'");
        expect(get.headers["referrer-policy"]).toBe("no-referrer");
        expect(get.headers["x-content-type-options"]).toBe("nosniff");
        expect(get.body).toBe(asset.body);

        const head = await server.inject({
          method: "HEAD",
          url: asset.path,
          headers: { host: HOST },
        });
        expect(head.statusCode).toBe(200);
        expect(head.headers["content-type"]).toBe(asset.mimeType);
        expect(head.body).toBe("");
      }
    });

    it.each([
      ["localhost:4317", "/"],
      ["example.test", "/dashboard.css"],
      ["127.0.0.1:0", "/dashboard.js"],
      ["127.0.0.1:65536", "/"],
      ["127.0.0.1:04317", "/"],
    ])("rejects a non-canonical Host %s", async (host, path) => {
      const response = await build().inject({ method: "GET", url: path, headers: { host } });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        error: { code: "forbidden", message: "Loopback same-origin access is required" },
      });
    });

    it("exchanges a valid bootstrap nonce once and rejects replay", async () => {
      const auth = createDashboardAuth();
      const server = build(auth);
      const grant = auth.issueBootstrapUrl(ORIGIN);
      const nonce = new URLSearchParams(new URL(grant.url).hash.slice(1)).get("bootstrap");
      if (nonce === null) throw new Error("expected bootstrap nonce");
      const request = {
        method: "POST" as const,
        url: "/api/ui/bootstrap",
        headers: {
          host: HOST,
          origin: ORIGIN,
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
        },
        payload: { nonce },
      };

      const exchanged = await server.inject(request);
      expect(exchanged.statusCode).toBe(200);
      expect(exchanged.headers["cache-control"]).toBe("no-store");
      expect(exchanged.json<{ token: string }>().token).toMatch(/^[A-Za-z0-9_-]{43}$/);

      const replay = await server.inject(request);
      expect(replay.statusCode).toBe(401);
      expect(replay.json()).toMatchObject({ error: { code: "bootstrap_invalid" } });
    });

    it.each([
      [{}, ORIGIN, undefined],
      [{ nonce: "short" }, ORIGIN, undefined],
      [{ nonce: "n".repeat(43), extra: true }, ORIGIN, undefined],
      [{ nonce: "n".repeat(43) }, "http://example.test", undefined],
      [{ nonce: "n".repeat(43) }, ORIGIN, "cross-site"],
    ] as const)(
      "fails closed for malformed or cross-origin bootstrap %#",
      async (payload, origin, site) => {
        const response = await build().inject({
          method: "POST",
          url: "/api/ui/bootstrap",
          headers: {
            host: HOST,
            origin,
            ...(site === undefined ? {} : { "sec-fetch-site": site }),
            "content-type": "application/json",
          },
          payload,
        });
        expect([400, 403]).toContain(response.statusCode);
        expect(response.headers["cache-control"]).toBe("no-store");
      },
    );
  });

  function build(auth = createDashboardAuth()): FastifyInstance {
    const server = Fastify({ logger: false });
    registerDashboardRoutes(server, { auth });
    servers.push(server);
    return server;
  }
});
