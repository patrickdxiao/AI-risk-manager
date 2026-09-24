import {
  DomainInvariantError,
  requireNonBlank,
  requireUtcTimestamp,
  type FindingFeedbackId,
  type FindingId,
  type UtcTimestamp,
} from "../primitives.js";

const FEEDBACK_KINDS = ["confirm", "dismiss", "resolve", "correct"] as const;
export type FindingFeedbackKind = (typeof FEEDBACK_KINDS)[number];

interface FindingFeedbackCorrection {
  readonly statement: string;
}

export interface FindingFeedback {
  readonly id: FindingFeedbackId;
  readonly findingId: FindingId;
  readonly kind: FindingFeedbackKind;
  readonly note?: string;
  readonly correction?: FindingFeedbackCorrection;
  readonly actor: string;
  readonly source: string;
  readonly createdAt: UtcTimestamp;
}

/** A correction changes the displayed statement, never the accepted finding or its evidence. */
export function createFindingFeedback(input: FindingFeedback): FindingFeedback {
  if (!FEEDBACK_KINDS.includes(input.kind))
    throw new DomainInvariantError("invalid_value", "Feedback kind is invalid", "kind");
  if (input.kind === "correct" && input.correction === undefined)
    throw new DomainInvariantError(
      "required",
      "Correction feedback requires a statement",
      "correction",
    );
  if (input.kind !== "correct" && input.correction !== undefined)
    throw new DomainInvariantError(
      "invalid_value",
      "Only correction feedback may include a statement",
      "correction",
    );
  return Object.freeze({
    id: requireNonBlank(input.id, "id", 200),
    findingId: requireNonBlank(input.findingId, "findingId", 200),
    kind: input.kind,
    ...(input.note === undefined ? {} : { note: requireNonBlank(input.note, "note", 4_000) }),
    ...(input.correction === undefined
      ? {}
      : {
          correction: Object.freeze({
            statement: requireNonBlank(input.correction.statement, "correction.statement"),
          }),
        }),
    actor: requireNonBlank(input.actor, "actor", 200),
    source: requireNonBlank(input.source, "source", 200),
    createdAt: requireUtcTimestamp(input.createdAt, "createdAt"),
  });
}

/** The caller retains the ID across retries of the same feedback action. */
export type SubmitFindingFeedbackInput = Omit<FindingFeedback, "createdAt">;

export interface SubmitFindingFeedbackResult {
  readonly status: "recorded" | "existing";
  readonly feedback: FindingFeedback;
}
