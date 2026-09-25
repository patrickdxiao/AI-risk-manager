import { describe, expect, it, vi } from "vitest";
import {
  createDashboardAuth,
  DASHBOARD_AUTH_TOKEN_BYTES,
  DashboardAuthError,
} from "../../src/dashboard/dashboardSession.js";

describe("dashboard-auth", () => {
  const BASE_URL = "http://127.0.0.1:4317";
  const STARTED_AT = 1_787_860_800_000;
  const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

  describe("createDashboardAuth", () => {
    it("issues a bounded one-use bootstrap URL and a separate process-scoped bearer", () => {
      const harness = authHarness();

      const grant = harness.auth.issueBootstrapUrl(BASE_URL);
      const nonce = bootstrapNonce(grant.url);
      const bearer = harness.auth.consumeBootstrapNonce(nonce);

      expect(grant).toEqual({
        url: `${BASE_URL}/#bootstrap=${nonce}`,
        expiresAt: STARTED_AT + 1_000,
      });
      expect(nonce).toMatch(TOKEN_PATTERN);
      expect(bearer?.tokenType).toBe("Bearer");
      expect(bearer?.accessToken).toMatch(TOKEN_PATTERN);
      expect(bearer?.expiresAt).toBe(STARTED_AT + 10_000);
      expect(bearer?.accessToken).not.toBe(nonce);
      expect(harness.random).toHaveBeenNthCalledWith(1, DASHBOARD_AUTH_TOKEN_BYTES);
      expect(harness.random).toHaveBeenNthCalledWith(2, DASHBOARD_AUTH_TOKEN_BYTES);
      expect(harness.auth.authenticateUiBearer(nonce)).toBe(false);
      expect(harness.auth.authenticateUiBearer(bearer?.accessToken)).toBe(true);
      expect(harness.auth.consumeBootstrapNonce(nonce)).toBeUndefined();
    });

    it("allows exactly one concurrent consumer and rejects replay", async () => {
      const harness = authHarness();
      const nonce = bootstrapNonce(harness.auth.issueBootstrapUrl(BASE_URL).url);

      const results = await Promise.all([
        Promise.resolve().then(() => harness.auth.consumeBootstrapNonce(nonce)),
        Promise.resolve().then(() => harness.auth.consumeBootstrapNonce(nonce)),
      ]);

      expect(results.filter((result) => result !== undefined)).toHaveLength(1);
      expect(harness.auth.consumeBootstrapNonce(nonce)).toBeUndefined();
    });

    it("expires bootstrap grants and UI bearers at the exact TTL boundary", () => {
      const harness = authHarness();
      const firstNonce = bootstrapNonce(harness.auth.issueBootstrapUrl(BASE_URL).url);
      harness.setNow(STARTED_AT + 1_000);
      expect(harness.auth.consumeBootstrapNonce(firstNonce)).toBeUndefined();

      const secondNonce = bootstrapNonce(harness.auth.issueBootstrapUrl(BASE_URL).url);
      const bearer = harness.auth.consumeBootstrapNonce(secondNonce);
      expect(bearer).toBeDefined();
      harness.setNow(STARTED_AT + 11_000);
      expect(harness.auth.authenticateUiBearer(bearer?.accessToken)).toBe(false);
    });

    it("does not resurrect credentials when the injected wall clock moves backwards", () => {
      const harness = authHarness();
      const nonce = bootstrapNonce(harness.auth.issueBootstrapUrl(BASE_URL).url);
      harness.setNow(STARTED_AT + 1_000);
      expect(harness.auth.consumeBootstrapNonce(nonce)).toBeUndefined();
      harness.setNow(STARTED_AT - 1_000);
      expect(harness.auth.consumeBootstrapNonce(nonce)).toBeUndefined();
    });

    it.each(["", "short", "a".repeat(42), "a".repeat(44), "a".repeat(42) + "!"])(
      "rejects malformed bootstrap and bearer input without allocating for %j",
      (candidate) => {
        const harness = authHarness();
        expect(harness.auth.consumeBootstrapNonce(candidate)).toBeUndefined();
        expect(harness.auth.authenticateUiBearer(candidate)).toBe(false);
        expect(harness.auth.invalidateUiBearer(candidate)).toBe(false);
        expect(harness.random).not.toHaveBeenCalled();
      },
    );

    it("rejects well-formed unknown credentials without confusing nonce and bearer roles", () => {
      const harness = authHarness();
      const nonce = bootstrapNonce(harness.auth.issueBootstrapUrl(BASE_URL).url);
      const unknown = Buffer.alloc(DASHBOARD_AUTH_TOKEN_BYTES, 200).toString("base64url");

      expect(harness.auth.authenticateUiBearer(nonce)).toBe(false);
      expect(harness.auth.consumeBootstrapNonce(unknown)).toBeUndefined();
      expect(harness.auth.authenticateUiBearer(unknown)).toBe(false);
    });

    it("invalidates individual bearers without affecting another session", () => {
      const harness = authHarness();
      const first = exchangeNewGrant(harness.auth);
      const second = exchangeNewGrant(harness.auth);

      expect(harness.auth.invalidateUiBearer(first.accessToken)).toBe(true);
      expect(harness.auth.invalidateUiBearer(first.accessToken)).toBe(false);
      expect(harness.auth.authenticateUiBearer(first.accessToken)).toBe(false);
      expect(harness.auth.authenticateUiBearer(second.accessToken)).toBe(true);
    });

    it("bounds pending grants and active bearers by evicting the oldest live credential", () => {
      const harness = authHarness({ maxPendingBootstraps: 2, maxUiBearers: 2 });
      const firstNonce = bootstrapNonce(harness.auth.issueBootstrapUrl(BASE_URL).url);
      const secondNonce = bootstrapNonce(harness.auth.issueBootstrapUrl(BASE_URL).url);
      const thirdNonce = bootstrapNonce(harness.auth.issueBootstrapUrl(BASE_URL).url);

      expect(harness.auth.consumeBootstrapNonce(firstNonce)).toBeUndefined();
      const firstBearer = required(harness.auth.consumeBootstrapNonce(secondNonce));
      const secondBearer = required(harness.auth.consumeBootstrapNonce(thirdNonce));
      const thirdBearer = exchangeNewGrant(harness.auth);

      expect(harness.auth.authenticateUiBearer(firstBearer.accessToken)).toBe(false);
      expect(harness.auth.authenticateUiBearer(secondBearer.accessToken)).toBe(true);
      expect(harness.auth.authenticateUiBearer(thirdBearer.accessToken)).toBe(true);
    });

    it("retries credential collisions and fails closed when entropy remains duplicated", () => {
      const collisionBytes = Buffer.alloc(DASHBOARD_AUTH_TOKEN_BYTES, 7);
      const distinctBytes = Buffer.alloc(DASHBOARD_AUTH_TOKEN_BYTES, 8);
      const retryingRandom = vi
        .fn<(size: number) => Uint8Array>()
        .mockReturnValueOnce(collisionBytes)
        .mockReturnValueOnce(collisionBytes)
        .mockReturnValueOnce(distinctBytes);
      const auth = createDashboardAuth({ now: () => STARTED_AT, random: retryingRandom });
      const nonce = bootstrapNonce(auth.issueBootstrapUrl(BASE_URL).url);

      expect(auth.consumeBootstrapNonce(nonce)?.accessToken).toBe(
        distinctBytes.toString("base64url"),
      );
      expect(retryingRandom).toHaveBeenCalledTimes(3);

      const duplicateRandom = vi.fn(() => collisionBytes);
      const duplicateAuth = createDashboardAuth({ now: () => STARTED_AT, random: duplicateRandom });
      duplicateAuth.issueBootstrapUrl(BASE_URL);
      const error = captureError(() => duplicateAuth.issueBootstrapUrl(BASE_URL));
      expect(error).toBeInstanceOf(DashboardAuthError);
      if (!(error instanceof DashboardAuthError)) throw error;
      expect(error.code).toBe("entropy_unavailable");
      expect(duplicateRandom).toHaveBeenCalledTimes(17);
    });

    it("rejects invalid random sources, clocks, configuration, and non-loopback URLs", () => {
      expect(() =>
        createDashboardAuth({ random: () => new Uint8Array(4) }).issueBootstrapUrl(BASE_URL),
      ).toThrow(TypeError);
      expect(() =>
        createDashboardAuth({ now: () => Number.NaN }).issueBootstrapUrl(BASE_URL),
      ).toThrow(TypeError);
      expect(() => createDashboardAuth({ bootstrapTtlMs: 0 })).toThrow(RangeError);
      expect(() => createDashboardAuth({ bootstrapTtlMs: 300_001 })).toThrow(RangeError);
      expect(() => createDashboardAuth({ uiBearerTtlMs: 86_400_001 })).toThrow(RangeError);
      expect(() => createDashboardAuth({ maxPendingBootstraps: 0 })).toThrow(RangeError);
      expect(() => createDashboardAuth({ maxUiBearers: 1_025 })).toThrow(RangeError);

      for (const url of [
        "not a URL",
        "https://127.0.0.1:4317",
        "http://localhost:4317",
        "http://user@127.0.0.1:4317",
        "http://127.0.0.1:4317/dashboard",
        "http://127.0.0.1:4317/?token=secret",
        "http://127.0.0.1:4317/#existing",
      ]) {
        expect(() => createDashboardAuth().issueBootstrapUrl(url)).toThrow(TypeError);
      }
    });

    it("clears every credential on idempotent close and fails closed afterward", () => {
      const harness = authHarness();
      const pendingNonce = bootstrapNonce(harness.auth.issueBootstrapUrl(BASE_URL).url);
      const bearer = exchangeNewGrant(harness.auth);

      harness.auth.close();
      harness.auth.close();

      expect(harness.auth.consumeBootstrapNonce(pendingNonce)).toBeUndefined();
      expect(harness.auth.authenticateUiBearer(bearer.accessToken)).toBe(false);
      expect(harness.auth.invalidateUiBearer(bearer.accessToken)).toBe(false);
      const error = captureError(() => harness.auth.issueBootstrapUrl(BASE_URL));
      expect(error).toBeInstanceOf(DashboardAuthError);
      if (!(error instanceof DashboardAuthError)) throw error;
      expect(error.code).toBe("closed");
    });
  });

  function authHarness(
    options: { readonly maxPendingBootstraps?: number; readonly maxUiBearers?: number } = {},
  ): {
    readonly auth: ReturnType<typeof createDashboardAuth>;
    readonly random: ReturnType<typeof vi.fn<(size: number) => Uint8Array>>;
    setNow(value: number): void;
  } {
    let now = STARTED_AT;
    let sequence = 1;
    const random = vi.fn((size: number) => {
      const bytes = Buffer.alloc(size);
      bytes.writeUInt32BE(sequence, size - 4);
      sequence += 1;
      return bytes;
    });
    const auth = createDashboardAuth({
      now: () => now,
      random,
      bootstrapTtlMs: 1_000,
      uiBearerTtlMs: 10_000,
      ...options,
    });
    return {
      auth,
      random,
      setNow: (value: number) => {
        now = value;
      },
    };
  }

  function bootstrapNonce(url: string): string {
    const nonce = new URL(url).hash.slice(1);
    const value = new URLSearchParams(nonce).get("bootstrap");
    if (value === null) throw new Error("missing bootstrap nonce");
    return value;
  }

  function exchangeNewGrant(auth: ReturnType<typeof createDashboardAuth>) {
    const nonce = bootstrapNonce(auth.issueBootstrapUrl(BASE_URL).url);
    return required(auth.consumeBootstrapNonce(nonce));
  }

  function required<T>(value: T | undefined): T {
    if (value === undefined) throw new Error("expected a value");
    return value;
  }

  function captureError(work: () => unknown): unknown {
    try {
      work();
    } catch (error) {
      return error;
    }
    throw new Error("expected work to throw");
  }
});
