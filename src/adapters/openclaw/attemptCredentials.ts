import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";

const credentialSchema = z
  .object({
    sessionKey: z.string().max(150),
    attemptId: z.string().min(1).max(256),
    token: z
      .string()
      .regex(/^risk_attempt\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u)
      .max(512),
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type AttemptCredential = z.infer<typeof credentialSchema>;

export function dedicatedAgentId(value: string): string {
  if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(value) || ["main", "default"].includes(value))
    throw new Error("A dedicated investigator agent ID is required");
  return value;
}

export function managedSessionId(key: string, agentId: string): string | undefined {
  const prefix = `agent:${dedicatedAgentId(agentId)}:risk:`;
  const id = key.startsWith(prefix) ? key.slice(prefix.length) : "";
  return /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(id)
    ? id
    : undefined;
}

/** The caller creates this application-owned directory; never repair permissions on an arbitrary path. */
export function validateCredentialsDirectory(directory: string): string {
  const path = resolve(directory);
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    realpathSync(path) !== path ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error(
      "Attempt credentials require a private, canonical directory owned by this user",
    );
  return path;
}

/** Only the random managed-session ID determines the filename; tool arguments never select it. */
export class AttemptCredentials {
  constructor(
    private readonly directory: string,
    private readonly agentId: string,
  ) {
    dedicatedAgentId(agentId);
    validateCredentialsDirectory(directory);
  }

  save(input: AttemptCredential): () => void {
    const value = credentialSchema.parse(input);
    const path = this.path(value.sessionKey);
    if (!(value.expiresAt > Date.now()) || value.expiresAt > Date.now() + 600_000)
      throw new Error("Invalid credential expiry");
    const descriptor = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(descriptor, JSON.stringify(value));
    } catch (error) {
      unlinkSync(path);
      throw error;
    } finally {
      closeSync(descriptor);
    }
    return () => {
      rmSync(path, { force: true });
    };
  }

  load(sessionKey: string): AttemptCredential {
    const descriptor = openSync(
      this.path(sessionKey),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = fstatSync(descriptor);
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o077) !== 0 ||
        stat.size > 4_096
      )
        throw new Error("Invalid credential file");
      const value = credentialSchema.parse(JSON.parse(readFileSync(descriptor, "utf8")) as unknown);
      if (value.sessionKey !== sessionKey || value.expiresAt <= Date.now())
        throw new Error("Expired or mismatched credential");
      return Object.freeze(value);
    } finally {
      closeSync(descriptor);
    }
  }

  private path(sessionKey: string): string {
    const id = managedSessionId(sessionKey, this.agentId);
    if (id === undefined) throw new Error("Not a managed investigator session");
    return join(validateCredentialsDirectory(this.directory), `${id}.json`);
  }
}
