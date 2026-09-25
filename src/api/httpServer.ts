import Fastify, { type FastifyListenOptions } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import { ZodError } from "zod";
import { ApplicationError, DomainInvariantError } from "../core/primitives.js";
import { RepositoryInspectionError } from "../core/repository/repositoryModel.js";
import {
  PlanningEntityAlreadyExistsError,
  RepositoryConflictError,
} from "../core/storageContracts.js";
import type { DashboardAuth } from "../dashboard/dashboardSession.js";

export const DEFAULT_API_PORT = 4317;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const PUBLIC_ASSETS = new Set(["/", "/dashboard.css", "/dashboard.js"]);
const TOOL_PATH =
  /^\/api\/investigation-tools\/risk_(?:get_context|list_evidence|get_evidence|inspect_git)$/u;

/** Bind only to IPv4 loopback, including when an ephemeral port is requested. */
export function localApiListenOptions(port = DEFAULT_API_PORT): FastifyListenOptions {
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new RangeError("Local API port must be an integer from 0 through 65535");
  return { host: "127.0.0.1", port };
}

/** Authenticate local users separately from attempt-scoped tools; never log credentials. */
export function buildApiServer(options: {
  readonly token: string;
  readonly dashboardAuth?: DashboardAuth;
}) {
  if (!TOKEN_PATTERN.test(options.token)) throw new TypeError("Local API token is malformed");
  const expected = digest(options.token);
  const server = Fastify({ logger: false, bodyLimit: 128 * 1_024 });
  server.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const route = request.routeOptions.url ?? "";
    if (
      options.dashboardAuth !== undefined &&
      (((request.method === "GET" || request.method === "HEAD") && PUBLIC_ASSETS.has(route)) ||
        (request.method === "POST" && route === "/api/ui/bootstrap"))
    )
      return;
    const token = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_.-]+)$/u)?.[1];
    if (
      request.method === "POST" &&
      TOOL_PATH.test(route) &&
      token?.startsWith("risk_attempt.") === true
    )
      return;
    const owner = token !== undefined && timingSafeEqual(expected, digest(token));
    if (
      !owner &&
      (route === "/api/ui/sign-in-link" ||
        options.dashboardAuth?.authenticateUiBearer(token) !== true)
    )
      await reply
        .code(401)
        .send({ error: { code: "unauthorized", message: "A valid bearer token is required" } });
  });
  server.setErrorHandler((error, _request, reply) => {
    let code = "internal_error";
    let status = 500;
    if (error instanceof ZodError || error instanceof DomainInvariantError) {
      code = "validation_error";
      status = 400;
    } else if (error instanceof ApplicationError) {
      code = error.code;
      status = code.endsWith("_not_found")
        ? 404
        : [
              "attempt_unauthorized",
              "attempt_scope_revoked",
              "evidence_scope_mismatch",
              "tool_budget_exhausted",
            ].includes(code)
          ? 403
          : 409;
    } else if (
      error instanceof RepositoryConflictError ||
      error instanceof PlanningEntityAlreadyExistsError
    ) {
      code = "record_conflict";
      status = 409;
    } else if (error instanceof RepositoryInspectionError) {
      code = error.code;
      status = 400;
    } else if (
      error instanceof Error &&
      "statusCode" in error &&
      [400, 413, 415].includes(Number(error.statusCode))
    ) {
      code = "invalid_request";
      status = Number(error.statusCode);
    }
    void reply.code(status).send({
      error: {
        code,
        message: status === 500 ? "The local request failed" : "The request could not be accepted",
      },
    });
  });
  server.get("/api/health", () => ({ status: "ok", version: "0.1.0" }));
  return server;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
