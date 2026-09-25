import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { readFileSync } from "node:fs";
import type { DashboardAuth } from "./dashboardSession.js";
export interface DashboardAsset {
  readonly path: "/" | "/dashboard.css" | "/dashboard.js";
  readonly mimeType: string;
  readonly body: string;
}

export const DASHBOARD_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), geolocation=(), microphone=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
});

export const DASHBOARD_HTML = readFileSync(new URL("./index.html", import.meta.url), "utf8");

export const DASHBOARD_CSS = readFileSync(new URL("./dashboard.css", import.meta.url), "utf8");

export const DASHBOARD_CLIENT_JS = readFileSync(new URL("./dashboard.js", import.meta.url), "utf8");

export const DASHBOARD_ASSETS: readonly DashboardAsset[] = Object.freeze([
  Object.freeze({ path: "/", mimeType: "text/html; charset=utf-8", body: DASHBOARD_HTML }),
  Object.freeze({
    path: "/dashboard.css",
    mimeType: "text/css; charset=utf-8",
    body: DASHBOARD_CSS,
  }),
  Object.freeze({
    path: "/dashboard.js",
    mimeType: "text/javascript; charset=utf-8",
    body: DASHBOARD_CLIENT_JS,
  }),
]);

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const LOOPBACK_HOST_PATTERN = /^127\.0\.0\.1(?::([1-9][0-9]{0,4}))?$/;
const BOOTSTRAP_PATH = "/api/ui/bootstrap";
export interface DashboardRouteOptions {
  readonly auth: DashboardAuth;
}

/** Serve local assets and exchange same-origin one-use links for browser credentials. */
export function registerDashboardRoutes(
  server: FastifyInstance,
  options: DashboardRouteOptions,
): void {
  for (const asset of DASHBOARD_ASSETS) {
    server.route({
      method: ["GET", "HEAD"],
      url: asset.path,
      handler: async (request, reply) => {
        if (localOrigin(request) === undefined) return sendForbidden(reply);
        reply.headers(DASHBOARD_SECURITY_HEADERS);
        reply.type(asset.mimeType);
        return request.method === "HEAD" ? reply.send() : reply.send(asset.body);
      },
    });
  }

  server.post(BOOTSTRAP_PATH, async (request, reply) => {
    const origin = localOrigin(request);
    if (origin === undefined || !hasSameOrigin(request, origin)) return sendForbidden(reply);

    const nonce = parseBootstrapNonce(request.body);
    if (nonce === undefined) {
      return sendError(reply, 400, "validation_error", "Request validation failed");
    }

    const bearer = options.auth.consumeBootstrapNonce(nonce);
    if (bearer === undefined) {
      return sendError(reply, 401, "bootstrap_invalid", "Bootstrap credential is invalid");
    }

    reply.header("Cache-Control", "no-store");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Content-Type-Options", "nosniff");
    return reply.code(200).send({ token: bearer.accessToken, expiresAt: bearer.expiresAt });
  });
}

/** Accept only a canonical IPv4 loopback Host header. */
function localOrigin(request: FastifyRequest): string | undefined {
  const host = request.headers.host;
  if (host === undefined) return undefined;
  const match = LOOPBACK_HOST_PATTERN.exec(host);
  if (match === null) return undefined;

  const portText = match[1];
  if (portText !== undefined) {
    const port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65_535 || String(port) !== portText) {
      return undefined;
    }
  }
  return `http://${host}`;
}

/** Require the browser request to originate from this local service. */
function hasSameOrigin(request: FastifyRequest, expectedOrigin: string): boolean {
  const fetchSite = request.headers["sec-fetch-site"];
  return (
    request.headers.origin === expectedOrigin &&
    (fetchSite === undefined || fetchSite === "same-origin")
  );
}

/** Accept exactly one well-formed one-use sign-in nonce. */
function parseBootstrapNonce(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "nonce") return undefined;
  const nonce = (value as Record<string, unknown>)["nonce"];
  return typeof nonce === "string" && TOKEN_PATTERN.test(nonce) ? nonce : undefined;
}

/** Reject requests that fail the local origin check. */
function sendForbidden(reply: FastifyReply): FastifyReply {
  return sendError(reply, 403, "forbidden", "Loopback same-origin access is required");
}

/** Send a stable error code and a public explanation. */
function sendError(
  reply: FastifyReply,
  statusCode: 400 | 401 | 403,
  code: string,
  message: string,
): FastifyReply {
  reply.header("Cache-Control", "no-store");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header("X-Content-Type-Options", "nosniff");
  return reply.code(statusCode).send({ error: { code, message } });
}
