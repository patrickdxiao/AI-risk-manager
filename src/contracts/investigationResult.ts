import { z } from "zod";
import { investigationIdSchema } from "./investigationTools.js";

const text = (maximum = 4_000) => z.string().trim().min(1).max(maximum);
const citation = z
  .object({ evidenceId: investigationIdSchema, note: text(2_000).optional() })
  .strict();
const finding = z
  .object({
    taskId: investigationIdSchema.optional(),
    state: z.enum(["healthy", "uncertain", "at_risk", "blocked"]),
    riskType: z
      .enum([
        "stalled_work",
        "deadline_risk",
        "scope_drift",
        "dependency_blocker",
        "persistent_failure",
        "completion_unverified",
      ])
      .optional(),
    confidence: z.number().min(0).max(1),
    rationale: text(8_000),
    uncertainty: text().optional(),
    missingEvidence: z.array(text()).max(50).optional(),
    recommendedUserAction: text().optional(),
    nextCheckAt: z.iso.datetime({ precision: 3 }).optional(),
    nextCheckCondition: text().optional(),
    evidenceCitations: z.array(citation).max(100),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.state === "blocked" || value.state === "at_risk") && value.riskType === undefined)
      ctx.addIssue({ code: "custom", message: "A risk type is required", path: ["riskType"] });
    if (
      value.state !== "healthy" &&
      value.nextCheckAt === undefined &&
      value.nextCheckCondition === undefined
    )
      ctx.addIssue({
        code: "custom",
        message: "A next check is required",
        path: ["nextCheckCondition"],
      });
    if (
      value.evidenceCitations.length === 0 &&
      (value.state !== "uncertain" ||
        (value.uncertainty === undefined && !value.missingEvidence?.length))
    )
      ctx.addIssue({
        code: "custom",
        message: "Cite evidence or explain unavailable support",
        path: ["evidenceCitations"],
      });
    if (
      new Set(value.evidenceCitations.map((item) => item.evidenceId)).size !==
      value.evidenceCitations.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Citations must be unique",
        path: ["evidenceCitations"],
      });
  });

/** Transport validation; scope, provenance, freshness and acceptance remain core-owned. */
export const investigationResultSchema = z
  .object({
    version: z.literal("1"),
    findings: z.array(finding).min(1).max(20),
    examinedFindingIds: z.array(investigationIdSchema).max(1_000).optional(),
    question: z
      .object({
        question: text(8_000),
        reason: z.enum(["scope", "completion_criteria"]),
        taskId: investigationIdSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
