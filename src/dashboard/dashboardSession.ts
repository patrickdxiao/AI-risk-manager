import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
export const DASHBOARD_AUTH_TOKEN_BYTES = 32;
export const DEFAULT_DASHBOARD_BOOTSTRAP_TTL_MS = 60_000;
export const DEFAULT_DASHBOARD_UI_BEARER_TTL_MS = 12 * 60 * 60_000;
export const DEFAULT_DASHBOARD_AUTH_CAPACITY = 64;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_BOOTSTRAP_TTL_MS = 5 * 60_000;
const MAX_UI_BEARER_TTL_MS = 24 * 60 * 60_000;
const MAX_CAPACITY = 1_024;
const TOKEN_GENERATION_ATTEMPTS = 16;

export interface DashboardBootstrapGrant {
  readonly url: string;
  readonly expiresAt: number;
}

export interface DashboardUiBearer {
  readonly tokenType: "Bearer";
  readonly accessToken: string;
  readonly expiresAt: number;
}

export interface DashboardAuth {
  issueBootstrapUrl(baseUrl: string): DashboardBootstrapGrant;
  consumeBootstrapNonce(nonce: string): DashboardUiBearer | undefined;
  authenticateUiBearer(candidate: string | undefined): boolean;
  invalidateUiBearer(candidate: string): boolean;
  close(): void;
}

export interface DashboardAuthOptions {
  readonly now?: () => number;
  readonly random?: (size: number) => Uint8Array;
  readonly bootstrapTtlMs?: number;
  readonly uiBearerTtlMs?: number;
  readonly maxPendingBootstraps?: number;
  readonly maxUiBearers?: number;
}

export type DashboardAuthErrorCode = "closed" | "entropy_unavailable";

/** Reports closed authentication state or unavailable credential entropy. */
export class DashboardAuthError extends Error {
  override readonly name = "DashboardAuthError";

  constructor(
    readonly code: DashboardAuthErrorCode,
    message: string,
  ) {
    super(message);
  }
}

interface StoredCredential {
  readonly digest: Buffer;
  readonly expiresAt: number;
}

/** Create process-local one-use links and expiring browser sessions. */
export function createDashboardAuth(options: DashboardAuthOptions = {}): DashboardAuth {
  return new InMemoryDashboardAuth(options);
}

/** Keeps only credential hashes and expiry times in this process. */
class InMemoryDashboardAuth implements DashboardAuth {
  private readonly now: () => number;
  private readonly random: (size: number) => Uint8Array;
  private readonly bootstrapTtlMs: number;
  private readonly uiBearerTtlMs: number;
  private readonly maxPendingBootstraps: number;
  private readonly maxUiBearers: number;
  private readonly pendingBootstraps: StoredCredential[] = [];
  private readonly uiBearers: StoredCredential[] = [];
  private lastObservedAt = 0;
  private closed = false;

