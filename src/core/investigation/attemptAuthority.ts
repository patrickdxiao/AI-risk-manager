import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  ApplicationError,
  MAX_REVIEW_REPOSITORIES,
  normalizeStringList,
  requireInteger,
  requireNonBlank,
  requireUtcTimestamp,
} from "../primitives.js";
import type { TransactionContext } from "../storageContracts.js";
import { planningDigest } from "./evidenceScope.js";
import type { Investigation, InvestigationAttempt } from "./investigationModel.js";

export const ATTEMPT_TOOL_LIMIT = 12;
export const ATTEMPT_TOKEN_RESERVATION = 20_000;
export const DAILY_TOKEN_ADMISSION_LIMIT = 200_000;

export function credentialHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Create a credential for one attempt; only its hash is persisted. */
export function newAttemptToken(
  attemptId: string,
  secret = randomBytes(32).toString("base64url"),
): string {
  const id = requireNonBlank(attemptId, "attemptId", 256);
  requireNonBlank(secret, "secret");
  return `risk_attempt.${Buffer.from(id).toString("base64url")}.${createHmac("sha256", secret).update(`development-risk:${id}`).digest("base64url")}`;
}

/** Admission and saving the returned reservation must share the same transaction. */
export async function createAttemptAuthority(
  store: TransactionContext,
  investigation: Investigation,
  input: {
    readonly token: string;
    readonly repositoryIds: readonly string[];
    readonly now: string;
  },
): Promise<NonNullable<InvestigationAttempt["authority"]>> {
  const repositoryIds = Object.freeze(
    [
      ...new Set(
        normalizeStringList(input.repositoryIds, "repositoryIds", MAX_REVIEW_REPOSITORIES, 200),
      ),
    ].sort(),
  );
  for (const id of repositoryIds)
    if ((await store.repositories.findById(id)) === undefined)
      throw new ApplicationError(
        "attempt_scope_revoked",
        "Repository is not registered",
        "repositoryIds",
      );
  await assertBudgetAvailable(store, input.now);
  return Object.freeze({
    credentialHash: credentialHash(input.token),
    repositoryIds,
    planningDigest: await planningDigest(store, investigation),
    toolCalls: 0,
    reservedTokens: ATTEMPT_TOKEN_RESERVATION,
  });
}

/** Check all persisted owners in the transaction that performs the protected read or write. */
export async function assertExecutionOwnership(
  store: TransactionContext,
  investigation: Investigation,
  attemptId: string,
  nowInput: string,
): Promise<InvestigationAttempt> {
  const now = Date.parse(requireUtcTimestamp(nowInput, "now"));
  const attempt = await store.investigations.findAttemptById(attemptId);
  if (
    investigation.status !== "running" ||
    investigation.executionAttemptId !== attemptId ||
    !(Date.parse(investigation.executionLeaseUntil ?? "") > now) ||
    attempt?.status !== "running" ||
    attempt.investigationId !== investigation.id ||
    attempt.version !== investigation.executionVersion ||
    !(Date.parse(attempt.leaseUntil) > now) ||
    !(Date.parse(attempt.startedAt) <= now) ||
    (await store.investigations.findActive(nowInput))?.id !== investigation.id
  )
    throw leaseLost();
  if (attempt.dispatchTriggerId !== undefined) {
    const dispatch = await store.triggerDispatches.findByTriggerId(attempt.dispatchTriggerId);
    if (
      attempt.dispatchTriggerId !== investigation.triggerId ||
      dispatch?.status !== "leased" ||
      dispatch.investigationId !== investigation.id ||
      dispatch.leaseVersion !== attempt.dispatchLeaseVersion ||
      !(Date.parse(dispatch.leaseExpiresAt ?? "") > now)
    )
      throw leaseLost();
  } else if (attempt.dispatchLeaseVersion !== undefined) throw leaseLost();
  return attempt;
}

