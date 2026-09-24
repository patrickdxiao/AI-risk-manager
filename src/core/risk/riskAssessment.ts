import { requiresRepositoryId } from "../evidence/evidenceModel.js";
import {
  getUserTaskTransitions,
  type Sprint,
  type Task,
  type TaskState,
} from "../planning/planningModel.js";
import {
  ApplicationError,
  DomainInvariantError,
  requireNonBlank,
  requireTimestampOrder,
  requireUtcTimestamp,
  type ClockPort,
  type IdGeneratorPort,
  type RiskState,
  type UtcTimestamp,
} from "../primitives.js";
import type {
  SubmittedInvestigationResult,
  TransactionContext,
  UnitOfWorkPort,
} from "../storageContracts.js";
import type { FindingFeedback } from "./findingFeedback.js";
import {
  aggregateRiskStates,
  projectCurrentRisk,
  type CurrentRiskAssessment,
  type RiskSnapshot,
  type RiskTransition,
  type RiskTransitionCause,
} from "./riskModel.js";

export interface ReadableRiskAssessment extends CurrentRiskAssessment {
  readonly assessedAt: UtcTimestamp;
  readonly evidenceIds: readonly string[];
  readonly unavailableEvidenceIds: readonly string[];
}

/** Select the newest applicable receipt; an unexamined task retains its own assessment. */
export async function readCurrentFindings(
  context: TransactionContext,
  sprintId: string,
  taskId?: string,
): Promise<SubmittedInvestigationResult | undefined> {
  const sprintResult = await context.investigations.findLatestSubmittedResult(sprintId);
  const taskResult =
    taskId === undefined
      ? undefined
      : await context.investigations.findLatestSubmittedResult(sprintId, taskId);
  const applicable = [sprintResult, taskResult].filter(
    (result): result is SubmittedInvestigationResult =>
      result !== undefined &&
      result.investigation.sprintId === sprintId &&
      (result.investigation.taskId === taskId ||
        (result.investigation.taskId === undefined &&
          result.findings.some((finding) => finding.taskId === taskId))),
  );
  applicable.sort(
    (left, right) =>
      Date.parse(right.investigation.completedAt ?? right.investigation.requestedAt) -
        Date.parse(left.investigation.completedAt ?? left.investigation.requestedAt) ||
      (left.investigation.id < right.investigation.id
        ? 1
        : left.investigation.id === right.investigation.id
          ? 0
          : -1),
  );
  const selected = applicable[0];
  if (selected === undefined) return undefined;
  const findings = selected.findings.filter(
    (finding) => finding.sprintId === sprintId && finding.taskId === taskId,
  );
  if (taskId === undefined && findings.length === 0) return undefined;
  return Object.freeze({ ...selected, findings: Object.freeze(findings) });
}

/** Read accepted local data without impersonating a model attempt or inferring completion. */
export async function readCurrentRiskAssessment(
  context: TransactionContext,
  submitted: SubmittedInvestigationResult | undefined,
): Promise<ReadableRiskAssessment | undefined> {
  if (submitted === undefined) return undefined;
  const feedback = new Map<string, readonly FindingFeedback[]>();
  let assessedAt = submitted.investigation.completedAt ?? submitted.investigation.requestedAt;
  for (const finding of submitted.findings) {
    const history = await context.findingFeedback.findCurrentByFindingId(finding.id);
    feedback.set(finding.id, history);
    for (const item of history)
      if (item.findingId === finding.id && Date.parse(item.createdAt) > Date.parse(assessedAt))
        assessedAt = item.createdAt;
  }
  const assessment = projectCurrentRisk(submitted.findings, feedback);
  const evidenceIds: string[] = [];
  const unavailableEvidenceIds: string[] = [];
  const cited = new Set(
    submitted.citations
      .filter((citation) => citation.findingId === assessment.finding?.id)
      .map((citation) => citation.evidenceId),
  );
  for (const id of cited) {
    const item = await context.evidence.findById(id);
    const available =
      item?.id === id &&
      (item.repositoryId === undefined
        ? !requiresRepositoryId(item)
        : (await context.repositories.findById(item.repositoryId))?.id === item.repositoryId);
    (available ? evidenceIds : unavailableEvidenceIds).push(id);
  }
  // Lost support cannot certify health; retain a previously reported blocker alongside its gap.
  const state =
    assessment.state === "healthy" &&
    (unavailableEvidenceIds.length > 0 || evidenceIds.length === 0)
      ? "uncertain"
      : assessment.state;
  return Object.freeze({
    ...assessment,
    state,
    assessedAt,
    evidenceIds: Object.freeze(evidenceIds),
    unavailableEvidenceIds: Object.freeze(unavailableEvidenceIds),
  });
}

