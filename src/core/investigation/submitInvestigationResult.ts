import { createHash } from "node:crypto";
import type { EvidenceItem } from "../evidence/evidenceModel.js";
import {
  ApplicationError,
  DomainInvariantError,
  normalizeStringList,
  requireFiniteRange,
  requireNonBlank,
  requireUtcTimestamp,
  type ClockPort,
  type IdGeneratorPort,
} from "../primitives.js";
import {
  createRiskAssessmentRecords,
  readCurrentFindings,
  readCurrentRiskAssessment,
} from "../risk/riskAssessment.js";
import type { RiskSnapshot, RiskTransition } from "../risk/riskModel.js";
import type {
  SubmittedInvestigationResult,
  TransactionContext,
  UnitOfWorkPort,
} from "../storageContracts.js";
import {
  assertExecutionOwnership,
  assertRepositoryScope,
  authenticateAttempt,
  canReadAcceptedInvestigation,
} from "./attemptAuthority.js";
import {
  evidenceInScope,
  planningDigest,
  selectPlanningContext,
  type PlanningContext,
} from "./evidenceScope.js";
import {
  createFinding,
  createFindingEvidence,
  validateFindingRisk,
  type Finding,
  type FindingEvidence,
  type EvidenceCitation,
} from "./findingModel.js";
import {
  completeInvestigation,
  normalizeInvestigationUsage,
  type Investigation,
  type InvestigationAttempt,
  type InvestigationStructuredResult,
  type InvestigationUsage,
  type RuntimeFindingDraft,
} from "./investigationModel.js";

const MAX_NEW_FINDINGS = 20;
const MAX_CITATIONS = 100;
const MAX_EXAMINED_FINDINGS = 1_000;
const MAX_RECEIPT_FINDINGS = 2_000;
const MAX_RECEIPT_BYTES = 2_000_000;

export interface SubmitInvestigationResultInput {
  readonly token: string;
  readonly result: InvestigationStructuredResult;
  readonly usage?: InvestigationUsage;
}

/** Safe for the submitting attempt; the full local receipt may retain private older findings. */
export interface InvestigationAcceptance {
  readonly investigationId: string;
  readonly resultDigest: string;
  readonly completedAt: string;
}

