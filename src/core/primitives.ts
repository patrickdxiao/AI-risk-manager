export type RepositoryId = string;
export type SprintId = string;
export type TaskId = string;
export type EvidenceEventId = string;
export type EvidenceItemId = string;
export type InvestigationId = string;
export type FindingId = string;
export type FindingFeedbackId = string;
export type UtcTimestamp = string;

export const MAX_REVIEW_REPOSITORIES = 20;
export const MAX_REVIEW_SEED_EVIDENCE = 50;

export interface ClockPort {
  now(): UtcTimestamp;
}

export interface IdGeneratorPort {
  next(): string;
}

export type ApplicationErrorCode =
  | "sprint_not_found"
  | "task_not_found"
  | "task_version_conflict"
  | "finding_not_found"
  | "finding_feedback_conflict"
  | "investigation_not_found"
  | "task_scope_mismatch"
  | "repository_observation_conflict"
  | "evidence_not_found"
  | "evidence_scope_mismatch"
  | "attempt_unauthorized"
  | "attempt_scope_revoked"
  | "execution_lease_lost"
  | "tool_budget_exhausted"
  | "investigation_budget_exhausted"
  | "repository_not_found"
  | "investigation_queue_full"
  | "investigation_result_conflict"
  | "investigation_input_changed"
  | "invalid_coverage";

export class ApplicationError extends Error {
  override readonly name = "ApplicationError";
  constructor(
    readonly code: ApplicationErrorCode,
    message: string,
    readonly field: string,
  ) {
    super(message);
  }
}

export type PrivacyMode = "metadata_only" | "selected_content";
export type RiskState = "healthy" | "uncertain" | "at_risk" | "blocked";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type DomainErrorCode =
  | "required"
  | "invalid_value"
  | "out_of_range"
  | "invalid_date_range"
  | "self_dependency"
  | "duplicate_reference"
  | "missing_evidence_citation"
  | "unknown_evidence_citation"
  | "invalid_transition"
  | "scope_mismatch";

/** Reports invalid domain data with a stable code and field. */
export class DomainInvariantError extends Error {
  override readonly name = "DomainInvariantError";

  constructor(
    readonly code: DomainErrorCode,
    message: string,
    readonly field: string,
  ) {
    super(message);
  }
}

/** Trim required text and bound its stored length. */
export function requireNonBlank(value: string, field: string, maximum = 8_000): string {
  const normalized = value.trim();
  if (normalized.length === 0)
    throw new DomainInvariantError("required", `${field} is required`, field);
  if (normalized.length > maximum)
    throw new DomainInvariantError(
      "out_of_range",
      `${field} exceeds ${String(maximum)} characters`,
      field,
    );
  return normalized;
}

export function optionalNonBlank(value: string | undefined, field: string): string | undefined {
  return value === undefined ? undefined : requireNonBlank(value, field);
}

/** Accept ISO UTC timestamps through millisecond precision, without calendar rollover. */
export function requireUtcTimestamp(value: string, field: string): UtcTimestamp {
  const date = new Date(value);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value) ||
    !Number.isFinite(date.valueOf()) ||
    date.toISOString().slice(0, 19) !== value.slice(0, 19)
  )
    throw new DomainInvariantError(
      "invalid_value",
      `${field} must be a valid ISO UTC timestamp`,
      field,
    );
  return date.toISOString();
}

/** Reject reversed dates and, when requested, empty intervals. */
export function requireTimestampOrder(
  earlier: UtcTimestamp,
  later: UtcTimestamp,
  field: string,
  allowEqual = true,
): void {
  const difference = Date.parse(later) - Date.parse(earlier);
  if (!(allowEqual ? difference >= 0 : difference > 0))
    throw new DomainInvariantError(
      "invalid_date_range",
      `${field} is out of chronological order`,
      field,
    );
}

export function requireInteger(value: number, field: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new DomainInvariantError(
      "out_of_range",
      `${field} must be a safe integer at least ${String(minimum)}`,
      field,
    );
  return value;
}

/** Reject non-finite numbers and values outside the allowed range. */
export function requireFiniteRange(
  value: number,
  field: string,
  minimum: number,
  maximum = Number.POSITIVE_INFINITY,
): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum)
    throw new DomainInvariantError("out_of_range", `${field} is out of range`, field);
  return value;
}

/** Copy and freeze bounded lists so later input edits cannot change saved values. */
export function normalizeStringList(
  values: readonly string[],
  field: string,
  maximumEntries = 100,
  maximumLength = 4_000,
): readonly string[] {
  if (values.length > maximumEntries)
    throw new DomainInvariantError(
      "out_of_range",
      `${field} exceeds ${String(maximumEntries)} entries`,
      field,
    );
  return Object.freeze(
    values.map((value, index) =>
      requireNonBlank(value, `${field}[${String(index)}]`, maximumLength),
    ),
  );
}

/** Copy bounded plain JSON without executing accessors or retaining mutable input. */
export function normalizeJsonRecord(
  value: unknown,
  field: string,
): Readonly<Record<string, JsonValue>> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new DomainInvariantError("invalid_value", `${field} must be a JSON object`, field);
  let remainingValues = 10_000;
  let remainingText = 100_000;
  const ancestors = new Set<object>();

  function copy(value: unknown, path: string, depth: number): JsonValue {
    remainingValues -= 1;
    if (typeof value === "string") remainingText -= value.length;
    if (depth > 20 || remainingValues < 0 || remainingText < 0)
      throw new DomainInvariantError("out_of_range", `${path} exceeds JSON limits`, path);
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "object")
      throw new DomainInvariantError("invalid_value", `${path} must contain JSON values`, path);
    if (ancestors.has(value))
      throw new DomainInvariantError("invalid_value", `${path} must not contain cycles`, path);
    const array = Array.isArray(value);
    const prototype: unknown = Object.getPrototypeOf(value);
    if (!array && prototype !== Object.prototype && prototype !== null)
      throw new DomainInvariantError("invalid_value", `${path} must contain plain objects`, path);
    const keys = Reflect.ownKeys(value);
    if (keys.length > remainingValues + 1)
      throw new DomainInvariantError("out_of_range", `${path} exceeds JSON limits`, path);
    ancestors.add(value);
    const entries: [string, JsonValue][] = [];
    for (const key of keys) {
      if (array && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== "string" || !descriptor?.enumerable || !("value" in descriptor))
        throw new DomainInvariantError("invalid_value", `${path} must contain JSON data`, path);
      remainingText -= key.length;
      entries.push([key, copy(descriptor.value, `${path}.${key}`, depth + 1)]);
    }
    ancestors.delete(value);
    if (array) {
      if (entries.length !== value.length || entries.some(([key], index) => key !== String(index)))
        throw new DomainInvariantError("invalid_value", `${path} must be a dense JSON array`, path);
      return Object.freeze(entries.map(([, item]) => item));
    }
    return Object.freeze(Object.fromEntries(entries));
  }

  return copy(value, field, 0) as Readonly<Record<string, JsonValue>>;
}