  constructor(options: DashboardAuthOptions) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? randomBytes;
    this.bootstrapTtlMs = boundedInteger(
      options.bootstrapTtlMs ?? DEFAULT_DASHBOARD_BOOTSTRAP_TTL_MS,
      1,
      MAX_BOOTSTRAP_TTL_MS,
      "bootstrap TTL",
    );
    this.uiBearerTtlMs = boundedInteger(
      options.uiBearerTtlMs ?? DEFAULT_DASHBOARD_UI_BEARER_TTL_MS,
      1,
      MAX_UI_BEARER_TTL_MS,
      "UI bearer TTL",
    );
    this.maxPendingBootstraps = boundedInteger(
      options.maxPendingBootstraps ?? DEFAULT_DASHBOARD_AUTH_CAPACITY,
      1,
      MAX_CAPACITY,
      "pending bootstrap capacity",
    );
    this.maxUiBearers = boundedInteger(
      options.maxUiBearers ?? DEFAULT_DASHBOARD_AUTH_CAPACITY,
      1,
      MAX_CAPACITY,
      "UI bearer capacity",
    );
  }

  /** Issue a short-lived sign-in nonce in the URL fragment. */
  issueBootstrapUrl(baseUrl: string): DashboardBootstrapGrant {
    this.assertOpen();
    const origin = loopbackOrigin(baseUrl);
    const observedAt = this.observeTime();
    this.removeExpired(observedAt);

    const nonce = this.createUniqueToken();
    const expiresAt = expiration(observedAt, this.bootstrapTtlMs);
    this.makeRoom(this.pendingBootstraps, this.maxPendingBootstraps);
    this.pendingBootstraps.push({ digest: digest(nonce), expiresAt });

    const url = new URL("/", origin);
    url.hash = new URLSearchParams({ bootstrap: nonce }).toString();
    return Object.freeze({ url: url.toString(), expiresAt });
  }

  /** Exchange a valid nonce once for an expiring browser credential. */
  consumeBootstrapNonce(nonce: string): DashboardUiBearer | undefined {
    if (this.closed || !TOKEN_PATTERN.test(nonce)) return undefined;
    const observedAt = this.observeTime();
    this.removeExpired(observedAt);

    const index = findCredential(this.pendingBootstraps, digest(nonce));
    if (index === -1) return undefined;

    const accessToken = this.createUniqueToken();
    const expiresAt = expiration(observedAt, this.uiBearerTtlMs);
    const consumed = this.pendingBootstraps.splice(index, 1)[0];
    consumed?.digest.fill(0);
    this.makeRoom(this.uiBearers, this.maxUiBearers);
    this.uiBearers.push({ digest: digest(accessToken), expiresAt });

    return Object.freeze({ tokenType: "Bearer", accessToken, expiresAt });
  }

  /** Accept a known, unexpired browser credential. */
  authenticateUiBearer(candidate: string | undefined): boolean {
    if (this.closed || candidate === undefined || !TOKEN_PATTERN.test(candidate)) return false;
    const observedAt = this.observeTime();
    this.removeExpired(observedAt);
    return findCredential(this.uiBearers, digest(candidate)) !== -1;
  }

  /** Remove a browser credential when it is still active. */
  invalidateUiBearer(candidate: string): boolean {
    if (this.closed || !TOKEN_PATTERN.test(candidate)) return false;
    const observedAt = this.observeTime();
    this.removeExpired(observedAt);
    const index = findCredential(this.uiBearers, digest(candidate));
    if (index === -1) return false;
    const invalidated = this.uiBearers.splice(index, 1)[0];
    invalidated?.digest.fill(0);
    return true;
  }

  /** Invalidate all credentials and prevent further sign-in links. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearCredentials(this.pendingBootstraps);
    clearCredentials(this.uiBearers);
  }

  /** Reject credential issuance after authentication has closed. */
  private assertOpen(): void {
    if (this.closed) {
      throw new DashboardAuthError("closed", "dashboard authentication is closed");
    }
  }

  /** Use a validated clock that never moves backwards during this process. */
  private observeTime(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError("dashboard authentication clock must return epoch milliseconds");
    }
    this.lastObservedAt = Math.max(this.lastObservedAt, value);
    return this.lastObservedAt;
  }

  /** Generate a credential that differs from every active credential. */
  private createUniqueToken(): string {
    for (let attempt = 0; attempt < TOKEN_GENERATION_ATTEMPTS; attempt += 1) {
      const bytes = this.random(DASHBOARD_AUTH_TOKEN_BYTES);
      if (!(bytes instanceof Uint8Array) || bytes.byteLength !== DASHBOARD_AUTH_TOKEN_BYTES) {
        throw new TypeError("dashboard authentication random source returned invalid bytes");
      }
      const candidate = Buffer.from(bytes).toString("base64url");
      const candidateDigest = digest(candidate);
      if (
        findCredential(this.pendingBootstraps, candidateDigest) === -1 &&
        findCredential(this.uiBearers, candidateDigest) === -1
      ) {
        return candidate;
      }
    }
    throw new DashboardAuthError(
      "entropy_unavailable",
      "dashboard authentication could not generate a unique credential",
    );
  }

  /** Discard expired one-use links and browser sessions. */
  private removeExpired(observedAt: number): void {
    removeExpiredCredentials(this.pendingBootstraps, observedAt);
    removeExpiredCredentials(this.uiBearers, observedAt);
  }

  /** Evict the oldest credential when the bounded store is full. */
  private makeRoom(credentials: StoredCredential[], maximum: number): void {
    while (credentials.length >= maximum) {
      credentials.shift()?.digest.fill(0);
    }
  }
}

/** Validate a configured lifetime or capacity against its supported bounds. */
function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${name} must be an integer from ${String(minimum)} through ${String(maximum)}`,
    );
  }
  return value;
}

/** Require an HTTP loopback origin without credentials, paths, or fragments. */
function loopbackOrigin(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new TypeError("dashboard base URL must be an HTTP loopback origin");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError("dashboard base URL must be an HTTP loopback origin");
  }
  return url.origin;
}

/** Compute a representable credential expiry time. */
function expiration(observedAt: number, ttlMs: number): number {
  const expiresAt = observedAt + ttlMs;
  if (!Number.isSafeInteger(expiresAt)) {
    throw new RangeError("dashboard authentication expiration is outside the safe range");
  }
  return expiresAt;
}

/** Hash a credential before comparing it with stored credentials. */
function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Find a matching credential hash using constant-time comparisons. */
function findCredential(credentials: readonly StoredCredential[], candidateDigest: Buffer): number {
  let matchedIndex = -1;
  for (let index = 0; index < credentials.length; index += 1) {
    const credential = credentials[index];
    if (credential !== undefined && timingSafeEqual(credential.digest, candidateDigest)) {
      matchedIndex = index;
    }
  }
  return matchedIndex;
}

/** Remove and clear hashes for expired credentials. */
function removeExpiredCredentials(credentials: StoredCredential[], observedAt: number): void {
  for (let index = credentials.length - 1; index >= 0; index -= 1) {
    const credential = credentials[index];
    if (credential !== undefined && credential.expiresAt <= observedAt) {
      credential.digest.fill(0);
      credentials.splice(index, 1);
    }
  }
}

/** Clear stored hashes before discarding the credential list. */
function clearCredentials(credentials: StoredCredential[]): void {
  for (const credential of credentials) credential.digest.fill(0);
  credentials.splice(0);
}
