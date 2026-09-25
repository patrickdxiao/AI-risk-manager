import { z } from "zod";

export const id = z.string().trim().min(1).max(200);
export const text = z.string().trim().min(1).max(8_000);
export const timestamp = z.string().max(30);
export const ids = z.array(id).max(1_000);
export const repositoryIds = z.array(id).max(20).default([]);
export const scope = { repositoryIds };
export const params = z.object({ id }).strict();
const taskFields = {
  title: text.max(500),
  description: text.optional(),
  points: z.number().int().positive(),
  state: z.enum(["planned", "in_progress", "needs_confirmation", "done"]).optional(),
  startAt: timestamp.optional(),
  endAt: timestamp.optional(),
  dependencyIds: ids.optional(),
  completionCriteria: z.array(text).max(100).optional(),
  pathHints: z.array(text).max(100).optional(),
};
export const sprintSettings = z
  .object({
    goal: text.optional(),
    assumptions: z.array(text).max(100).optional(),
    reviewCadenceMinutes: z.number().int().min(1).max(43_200).optional(),
  })
  .strict();
export const newSprint = sprintSettings.extend({
  startAt: timestamp,
  endAt: timestamp,
  pointTarget: z.number().int().min(0).default(0),
  reviewCadenceMinutes: z.number().int().min(1).max(43_200).default(30),
  state: z.enum(["planned", "active", "completed"]).default("active"),
  ...scope,
});
export const newTask = z.object({ ...taskFields, sprintId: id, ...scope }).strict();
export const taskEdit = z
  .object(taskFields)
  .partial()
  .extend({
    description: text.nullable().optional(),
    version: z.number().int().positive(),
    ...scope,
  })
  .strict();

/** JSON optional fields are omitted; preserve that distinction for exact domain input types. */
export function defined<T extends object>(value: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>;
  };
}
