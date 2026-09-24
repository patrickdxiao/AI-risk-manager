export type RepositoryId = string;
export type SprintId = string;
export type TaskId = string;
export type EvidenceEventId = string;
export type EvidenceItemId = string;
export type InvestigationId = string;
export type FindingId = string;
export type FindingFeedbackId = string;
export type UtcTimestamp = string;

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
  | "invalid_transition";

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
