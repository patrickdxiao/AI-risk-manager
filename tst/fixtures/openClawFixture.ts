import { mkdtempSync, realpathSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { newAttemptToken } from "../../src/core/investigation/attemptAuthority.js";
import { INVESTIGATOR_TOOL_NAMES } from "../../src/contracts/investigationTools.js";
import type { RunInvestigationInput } from "../../src/core/investigation/investigationModel.js";
export const agentId = "risk-investigator";
export const answer = {
  version: "1",
  findings: [
    {
      state: "uncertain",
      confidence: 0.5,
      rationale: "No verification is available",
      uncertainty: "Checks have not been observed",
      nextCheckCondition: "When a check is captured",
      evidenceCitations: [],
    },
  ],
};
export const inventory = () => ({
  agentId,
  groups: [
    {
      tools: INVESTIGATOR_TOOL_NAMES.map((id) => ({
        id,
        source: "plugin",
        pluginId: "development-risk",
      })),
    },
  ],
  notices: [],
});
export function openClawFixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "risk-openclaw-test-")));
  chmodSync(directory, 0o700);
  const input: RunInvestigationInput = {
    attemptId: "attempt",
    attemptToken: newAttemptToken("attempt", "fixture-secret"),
    prompt: JSON.stringify({ investigation: { sprintId: "sprint" }, evidenceIds: [] }),
    timeoutMs: 10_000,
    signal: new AbortController().signal,
  };
  return {
    directory,
    input,
    credential: {
      sessionKey: `agent:${agentId}:risk:${randomUUID()}`,
      attemptId: input.attemptId,
      token: input.attemptToken,
      expiresAt: Date.now() + 30_000,
    },
    cleanup: () => {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
