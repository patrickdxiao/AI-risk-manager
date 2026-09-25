import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  linkSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  AttemptCredentials,
  dedicatedAgentId,
  managedSessionId,
  validateCredentialsDirectory,
} from "../../../src/adapters/openclaw/attemptCredentials.js";
import { agentId, openClawFixture } from "../../fixtures/openClawFixture.js";
const cleanups: (() => void)[] = [];
function setup() {
  const fixture = openClawFixture();
  cleanups.push(fixture.cleanup);
  return { ...fixture, store: new AttemptCredentials(fixture.directory, agentId) };
}
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
describe("private session credential handoff", () => {
  it("writes a private exclusive file, binds one exact session, and removes authority", () => {
    const f = setup();
    const remove = f.store.save(f.credential);
    const path = join(f.directory, readdirSync(f.directory)[0] ?? "");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(f.store.load(f.credential.sessionKey)).toEqual(f.credential);
    expect(() => f.store.save(f.credential)).toThrow();
    expect(() => f.store.load(f.credential.sessionKey.replace(agentId, "other"))).toThrow();
    expect(managedSessionId(`agent:${agentId}:risk:../secret`, agentId)).toBeUndefined();
    remove();
    expect(() => f.store.load(f.credential.sessionKey)).toThrow();
  });
  it("rejects unsafe directories, non-dedicated agents and expired writes", () => {
    const f = setup();
    for (const id of ["main", "default", "bad:id", ""])
      expect(() => dedicatedAgentId(id)).toThrow();
    expect(() => f.store.save({ ...f.credential, expiresAt: Date.now() - 1 })).toThrow();
    expect(() => f.store.save({ ...f.credential, expiresAt: Date.now() + 700_000 })).toThrow();
    chmodSync(f.directory, 0o755);
    expect(() => validateCredentialsDirectory(f.directory)).toThrow();
    chmodSync(f.directory, 0o700);
    const alias = join(f.directory, "alias");
    symlinkSync(f.directory, alias);
    expect(() => validateCredentialsDirectory(alias)).toThrow();
  });
  it("rejects symlinks, hardlinks, permissive files, malformed and expired credentials", () => {
    const f = setup();
    f.store.save(f.credential);
    const path = join(f.directory, readdirSync(f.directory)[0] ?? "");
    const other = join(f.directory, "other");
    linkSync(path, other);
    expect(() => f.store.load(f.credential.sessionKey)).toThrow();
    unlinkSync(other);
    chmodSync(path, 0o644);
    expect(() => f.store.load(f.credential.sessionKey)).toThrow();
    chmodSync(path, 0o600);
    const raw = readFileSync(path);
    for (const text of [
      "not json",
      "x".repeat(4_097),
      JSON.stringify({ ...f.credential, sessionKey: "other" }),
      JSON.stringify({ ...f.credential, expiresAt: 1 }),
    ]) {
      writeFileSync(path, text);
      expect(() => f.store.load(f.credential.sessionKey)).toThrow();
    }
    writeFileSync(other, raw, { mode: 0o600 });
    unlinkSync(path);
    symlinkSync(other, path);
    expect(() => f.store.load(f.credential.sessionKey)).toThrow();
  });
});
