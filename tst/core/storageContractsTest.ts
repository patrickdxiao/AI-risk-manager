import { describe, expect, expectTypeOf, it } from "vitest";
import {
  PlanningEntityAlreadyExistsError,
  RepositoryConflictError,
  type EvidenceIdentity,
  type InvestigationStore,
  type PlanningStore,
  type RepositoryStore,
  type SubmittedInvestigationResult,
} from "../../src/core/storageContracts.js";

describe("storage contracts", () => {
  it("identifies planning and registration conflicts without unrelated ownership", () => {
    expect(new PlanningEntityAlreadyExistsError("task", "checkout")).toMatchObject({
      name: "PlanningEntityAlreadyExistsError",
      entity: "task",
      id: "checkout",
      message: "task checkout already exists",
    });
    expect(new RepositoryConflictError("canonical_path", "/approved/web")).toMatchObject({
      name: "RepositoryConflictError",
      conflict: "canonical_path",
      value: "/approved/web",
      message: "repository canonical_path /approved/web already exists",
    });
  });

  it("identifies reusable repository evidence and separate non-repository contexts", () => {
    expectTypeOf<{
      repositoryId: "web";
      source: "git";
      kind: "commit";
      digest: "same-content";
    }>().toExtend<EvidenceIdentity>();
    expectTypeOf<{
      sprintId: "sprint-2";
      taskId: "checkout";
      source: "user";
      kind: "agent_claim";
      digest: "same-content";
    }>().toExtend<EvidenceIdentity>();
    expectTypeOf<keyof EvidenceIdentity>().toEqualTypeOf<
      "repositoryId" | "sprintId" | "taskId" | "source" | "kind" | "digest"
    >();
  });

  it("keeps planning, registered repositories, and active execution independent", () => {
    expectTypeOf<Parameters<PlanningStore["findActiveSprint"]>>().toEqualTypeOf<[]>();
    expectTypeOf<Parameters<RepositoryStore["list"]>>().toEqualTypeOf<[]>();
    expectTypeOf<Parameters<InvestigationStore["findActive"]>>().toEqualTypeOf<[now: string]>();
    expectTypeOf<
      Extract<keyof SubmittedInvestigationResult, "task" | "completedTaskIds" | "projectId">
    >().toEqualTypeOf<never>();
  });
});
