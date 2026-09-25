import { mkdtemp, mkdir, readdir, rm, symlink, chmod, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApiServer } from "../../src/api/httpServer.js";
import { ensureLocalToken, LOCAL_TOKEN_FILE, readLocalToken } from "../../src/api/apiToken.js";
import { requestDashboardLink } from "../../src/api/dashboardLink.js";
import { createDashboardAuth } from "../../src/dashboard/dashboardSession.js";
import { registerDashboardRoutes } from "../../src/dashboard/dashboardRoutes.js";

const folders: string[] = [];
const apps: ReturnType<typeof buildApiServer>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "risk-sign-in-"));
  folders.push(path);
  return path;
}
async function fixture() {
  const stateDir = await directory();
  await chmod(stateDir, 0o700);
  const token = await ensureLocalToken(stateDir);
  let time = Date.now();
  const auth = createDashboardAuth({
    now: () => time,
    bootstrapTtlMs: 1_000,
    uiBearerTtlMs: 2_000,
  });
  const app = buildApiServer({ token, dashboardAuth: auth });
  apps.push(app);
  registerDashboardRoutes(app, { auth });
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  const port = Number(new URL(origin).port);
  return {
    stateDir,
    token,
    auth,
    app,
    origin,
    port,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe("fresh dashboard links", () => {
  it("renews after nonce/session expiry without restarting the same HTTP server or rewriting local state", async () => {
    const f = await fixture();
    const before = await readdir(f.stateDir);
    const expired = await requestDashboardLink(f);
    f.advance(1_000);
    const exchange = (url: string) =>
      f.app.inject({
        method: "POST",
        url: "/api/ui/bootstrap",
        headers: { host: new URL(f.origin).host, origin: f.origin },
        payload: { nonce: new URLSearchParams(new URL(url).hash.slice(1)).get("bootstrap") },
      });
    expect((await exchange(expired)).statusCode).toBe(401);
    const first = await requestDashboardLink(f);
    const response = await exchange(first);
    expect(response.statusCode).toBe(200);
    expect((await exchange(first)).statusCode).toBe(401);
    const bearer = response.json<{ token: string }>().token;
    expect(
      (await f.app.inject({ url: "/api/health", headers: { authorization: `Bearer ${bearer}` } }))
        .statusCode,
    ).toBe(200);
    f.advance(2_000);
    expect(
      (await f.app.inject({ url: "/api/health", headers: { authorization: `Bearer ${bearer}` } }))
        .statusCode,
    ).toBe(401);
    const renewed = await requestDashboardLink(f);
    expect((await exchange(renewed)).statusCode).toBe(200);
    expect(new URL(renewed).origin).toBe(f.origin);
    expect(renewed).not.toContain(f.token);
    expect(await readdir(f.stateDir)).toEqual(before);
    expect(await readLocalToken(f.stateDir)).toBe(f.token);
  });

  it("allows only the durable owner credential to mint links and still requires canonical same-origin requests", async () => {
    const f = await fixture();
    const nonce = new URLSearchParams(
      new URL(f.auth.issueBootstrapUrl(f.origin).url).hash.slice(1),
    ).get("bootstrap");
    if (!nonce) throw new Error("Missing nonce");
    const bearer = f.auth.consumeBootstrapNonce(nonce);
    if (!bearer) throw new Error("Missing session");
    const request = { method: "POST" as const, url: "/api/ui/sign-in-link", payload: {} };
    for (const credential of [
      undefined,
      bearer.accessToken,
      "risk_attempt.fake.secret",
      "z".repeat(43),
    ]) {
      const denied = await f.app.inject({
        ...request,
        headers: {
          host: new URL(f.origin).host,
          origin: f.origin,
          ...(credential === undefined ? {} : { authorization: `Bearer ${credential}` }),
        },
      });
      expect(denied.statusCode).toBe(401);
      expect(denied.body).not.toContain("bootstrap=");
    }
    for (const extra of [
      { origin: "http://example.invalid" },
      { origin: undefined },
      { "sec-fetch-site": "cross-site" },
      { host: "localhost:4317" },
    ]) {
      const headers = Object.fromEntries(
        Object.entries({
          authorization: `Bearer ${f.token}`,
          host: new URL(f.origin).host,
          origin: f.origin,
          ...extra,
        }).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      );
      const response = await f.app.inject({ ...request, headers });
      expect(response.statusCode).toBe(403);
    }
    const malformed = await f.app.inject({
      ...request,
      payload: { extra: true },
      headers: {
        authorization: `Bearer ${f.token}`,
        host: new URL(f.origin).host,
        origin: f.origin,
      },
    });
    expect(malformed.statusCode).toBe(400);
  });

  it("reads existing private state only, rejecting missing credentials and symlinks without creating anything", async () => {
    const root = await directory();
    const absent = join(root, "absent");
    await expect(readLocalToken(absent)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(root)).toEqual([]);
    await mkdir(absent, { mode: 0o700 });
    await expect(readLocalToken(absent)).rejects.toMatchObject({ code: "token_file_malformed" });
    expect(await readdir(absent)).toEqual([]);
    const token = await ensureLocalToken(absent);
    const link = join(root, "link");
    await symlink(absent, link);
    await expect(readLocalToken(link)).rejects.toMatchObject({
      code: "state_directory_not_directory",
    });
    if (process.platform !== "win32") {
      await chmod(join(absent, LOCAL_TOKEN_FILE), 0o644);
      await expect(readLocalToken(absent)).rejects.toMatchObject({
        code: "token_file_not_private",
      });
    }
    expect(token).toHaveLength(43);
  });

  it("rejects wrong owner credentials, invalid ports, redirects, oversized responses and hostile returned origins", async () => {
    const f = await fixture();
    await expect(requestDashboardLink({ stateDir: f.stateDir, port: 0 })).rejects.toThrow(
      "actual port",
    );
    await writeFile(join(f.stateDir, LOCAL_TOKEN_FILE), "z".repeat(43), { mode: 0o600 });
    await expect(requestDashboardLink(f)).rejects.toThrow("owner credential");
    await writeFile(join(f.stateDir, LOCAL_TOKEN_FILE), f.token, { mode: 0o600 });
    for (const kind of ["redirect", "oversized", "foreign", "malformed"]) {
      const app = buildApiServer({ token: f.token });
      apps.push(app);
      app.post("/api/ui/sign-in-link", (_request, reply) => {
        if (kind === "redirect") return reply.redirect("http://example.invalid/");
        if (kind === "oversized") return { url: "x".repeat(4_097) };
        if (kind === "foreign")
          return { url: "http://example.invalid/#bootstrap=" + "x".repeat(43) };
        return { url: 123 };
      });
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      await expect(
        requestDashboardLink({ stateDir: f.stateDir, port: Number(new URL(address).port) }),
      ).rejects.toThrow();
    }
  });
});