export class SubmitInvestigationResult {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly ids: IdGeneratorPort,
    private readonly clock: ClockPort,
  ) {}

  async execute(input: SubmitInvestigationResultInput): Promise<InvestigationAcceptance> {
    const token = input.token;
    const normalized = normalizeAnswer(input.result);
    const reportedUsage = normalizeInvestigationUsage(input.usage);
    return this.unitOfWork.execute(async (store) => {
      const { investigation, attempt } = await authenticateAttempt(store, token);
      await assertRepositoryScope(store, attempt);
      const answer = normalizeAnswer(normalized, investigation.taskId);
      const semanticAnswer = JSON.stringify([investigation.id, answer]);
      if (semanticAnswer.includes(token))
        throw new DomainInvariantError(
          "invalid_value",
          "Answers must not contain attempt credentials",
          "result",
        );
      const resultDigest = `sha256:${createHash("sha256").update(semanticAnswer).digest("hex")}`;
      const existing = await store.investigations.findSubmittedResult(investigation.id);
      if (existing !== undefined) {
        if (
          investigation.executionAttemptId !== attempt.id ||
          existing.investigation.executionAttemptId !== attempt.id ||
          attempt.status !== "succeeded"
        )
          throw leaseLost();
        if (existing.resultDigest !== resultDigest)
          throw new ApplicationError(
            "investigation_result_conflict",
            "Investigation already has a different answer",
            "result",
          );
        return acceptance(existing);
      }
      const now = requireUtcTimestamp(this.clock.now(), "now");
      await assertExecutionOwnership(store, investigation, attempt.id, now);
      if (attempt.authority.planningDigest !== (await planningDigest(store, investigation)))
        throw new ApplicationError(
          "investigation_input_changed",
          "Planning inputs changed during the investigation",
          "result",
        );
      const plan = await selectPlanningContext(store, investigation);
      const taskIds = new Set(plan.tasks.map((task) => task.id));
      for (const item of [
        ...answer.findings,
        ...(answer.question === undefined ? [] : [answer.question]),
      ])
        if (item.taskId !== undefined && !taskIds.has(item.taskId))
          throw new ApplicationError(
            "task_scope_mismatch",
            "Result task is outside the investigation scope",
            "taskId",
          );
      const available = await citedEvidence(
        store,
        answer.findings.flatMap((item) => item.evidenceCitations),
        investigation,
        attempt,
        plan,
      );
      const created = answer.findings.map((draft) =>
        createFinding(
          {
            ...draft,
            id: this.ids.next(),
            investigationId: investigation.id,
            sprintId: investigation.sprintId,
            createdAt: now,
          },
          available,
        ),
      );
      const findings = created.map((item) => item.finding);
      const citations = created.flatMap((item) => item.citations);
      const previous = new Map<string, Finding>();
      const previousCitations = new Map<string, readonly FindingEvidence[]>();
      const scopes =
        investigation.taskId === undefined ? [undefined, ...taskIds] : [investigation.taskId];
      for (const taskId of scopes) {
        const receipt = await readCurrentFindings(store, investigation.sprintId, taskId);
        for (const finding of receipt?.findings ?? []) {
          previous.set(finding.id, finding);
          if (previous.size > MAX_RECEIPT_FINDINGS) throw receiptTooLarge();
          previousCitations.set(
            finding.id,
            receipt?.citations.filter((item) => item.findingId === finding.id) ?? [],
          );
        }
      }
      const examined = new Set(answer.examinedFindingIds);
      const assessedScopes = new Set(findings.map((item) => item.taskId));
      for (const id of examined) {
        const finding = previous.get(id);
        if (finding === undefined || !assessedScopes.has(finding.taskId))
          throw new ApplicationError(
            "invalid_coverage",
            "Examined findings require a current finding and replacement assessment in the same scope",
            "examinedFindingIds",
          );
        const origin = await store.investigations.findById(finding.investigationId);
        if (!(await canReadAcceptedInvestigation(store, origin, attempt.authority.repositoryIds)))
          throw new ApplicationError(
            "evidence_scope_mismatch",
            "The finding's original authority is outside this attempt",
            "examinedFindingIds",
          );
        await citedEvidence(store, previousCitations.get(id) ?? [], investigation, attempt, plan);
      }
      // Carry forward untouched scopes and unresolved risks, including uncertainty, without disclosure.
      const retained = [...previous.values()].filter(
        (finding) =>
          !examined.has(finding.id) &&
          (!assessedScopes.has(finding.taskId) || finding.state !== "healthy"),
      );
      const allFindings = [...findings, ...retained];
      if (allFindings.length > MAX_RECEIPT_FINDINGS) throw receiptTooLarge();
      const usage = reportedUsage ?? attempt.usage;
      const completed = completeInvestigation(investigation, {
        completedAt: now,
        ...(usage === undefined ? {} : { usage }),
      });
      const acceptedFields = {
        resultDigest,
        investigation: completed,
        findings: Object.freeze(allFindings),
        citations: Object.freeze([
          ...citations,
          ...retained.flatMap((finding) => previousCitations.get(finding.id) ?? []),
        ]),
        ...(retained.length === 0
          ? {}
          : { retainedFindingIds: Object.freeze(retained.map((finding) => finding.id)) }),
      };
      const planningChecks = new Map([[investigation.id, Promise.resolve(true)]]);
      const riskSnapshots: RiskSnapshot[] = [],
        riskTransitions: RiskTransition[] = [];
      for (const taskId of new Set(allFindings.map((finding) => finding.taskId))) {
        const scoped = allFindings.filter((finding) => finding.taskId === taskId);
        const representative = scoped[0];
        if (representative === undefined) continue;
        const previous = await store.risks.findLatestSnapshot(investigation.sprintId, taskId);
        const assessment = await readCurrentRiskAssessment(
          store,
          { ...acceptedFields, findings: scoped, riskSnapshots: [], riskTransitions: [] },
          planningChecks,
        );
        const records = createRiskAssessmentRecords({
          sprintId: investigation.sprintId,
          ...(taskId === undefined ? {} : { taskId }),
          assessment,
          ...(previous === undefined ? {} : { previous }),
          cause: { type: "finding", findingId: representative.id },
          now,
          ids: this.ids,
        });
        riskSnapshots.push(records.snapshot);
        if (records.transition !== undefined) riskTransitions.push(records.transition);
      }
      const receipt: SubmittedInvestigationResult = Object.freeze({
        ...acceptedFields,
        riskSnapshots: Object.freeze(riskSnapshots),
        riskTransitions: Object.freeze(riskTransitions),
        ...(answer.question === undefined
          ? {}
          : {
              question: Object.freeze({
                ...answer.question,
                id: requireNonBlank(this.ids.next(), "question.id", 200),
              }),
            }),
      });
      if (Buffer.byteLength(JSON.stringify(receipt)) > MAX_RECEIPT_BYTES) throw receiptTooLarge();
      for (const finding of findings) await store.findings.add(finding);
      for (const citation of citations) await store.findings.addEvidence(citation);
      for (const snapshot of riskSnapshots) await store.risks.addSnapshot(snapshot);
      for (const transition of riskTransitions) await store.risks.addTransition(transition);
      await store.investigations.save(completed);
      await store.investigations.saveAttempt(
        Object.freeze({
          ...attempt,
          status: "succeeded",
          completedAt: now,
          durationMs: Date.parse(now) - Date.parse(attempt.startedAt),
          terminalReason: "submitted",
          ...(completed.usage === undefined ? {} : { usage: completed.usage }),
        }),
      );
      if (attempt.dispatchTriggerId !== undefined) {
        const dispatch = await store.triggerDispatches.findByTriggerId(attempt.dispatchTriggerId);
        if (dispatch === undefined) throw leaseLost();
        const final = {
          ...dispatch,
          status: "completed" as const,
          updatedAt: now,
          completedAt: now,
        };
        delete final.leaseExpiresAt;
        if (!(await store.triggerDispatches.saveFenced(final, dispatch.leaseVersion, "leased")))
          throw leaseLost();
      }
      await store.investigations.saveSubmittedResult(receipt);
      return acceptance(receipt);
    });
  }
}