/** Record an assessment on every accepted update, and a transition only when its state changes. */
export function createRiskAssessmentRecords(input: {
  readonly sprintId: string;
  readonly taskId?: string;
  readonly assessment: CurrentRiskAssessment;
  readonly previous?: RiskSnapshot;
  readonly cause: RiskTransitionCause;
  readonly now: string;
  readonly ids: IdGeneratorPort;
}): { readonly snapshot: RiskSnapshot; readonly transition?: RiskTransition } {
  const scope = {
    sprintId: requireNonBlank(input.sprintId, "sprintId", 200),
    ...(input.taskId === undefined ? {} : { taskId: requireNonBlank(input.taskId, "taskId", 200) }),
  };
  const now = requireUtcTimestamp(input.now, "now");
  if (input.previous !== undefined) {
    if (input.previous.sprintId !== scope.sprintId || input.previous.taskId !== scope.taskId)
      throw new DomainInvariantError(
        "scope_mismatch",
        "Previous risk belongs to another scope",
        "previous",
      );
    requireTimestampOrder(input.previous.createdAt, now, "now");
  }
  const snapshot: RiskSnapshot = Object.freeze({
    ...scope,
    id: requireNonBlank(input.ids.next(), "id", 200),
    state: input.assessment.state,
    ...(input.assessment.finding === undefined ? {} : { findingId: input.assessment.finding.id }),
    createdAt: now,
  });
  if (input.previous?.state === snapshot.state) return Object.freeze({ snapshot });
  const transition: RiskTransition = Object.freeze({
    ...scope,
    id: requireNonBlank(input.ids.next(), "id", 200),
    from: input.previous?.state ?? null,
    to: snapshot.state,
    cause: Object.freeze({ ...input.cause }),
    occurredAt: now,
  });
  return Object.freeze({ snapshot, transition });
}

export interface SprintOverviewTask extends Task {
  readonly allowedUserTransitions: readonly TaskState[];
  readonly riskState: RiskState;
  readonly assessment?: ReadableRiskAssessment;
}

export interface SprintOverview {
  readonly sprint: Sprint;
  readonly tasks: readonly SprintOverviewTask[];
  readonly totalPoints: number;
  readonly confirmedDonePoints: number;
  readonly overallRisk: RiskState;
  /** Findings explicitly about the sprint, separate from the task rollup. */
  readonly sprintRisk?: ReadableRiskAssessment;
  readonly generatedAt: UtcTimestamp;
}

/** Current sprint work plus earlier unfinished work, ordered by risk, dependencies, and deadline. */
export class GetSprintOverview {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly clock: ClockPort,
  ) {}

  execute(sprintIdInput: string): Promise<SprintOverview> {
    const sprintId = requireNonBlank(sprintIdInput, "sprintId", 200);
    return this.unitOfWork.execute(async (context) => {
      const sprint = await context.planning.findSprintById(sprintId);
      if (sprint === undefined)
        throw new ApplicationError("sprint_not_found", "Sprint does not exist", "sprintId");
      const now = requireUtcTimestamp(this.clock.now(), "now");
      const sprints = new Map(
        (await context.planning.listSprints()).map((item) => [item.id, item]),
      );
      const tasks = new Map(
        (await context.planning.findOpenTasks())
          .filter((task) => {
            const owner = sprints.get(task.sprintId);
            return (
              task.sprintId === sprintId ||
              (owner !== undefined &&
                (owner.state === "completed" ||
                  Date.parse(owner.startAt) <= Date.parse(sprint.startAt)))
            );
          })
          .map((task) => [task.id, task]),
      );
      if (sprint.state !== "completed" && Date.parse(sprint.endAt) > Date.parse(now))
        for (const task of await context.planning.findTasksBySprintId(sprintId))
          tasks.set(task.id, task);
      const dependents = new Map<string, number>();
      for (const task of tasks.values())
        if (task.state !== "done")
          for (const id of task.dependencyIds) dependents.set(id, (dependents.get(id) ?? 0) + 1);
      const rows: SprintOverviewTask[] = [];
      for (const task of tasks.values()) {
        const assessment = await readCurrentRiskAssessment(
          context,
          await readCurrentFindings(context, task.sprintId, task.id),
        );
        rows.push(
          Object.freeze({
            ...task,
            allowedUserTransitions: getUserTaskTransitions(task.state),
            riskState: assessment?.state ?? "uncertain",
            ...(assessment === undefined ? {} : { assessment }),
          }),
        );
      }
      const priority: Record<RiskState, number> = {
        blocked: 0,
        at_risk: 1,
        uncertain: 2,
        healthy: 3,
      };
      rows.sort(
        (left, right) =>
          priority[left.riskState] - priority[right.riskState] ||
          (dependents.get(right.id) ?? 0) - (dependents.get(left.id) ?? 0) ||
          Date.parse(left.endAt) - Date.parse(right.endAt) ||
          left.id.localeCompare(right.id),
      );
      const sprintRisk = await readCurrentRiskAssessment(
        context,
        await readCurrentFindings(context, sprintId),
      );
      return Object.freeze({
        sprint,
        tasks: Object.freeze(rows),
        totalPoints: rows.reduce((sum, task) => sum + task.points, 0),
        confirmedDonePoints: rows.reduce(
          (sum, task) => sum + (task.state === "done" ? task.points : 0),
          0,
        ),
        overallRisk: aggregateRiskStates([
          ...rows.map((task) => task.riskState),
          ...(sprintRisk === undefined ? [] : [sprintRisk.state]),
        ]),
        ...(sprintRisk === undefined ? {} : { sprintRisk }),
        generatedAt: now,
      });
    });
  }
}
