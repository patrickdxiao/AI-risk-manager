/** Display-only runtime metadata; never evidence or automatic proof of task completion. */
export interface AgentSession {
  readonly key: string;
  readonly agentId: string;
  readonly label: string;
  readonly kind: "agent" | "subagent";
  readonly state: "running" | "completed" | "failed" | "idle" | "stopped" | "unknown";
  readonly updatedAt: number | null;
  readonly parentSessionKey?: string;
  readonly model?: string;
  /** Latest reported context snapshot, not cumulative usage or cost. */
  readonly contextTokens?: number;
}
export interface AgentActivity {
  readonly status: "connected" | "disabled" | "unavailable";
  readonly sessions: readonly AgentSession[];
}
export interface AgentActivityPort {
  list(): Promise<AgentActivity>;
}
