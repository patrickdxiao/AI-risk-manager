import { z } from "zod";
import type { AgentActivity, AgentActivityPort, AgentSession } from "../../core/agentActivity.js";
import { systemOpenClawRunner, type OpenClawRunner } from "./openClawCli.js";

const session = z.object({
  key: z.string().min(1).max(1024),
  label: z.string().max(1000).optional(),
  displayName: z.string().max(1000).optional(),
  updatedAt: z.number().int().nonnegative().nullable().optional(),
  hasActiveRun: z.boolean().optional(),
  abortedLastRun: z.boolean().optional(),
  spawnedBy: z.string().optional(),
  parentSessionKey: z.string().optional(),
  status: z.string().optional(),
});
const response = z.object({ sessions: z.array(session).max(100) });

/** Read metadata only. Coalesce polling and bound subprocess lifetime/output, including failures. */
export class OpenClawActivityAdapter implements AgentActivityPort {
  private cached: Promise<AgentActivity> | undefined;
  private expiresAt = 0;
  constructor(
    private readonly runner: OpenClawRunner = systemOpenClawRunner,
    private readonly now: () => number = Date.now,
    private readonly executable = "openclaw",
  ) {}
  list(): Promise<AgentActivity> {
    if (!this.cached || this.now() >= this.expiresAt) {
      this.expiresAt = this.now() + 15_000;
      this.cached = this.read();
    }
    return this.cached;
  }
  private async read(): Promise<AgentActivity> {
    try {
      const output = await this.runner(
        this.executable,
        [
          "gateway",
          "call",
          "sessions.list",
          "--json",
          "--timeout",
          "5000",
          "--params",
          JSON.stringify({
            limit: 30,
            includeGlobal: false,
            includeUnknown: false,
            includeDerivedTitles: false,
            includeLastMessage: false,
          }),
        ],
        { timeoutMs: 6000, maxOutputBytes: 262_144 },
      );
      if (Buffer.byteLength(output) > 262_144) throw new Error("Oversized activity response");
      const { sessions } = response.parse(JSON.parse(output) as unknown);
      return {
        status: "connected",
        sessions: sessions
          .filter((row) => !/^agent:[^:]+:risk:/u.test(row.key))
          .map(
            (row): AgentSession => ({
              key: row.key,
              agentId: row.key.split(":")[1] || "unknown",
              label: row.label || row.displayName || row.key,
              kind:
                row.spawnedBy || row.parentSessionKey || row.key.includes(":subagent:")
                  ? "subagent"
                  : "agent",
              state:
                row.hasActiveRun === true
                  ? "running"
                  : row.status === "done"
                    ? "completed"
                    : row.status === "failed" || row.status === "timeout"
                      ? "failed"
                      : row.abortedLastRun || row.status === "killed"
                        ? "stopped"
                        : row.hasActiveRun === false
                          ? "idle"
                          : "unknown",
              updatedAt: row.updatedAt ?? null,
            }),
          )
          .sort(
            (a, b) =>
              Number(b.state === "running") - Number(a.state === "running") ||
              (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
          ),
      };
    } catch {
      return { status: "unavailable", sessions: [] };
    }
  }
}
