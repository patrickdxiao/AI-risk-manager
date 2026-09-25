import { z } from "zod";

export const investigationIdSchema = z.string().trim().min(1).max(200);
export const investigationToolSchemas = {
  risk_get_context: z.object({}).strict(),
  risk_get_evidence: z
    .object({ evidenceIds: z.array(investigationIdSchema).min(1).max(50) })
    .strict(),
  risk_list_evidence: z
    .object({
      repositoryId: investigationIdSchema.optional(),
      limit: z.number().int().min(1).max(50).default(20),
    })
    .strict(),
  risk_inspect_git: z.object({ repositoryId: investigationIdSchema }).strict(),
} as const;
export type InvestigationToolName = keyof typeof investigationToolSchemas;
export const INVESTIGATOR_TOOL_NAMES = Object.freeze(
  Object.keys(investigationToolSchemas) as InvestigationToolName[],
);
