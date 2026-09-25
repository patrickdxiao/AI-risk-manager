import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildApiServer, localApiListenOptions } from "../../src/api/httpServer.js";
import { createDashboardAuth } from "../../src/dashboard/dashboardSession.js";
import { ApplicationError, DomainInvariantError } from "../../src/core/primitives.js";
import { RepositoryInspectionError } from "../../src/core/repository/repositoryModel.js";
import {
  RepositoryConflictError,
  PlanningEntityAlreadyExistsError,
} from "../../src/core/storageContracts.js";

const token = "a".repeat(43);
const headers = { authorization: `Bearer ${token}` };
const servers: ReturnType<typeof buildApiServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});
function server(auth?: ReturnType<typeof createDashboardAuth>) {
  const app = buildApiServer({ token, ...(auth === undefined ? {} : { dashboardAuth: auth }) });
  servers.push(app);
  return app;
}

describe("local HTTP boundary", () => {
  it("binds loopback and rejects malformed listener/credential configuration", () => {
    expect(localApiListenOptions()).toEqual({ host: "127.0.0.1", port: 4317 });
    expect(localApiListenOptions(0).port).toBe(0);
    for (const port of [-1, 65_536, 1.5, NaN]) expect(() => localApiListenOptions(port)).toThrow();
    expect(() => buildApiServer({ token: "wrong" })).toThrow(TypeError);
  });
  it("requires an exact bearer token and does not cache authenticated responses", async () => {
    const app = server();
    for (const authorization of [
      undefined,
      "",
      token,
      `Bearer ${token} `,
      `Bearer ${"b".repeat(43)}`,
      `Bearer ${token}, other`,
    ]) {
      const response = await app.inject({
        url: "/api/health",
        headers: authorization === undefined ? {} : { authorization },
      });
      expect(response.statusCode).toBe(401);
    }
    const response = await app.inject({ url: "/api/health", headers });
    expect(response.json()).toEqual({ status: "ok", version: "0.1.0" });
    expect(response.headers["cache-control"]).toBe("no-store");
  });
  it("accepts a live browser grant and rejects it after revocation", async () => {
    const auth = createDashboardAuth();
    const link = auth.issueBootstrapUrl("http://127.0.0.1:4317").url;
    const nonce = new URLSearchParams(new URL(link).hash.slice(1)).get("bootstrap");
    if (nonce === null) throw new Error("Missing bootstrap nonce");
    const grant = auth.consumeBootstrapNonce(nonce);
    if (grant === undefined) throw new Error("Missing browser grant");
    const app = server(auth);
    const options = {
      url: "/api/health",
      headers: { authorization: `Bearer ${grant.accessToken}` },
    };
    expect((await app.inject(options)).statusCode).toBe(200);
    auth.invalidateUiBearer(grant.accessToken);
    expect((await app.inject(options)).statusCode).toBe(401);
    auth.close();
  });
  it("limits anonymous access to explicitly registered dashboard routes", async () => {
    const auth = createDashboardAuth();
    const app = server(auth);
    app.get("/", () => "dashboard");
    app.post("/api/ui/bootstrap", () => ({ bootstrap: true }));
    app.post("/", () => "must be authenticated");
    app.get("/private", () => "secret");
    expect((await app.inject({ url: "/" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/", method: "HEAD" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/ui/bootstrap", method: "POST" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/", method: "POST" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/private" })).statusCode).toBe(401);
    auth.close();
  });
  it("sends attempt credentials only to their tool handlers, never to user endpoints", async () => {
    const app = server();
    app.post("/api/investigation-tools/risk_get_context", () => {
      throw new ApplicationError("attempt_unauthorized", "private credential details", "token");
    });
    app.post("/api/investigation-tools/unknown", () => "secret");
    const attemptHeaders = { authorization: "Bearer risk_attempt.a.b" };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/investigation-tools/risk_get_context",
          headers: attemptHeaders,
        })
      ).statusCode,
    ).toBe(403);
    expect((await app.inject({ url: "/api/health", headers: attemptHeaders })).statusCode).toBe(
      401,
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/investigation-tools/unknown",
          headers: attemptHeaders,
        })
      ).statusCode,
    ).toBe(401);
  });
  it.each([
    [new Error("private filesystem secret"), 500, "internal_error"],
    [new DomainInvariantError("required", "private field", "field"), 400, "validation_error"],
    [new ApplicationError("task_not_found", "private task", "id"), 404, "task_not_found"],
    [
      new ApplicationError("task_version_conflict", "private version", "version"),
      409,
      "task_version_conflict",
    ],
    [new RepositoryConflictError("id", "private id"), 409, "record_conflict"],
    [new PlanningEntityAlreadyExistsError("task", "private id"), 409, "record_conflict"],
    [
      new RepositoryInspectionError("not_git_repository", "private path"),
      400,
      "not_git_repository",
    ],
  ] as const)("maps %s to a safe HTTP error", async (error, status, code) => {
    const app = server();
    app.get("/fail", () => {
      throw error;
    });
    const response = await app.inject({ url: "/fail", headers });
    expect(response.statusCode).toBe(status);
    expect(response.json<{ error: { code: string } }>().error.code).toBe(code);
    expect(response.body).not.toContain("private");
  });
  it("rejects invalid JSON, unsupported content, oversized bodies, and invalid schemas", async () => {
    const app = server();
    app.post("/validate", (request) => z.object({ ok: z.boolean() }).strict().parse(request.body));
    expect(
      (await app.inject({ method: "POST", url: "/validate", headers, payload: { bad: true } }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/validate",
          headers: { ...headers, "content-type": "application/json" },
          payload: "{",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/validate",
          headers: { ...headers, "content-type": "application/octet-stream" },
          payload: "bad",
        })
      ).statusCode,
    ).toBe(415);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/validate",
          headers,
          payload: { value: "x".repeat(130 * 1024) },
        })
      ).statusCode,
    ).toBe(413);
  });
});
