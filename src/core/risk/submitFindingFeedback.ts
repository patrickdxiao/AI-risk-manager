import {
  ApplicationError,
  requireNonBlank,
  requireTimestampOrder,
  type ClockPort,
  type IdGeneratorPort,
} from "../primitives.js";
import type { UnitOfWorkPort } from "../storageContracts.js";
import {
  createFindingFeedback,
  type SubmitFindingFeedbackInput,
  type SubmitFindingFeedbackResult,
} from "./findingFeedback.js";
import {
  createRiskAssessmentRecords,
  readCurrentFindings,
  readCurrentRiskAssessment,
} from "./riskAssessment.js";

/** Save feedback and its current projection atomically, preserving accepted records. */
export class SubmitFindingFeedback {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly ids: IdGeneratorPort,
    private readonly clock: ClockPort,
  ) {}

  execute(input: SubmitFindingFeedbackInput): Promise<SubmitFindingFeedbackResult> {
    return this.unitOfWork.execute(async (context) => {
      const id = requireNonBlank(input.id, "id", 200);
      const existing = await context.findingFeedback.findById(id);
      const feedback = createFindingFeedback({
        ...input,
        id,
        createdAt: existing?.createdAt ?? this.clock.now(),
      });
      if (existing !== undefined) {
        if (JSON.stringify(createFindingFeedback(existing)) !== JSON.stringify(feedback))
          throw new ApplicationError(
            "finding_feedback_conflict",
            "Feedback ID already records a different action",
            "id",
          );
        return Object.freeze({ status: "existing", feedback: existing });
      }
      const finding = await context.findings.findById(feedback.findingId);
      if (finding?.id !== feedback.findingId)
        throw new ApplicationError("finding_not_found", "Finding does not exist", "findingId");
      requireTimestampOrder(finding.createdAt, feedback.createdAt, "createdAt");
      for (const prior of await context.findingFeedback.findCurrentByFindingId(finding.id))
        requireTimestampOrder(prior.createdAt, feedback.createdAt, "createdAt");
      await context.findingFeedback.add(feedback);
      const submitted = await readCurrentFindings(context, finding.sprintId, finding.taskId);
      // An old finding stays auditable without replacing a newer assessment.
      if (submitted?.findings.some((item) => item.id === finding.id) === true) {
        const assessment = await readCurrentRiskAssessment(context, submitted);
        if (assessment !== undefined) {
          const previous = await context.risks.findLatestSnapshot(finding.sprintId, finding.taskId);
          const records = createRiskAssessmentRecords({
            sprintId: finding.sprintId,
            ...(finding.taskId === undefined ? {} : { taskId: finding.taskId }),
            assessment,
            ...(previous === undefined ? {} : { previous }),
            cause: { type: "feedback", feedbackId: feedback.id },
            now: feedback.createdAt,
            ids: this.ids,
          });
          await context.risks.addSnapshot(records.snapshot);
          if (records.transition !== undefined)
            await context.risks.addTransition(records.transition);
        }
      }
      return Object.freeze({ status: "recorded", feedback });
    });
  }
}