/** Missing authority never grants implicit access to registered repositories. */
export async function assertRepositoryScope(
  store: TransactionContext,
  attempt: InvestigationAttempt,
): Promise<void> {
  if (attempt.authority === undefined) throw unauthorized();
  for (const id of attempt.authority.repositoryIds)
    if ((await store.repositories.findById(id)) === undefined)
      throw new ApplicationError(
        "attempt_scope_revoked",
        "Repository permission was revoked",
        "repositoryIds",
      );
}

/** Authenticate and charge the call in the same transaction as the protected operation. */
export async function authorizeAttempt(
  store: TransactionContext,
  token: string,
  now: string,
  consumeCall = true,
) {
  const parts = /^risk_attempt\.([A-Za-z0-9_-]{1,1024})\.([A-Za-z0-9_-]{43})$/u.exec(token);
  if (parts?.[1] === undefined) throw unauthorized();
  const id = Buffer.from(parts[1], "base64url").toString("utf8");
  const attempt = await store.investigations.findAttemptById(id);
  const authority = attempt?.authority;
  if (
    attempt === undefined ||
    authority === undefined ||
    !/^[a-f0-9]{64}$/u.test(authority.credentialHash) ||
    !timingSafeEqual(
      Buffer.from(credentialHash(token), "hex"),
      Buffer.from(authority.credentialHash, "hex"),
    )
  )
    throw unauthorized();
  const investigation = await store.investigations.findById(attempt.investigationId);
  if (investigation === undefined) throw unauthorized();
  await assertExecutionOwnership(store, investigation, attempt.id, now);
  await assertRepositoryScope(store, attempt);
  requireInteger(authority.toolCalls, "toolCalls", 0);
  const authorized = Object.freeze({
    ...attempt,
    authority: Object.freeze({
      ...authority,
      repositoryIds: Object.freeze([...authority.repositoryIds]),
    }),
  });
  if (!consumeCall) return Object.freeze({ investigation, attempt: authorized });
  if (authority.toolCalls >= ATTEMPT_TOOL_LIMIT)
    throw new ApplicationError(
      "tool_budget_exhausted",
      "Investigation tool budget is exhausted",
      "toolCalls",
    );
  const updated = Object.freeze({
    ...authorized,
    authority: Object.freeze({ ...authorized.authority, toolCalls: authority.toolCalls + 1 }),
  });
  await store.investigations.saveAttempt(updated);
  return Object.freeze({ investigation, attempt: updated });
}

/** Unknown or still-running usage retains its reservation even outside the reporting window. */
export async function assertBudgetAvailable(
  store: TransactionContext,
  nowInput: string,
): Promise<void> {
  const now = requireUtcTimestamp(nowInput, "now");
  const since = new Date(Date.parse(now) - 24 * 60 * 60_000).toISOString();
  const attempts = new Map(
    (await store.investigations.listAttemptsSince(since)).map((attempt) => [attempt.id, attempt]),
  );
  for (const attempt of await store.investigations.listUnsettledAttempts())
    attempts.set(attempt.id, attempt);
  let committed = ATTEMPT_TOKEN_RESERVATION;
  for (const attempt of attempts.values()) {
    const reported = attempt.usage?.totalTokens;
    const reservation = requireInteger(
      attempt.authority?.reservedTokens ?? ATTEMPT_TOKEN_RESERVATION,
      "reservedTokens",
      0,
    );
    const used = reported === undefined ? 0 : requireInteger(reported, "totalTokens", 0);
    committed +=
      attempt.status === "running" || reported === undefined ? Math.max(reservation, used) : used;
    if (committed > DAILY_TOKEN_ADMISSION_LIMIT)
      throw new ApplicationError(
        "investigation_budget_exhausted",
        "The token admission budget is exhausted",
        "reservedTokens",
      );
  }
}

function unauthorized(): ApplicationError {
  return new ApplicationError("attempt_unauthorized", "Attempt credential is invalid", "token");
}
function leaseLost(): ApplicationError {
  return new ApplicationError(
    "execution_lease_lost",
    "The attempt no longer owns this work",
    "executionAttemptId",
  );
}
