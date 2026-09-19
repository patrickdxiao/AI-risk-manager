import { describe, expectTypeOf, it } from "vitest";
import type { EvidenceItem, EvidenceQuery } from "../../../src/core/evidence/evidenceModel.js";
import type { CreateFindingInput, Finding } from "../../../src/core/investigation/findingModel.js";
import type {
  Investigation,
  InvestigationAttempt,
} from "../../../src/core/investigation/investigationModel.js";
import type {
  CreateSprintInput,
  CreateTaskInput,
  Sprint,
} from "../../../src/core/planning/planningModel.js";
import type { Repository } from "../../../src/core/repository/repositoryModel.js";
import type {
  FindingFeedback,
  SubmitFindingFeedbackInput,
} from "../../../src/core/risk/findingFeedback.js";

describe("planning without project grouping", () => {
  it("accepts a sprint and dependent task without a project or repository assignment", () => {
    expectTypeOf<{
      id: "sprint-2";
      startAt: "2026-09-21T00:00:00Z";
      endAt: "2026-10-02T23:59:59Z";
      reviewCadenceMinutes: 30;
      pointTarget: 8;
      createdAt: "2026-09-18T00:00:00Z";
    }>().toExtend<CreateSprintInput>();
    expectTypeOf<{
      id: "checkout-ui";
      sprintId: "sprint-2";
      title: "Show checkout totals";
      points: 3;
      dependencyIds: readonly ["payments-api-from-sprint-1"];
      createdAt: "2026-09-18T00:00:00Z";
    }>().toExtend<CreateTaskInput>();
  });

  it("allows reusable repository evidence and findings with multiple citations", () => {
    expectTypeOf<{
      id: "web";
      canonicalPath: "/approved/web";
      gitRoot: "/approved/web";
      identityDigest: "web-identity";
      registeredAt: "2026-09-18T00:00:00Z";
    }>().toExtend<Repository>();
    // A repository observation does not need a sprint or task assignment to be retained.
    expectTypeOf<{
      id: "web-observation";
      eventId: "capture-1";
      repositoryId: "web";
      source: "git";
      kind: "repository_snapshot";
      occurredAt: "2026-09-18T00:00:00Z";
      locator: "git:web";
      summary: "Captured repository metadata";
      digest: "snapshot-digest";
      privacyMode: "metadata_only";
      metadata: Record<string, never>;
    }>().toExtend<EvidenceItem>();
    expectTypeOf<{
      id: "checkout-finding";
      investigationId: "review-1";
      sprintId: "sprint-2";
      taskId: "checkout-ui";
      state: "uncertain";
      confidence: 0.3;
      rationale: "Repository metadata does not verify the checkout behavior";
      createdAt: "2026-09-18T00:00:00Z";
      evidenceCitations: readonly [
        { evidenceId: "web-observation" },
        { evidenceId: "payments-observation" },
      ];
    }>().toExtend<CreateFindingInput>();
  });

  it("keeps repository approval explicit and links corrections directly to findings", () => {
    type Authority = NonNullable<InvestigationAttempt["authority"]>;
    expectTypeOf<Authority>().toExtend<{
      readonly credentialHash: string;
      readonly repositoryIds: readonly string[];
      readonly planningDigest: string;
      readonly toolCalls: number;
      readonly reservedTokens: number;
    }>();
    expectTypeOf<{ repositoryId: "web"; limit: 20 }>().toExtend<EvidenceQuery>();
    expectTypeOf<{
      findingId: "checkout-finding";
      kind: "correct";
      correction: { statement: "The prerequisite was completed in the previous sprint" };
      actor: "developer";
      source: "dashboard";
    }>().toExtend<SubmitFindingFeedbackInput>();
  });

  it("removes project ownership from all planning, evidence, and review records", () => {
    type RecordKeys =
      | keyof Sprint
      | keyof CreateSprintInput
      | keyof Repository
      | keyof EvidenceItem
      | keyof EvidenceQuery
      | keyof Investigation
      | keyof InvestigationAttempt
      | keyof Finding
      | keyof FindingFeedback
      | keyof SubmitFindingFeedbackInput;
    expectTypeOf<Extract<RecordKeys, "projectId">>().toEqualTypeOf<never>();
  });
});