async function citedEvidence(
  store: TransactionContext,
  citations: readonly { readonly evidenceId: string }[],
  investigation: Investigation,
  attempt: InvestigationAttempt,
  plan: PlanningContext,
): Promise<ReadonlyMap<string, EvidenceItem>> {
  const evidence = new Map<string, EvidenceItem>();
  for (const { evidenceId } of citations) {
    if (evidence.has(evidenceId)) continue;
    const item = await store.evidence.findById(evidenceId);
    if (item?.id !== evidenceId)
      throw new ApplicationError(
        "evidence_not_found",
        "Cited evidence is unavailable",
        "evidenceCitations",
      );
    if (!evidenceInScope(item, investigation, attempt, plan))
      throw new ApplicationError(
        "evidence_scope_mismatch",
        "Cited evidence is outside the attempt scope",
        "evidenceCitations",
      );
    evidence.set(evidenceId, item);
  }
  return evidence;
}

/** Normalize only supported bounded fields; telemetry and incidental object key order are excluded. */
function normalizeAnswer(
  input: InvestigationStructuredResult,
  taskId?: string,
): InvestigationStructuredResult {
  if (!["1"].includes(input.version) || "completedTasks" in input || "needsConfirmation" in input)
    throw new DomainInvariantError(
      "invalid_value",
      "Expected result version 1 without task mutations",
      "result",
    );
  if (
    !Array.isArray(input.findings) ||
    input.findings.length === 0 ||
    input.findings.length > MAX_NEW_FINDINGS
  )
    throw new DomainInvariantError("out_of_range", "Expected 1-20 findings", "findings");
  const findings = input.findings
    .map((draft: RuntimeFindingDraft) => {
      const { state, riskType } = draft;
      validateFindingRisk(state, riskType);
      if (!Array.isArray(draft.evidenceCitations) || draft.evidenceCitations.length > MAX_CITATIONS)
        throw new DomainInvariantError(
          "out_of_range",
          "A finding may cite at most 100 records",
          "evidenceCitations",
        );
      const evidenceCitations = draft.evidenceCitations
        .map((item: EvidenceCitation) => {
          const normalized = createFindingEvidence({
            findingId: "normalization",
            evidenceId: item.evidenceId,
            ...(item.note === undefined ? {} : { note: item.note }),
          });
          return Object.freeze({
            evidenceId: normalized.evidenceId,
            ...(normalized.note === undefined ? {} : { note: normalized.note }),
          });
        })
        .sort((left, right) => compare(left.evidenceId, right.evidenceId));
      if (
        new Set(evidenceCitations.map((item) => item.evidenceId)).size !== evidenceCitations.length
      )
        throw new DomainInvariantError(
          "duplicate_reference",
          "Evidence citations must be unique",
          "evidenceCitations",
        );
      const fields: Partial<
        Record<"uncertainty" | "recommendedUserAction" | "nextCheckCondition", string>
      > = {};
      for (const field of ["uncertainty", "recommendedUserAction", "nextCheckCondition"] as const)
        if (draft[field] !== undefined) fields[field] = requireNonBlank(draft[field], field, 4_000);
      const target = draft.taskId ?? taskId;
      return Object.freeze({
        ...(target === undefined ? {} : { taskId: requireNonBlank(target, "taskId", 200) }),
        state,
        ...(riskType === undefined ? {} : { riskType }),
        confidence: requireFiniteRange(draft.confidence, "confidence", 0, 1),
        rationale: requireNonBlank(draft.rationale, "rationale"),
        ...fields,
        missingEvidence: Object.freeze(
          [
            ...new Set(normalizeStringList(draft.missingEvidence ?? [], "missingEvidence", 50)),
          ].sort(),
        ),
        ...(draft.nextCheckAt === undefined
          ? {}
          : { nextCheckAt: requireUtcTimestamp(draft.nextCheckAt, "nextCheckAt") }),
        evidenceCitations: Object.freeze(evidenceCitations),
      });
    })
    .sort((left, right) => compare(JSON.stringify(left), JSON.stringify(right)));
  let question: InvestigationStructuredResult["question"];
  if (input.question !== undefined) {
    if (!["scope", "completion_criteria"].includes(input.question.reason))
      throw new DomainInvariantError(
        "invalid_value",
        "Question reason is invalid",
        "question.reason",
      );
    const target = input.question.taskId ?? taskId;
    question = Object.freeze({
      question: requireNonBlank(input.question.question, "question.question"),
      reason: input.question.reason,
      ...(target === undefined ? {} : { taskId: requireNonBlank(target, "question.taskId", 200) }),
    });
  }
  return Object.freeze({
    version: "1",
    findings: Object.freeze(findings),
    examinedFindingIds: Object.freeze(
      [
        ...new Set(
          normalizeStringList(
            input.examinedFindingIds ?? [],
            "examinedFindingIds",
            MAX_EXAMINED_FINDINGS,
            200,
          ),
        ),
      ].sort(),
    ),
    ...(question === undefined ? {} : { question }),
  });
}

function acceptance(receipt: SubmittedInvestigationResult): InvestigationAcceptance {
  return Object.freeze({
    investigationId: receipt.investigation.id,
    resultDigest: receipt.resultDigest,
    completedAt: requireUtcTimestamp(receipt.investigation.completedAt ?? "", "completedAt"),
  });
}
function compare(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}
function receiptTooLarge(): DomainInvariantError {
  return new DomainInvariantError(
    "out_of_range",
    "Accepted result exceeds local receipt limits",
    "result",
  );
}
function leaseLost(): ApplicationError {
  return new ApplicationError(
    "execution_lease_lost",
    "The attempt no longer owns this investigation",
    "token",
  );
}
