import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { InvestigationRuntimeError } from "../../core/investigation/executeInvestigation.js";
import type {
  InvestigationRuntimePort,
  InvestigationRuntimeRun,
  InvestigationStructuredResult,
  RunInvestigationInput,
} from "../../core/investigation/investigationModel.js";
import { investigationResultSchema } from "../../contracts/investigationResult.js";
import { AttemptCredentials, dedicatedAgentId } from "./attemptCredentials.js";
import {
  OpenClawCapabilityPolicyError,
  OpenClawInvalidOutputError,
  SUPPORTED_OPENCLAW_VERSION,
  verifyEffectiveInvestigatorTools,
  buildInvestigatorPrompt,
  INVESTIGATOR_PROMPT_VERSION,
  INVESTIGATOR_RESULT_VERSION,
} from "./openClawProtocol.js";

const MAX_OUTPUT_BYTES = 2_097_152;
export interface OpenClawExecOptions {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
}
export type OpenClawRunner = (
  executable: string,
  argv: readonly string[],
  options: OpenClawExecOptions,
) => Promise<string>;
export interface OpenClawCliAdapterOptions {
  readonly investigationAgentId: string;
  readonly credentialsDirectory: string;
  readonly executable?: string;
  readonly runner?: OpenClawRunner;
}

/** Gateway RPC only: the ordinary agent CLI can fall back to a different embedded tool policy. */
export class OpenClawCliAdapter implements InvestigationRuntimePort {
  private readonly credentials: AttemptCredentials;
  private readonly options: OpenClawCliAdapterOptions;
  constructor(options: OpenClawCliAdapterOptions) {
    this.options = Object.freeze({
      ...options,
      investigationAgentId: dedicatedAgentId(options.investigationAgentId),
    });
    this.credentials = new AttemptCredentials(
      options.credentialsDirectory,
      options.investigationAgentId,
    );
  }
  async runInvestigation(input: RunInvestigationInput): Promise<InvestigationRuntimeRun> {
    const { attemptId, attemptToken, prompt, signal, timeoutMs } = input;
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 600_000 ||
      typeof prompt !== "string" ||
      prompt.length === 0 ||
      Buffer.byteLength(prompt) > 65_536 ||
      prompt.includes(attemptToken)
    )
      throw new OpenClawCapabilityPolicyError();
    const deadline = Date.now() + timeoutMs;
    const sessionKey = `agent:${this.options.investigationAgentId}:risk:${randomUUID()}`;
    const runId = randomUUID();
    let remove: (() => void) | undefined;
    let started = false;
    const remaining = () => Math.max(1, deadline - Date.now());
    try {
      if (signal.aborted) throw new InvestigationRuntimeError("runtime_failure", true);
      const version = await this.invoke(["--version"], Math.min(10_000, remaining()), signal);
      if (
        !new RegExp(
          `^OpenClaw ${SUPPORTED_OPENCLAW_VERSION.replaceAll(".", "\\.")}(?: |$)`,
          "u",
        ).test(version.trim())
      )
        throw new OpenClawCapabilityPolicyError();
      remove = this.credentials.save({
        sessionKey,
        attemptId,
        token: attemptToken,
        expiresAt: deadline,
      });
      const created = object(
        await this.rpc(
          "sessions.create",
          { key: sessionKey, agentId: this.options.investigationAgentId, emitCommandHooks: false },
          Math.min(10_000, remaining()),
          signal,
        ),
      );
      if (
        created["ok"] !== true ||
        created["key"] !== sessionKey ||
        created["runStarted"] === true ||
        typeof created["sessionId"] !== "string" ||
        created["sessionId"].length === 0
      )
        throw new OpenClawCapabilityPolicyError();
      const sessionId = created["sessionId"];
      verifyEffectiveInvestigatorTools(
        await this.rpc(
          "tools.effective",
          { agentId: this.options.investigationAgentId, sessionKey },
          Math.min(10_000, remaining()),
          signal,
        ),
        this.options.investigationAgentId,
      );
      if ((signal.aborted as boolean) || Date.now() >= deadline)
        throw new InvestigationRuntimeError("runtime_failure", true);
      started = true;
      const result = await this.rpc(
        "agent",
        {
          agentId: this.options.investigationAgentId,
          sessionKey,
          sessionId,
          idempotencyKey: runId,
          message: buildInvestigatorPrompt(prompt),
          deliver: false,
          thinking: "low",
          timeout: Math.max(1, Math.floor(remaining() / 1_000)),
        },
        remaining(),
        signal,
        true,
      );
      const run = decodeRun(result);
      if (run.sessionId !== sessionId || run.runId !== runId)
        throw new OpenClawCapabilityPolicyError();
      started = false;
      return Object.freeze({
        ...run,
        sessionKey,
        runtimeVersion: SUPPORTED_OPENCLAW_VERSION,
        promptVersion: INVESTIGATOR_PROMPT_VERSION,
        resultSchemaVersion: INVESTIGATOR_RESULT_VERSION,
      });
    } catch (error) {
      if (error instanceof InvestigationRuntimeError) throw error;
      throw new InvestigationRuntimeError("runtime_unavailable", true);
    } finally {
      // Remove local authority first. Remote abort is best effort and never proves settled usage.
      try {
        revokeCredentials(remove);
      } finally {
        if (started)
          await this.rpc("chat.abort", { sessionKey, runId }, 1_000).catch(() => undefined);
      }
    }
  }
  private async rpc(
    method: string,
    params: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
    final = false,
  ): Promise<unknown> {
    const text = await this.invoke(
      [
        "gateway",
        "call",
        method,
        "--json",
        "--timeout",
        String(timeoutMs),
        "--params",
        JSON.stringify(params),
        ...(final ? ["--expect-final"] : []),
      ],
      timeoutMs,
      signal,
    );
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new OpenClawInvalidOutputError();
    }
  }
  private async invoke(
    argv: readonly string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<string> {
    if (signal?.aborted === true) throw new InvestigationRuntimeError("runtime_failure", true);
    const text = await (this.options.runner ?? systemOpenClawRunner)(
      this.options.executable ?? "openclaw",
      argv,
      { timeoutMs, maxOutputBytes: MAX_OUTPUT_BYTES, ...(signal === undefined ? {} : { signal }) },
    );
    if (Buffer.byteLength(text) > MAX_OUTPUT_BYTES) throw new OpenClawInvalidOutputError();
    return text;
  }
}

/** Bound local waiting and terminate the CLI process group, including OpenClaw's launcher child. */
export const systemOpenClawRunner: OpenClawRunner = (executable, argv, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, argv, {
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    let bytes = 0;
    const chunks: Buffer[] = [];
    const fail = (oversized = false) => {
      if (settled) return;
      settled = true;
      try {
        if (process.platform !== "win32" && child.pid !== undefined)
          process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* The process may have exited while its output was draining. */
      }
      cleanup();
      child.stdout.destroy();
      child.stderr.destroy();
      reject(
        new InvestigationRuntimeError(
          oversized ? "invalid_runtime_result" : "runtime_unavailable",
          !oversized,
        ),
      );
    };
    const abort = () => {
      fail();
    };
    const timer = setTimeout(abort, options.timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted === true) fail();
    const collect = (chunk: Buffer, stdout: boolean) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > options.maxOutputBytes) {
        fail(true);
        return;
      }
      if (stdout) chunks.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      collect(chunk, true);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      collect(chunk, false);
    });
    child.on("error", abort);
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        fail();
        return;
      }
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });

const measured = z.number().nonnegative();
const counter = measured.int().max(Number.MAX_SAFE_INTEGER);
const runSchema = z.object({
  runId: z.string().min(1).max(512),
  status: z.literal("ok"),
  result: z.object({
    payloads: z
      .array(z.object({ text: z.string() }))
      .min(1)
      .max(20),
    meta: z.object({
      durationMs: measured.optional(),
      aborted: z.literal(false).optional(),
      agentMeta: z.object({
        sessionId: z.string().min(1).max(512),
        provider: z.string().min(1).max(512).optional(),
        model: z.string().min(1).max(512).optional(),
        usage: z
          .object({
            input: counter.optional(),
            output: counter.optional(),
            total: counter.optional(),
          })
          .optional(),
      }),
    }),
  }),
});
function decodeRun(value: unknown): InvestigationRuntimeRun {
  const parsed = runSchema.safeParse(value);
  if (!parsed.success) throw new OpenClawInvalidOutputError();
  const { result, runId } = parsed.data;
  const { agentMeta, durationMs } = result.meta;
  const usage = agentMeta.usage;
  let structuredResult: InvestigationStructuredResult | undefined;
  try {
    const answer = investigationResultSchema.safeParse(
      JSON.parse(result.payloads.map((item) => item.text).join("\n")) as unknown,
    );
    // JSON removes optional undefined keys to match exact core optionals.
    if (answer.success)
      structuredResult = JSON.parse(JSON.stringify(answer.data)) as InvestigationStructuredResult;
  } catch {
    /* Keep valid run telemetry even when the model's answer is rejected. */
  }
  return Object.freeze({
    runId,
    sessionId: agentMeta.sessionId,
    ...(agentMeta.provider === undefined ? {} : { provider: agentMeta.provider }),
    ...(agentMeta.model === undefined ? {} : { model: agentMeta.model }),
    ...(durationMs === undefined ? {} : { latencyMs: durationMs }),
    ...(usage === undefined
      ? {}
      : {
          usage: Object.freeze({
            ...(usage.input === undefined ? {} : { inputTokens: usage.input }),
            ...(usage.output === undefined ? {} : { outputTokens: usage.output }),
            ...(usage.total === undefined ? {} : { totalTokens: usage.total }),
          }),
        }),
    ...(structuredResult === undefined ? {} : { structuredResult }),
  });
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new OpenClawInvalidOutputError();
  return value as Record<string, unknown>;
}

function revokeCredentials(remove: (() => void) | undefined): void {
  try {
    remove?.();
  } catch {
    throw new InvestigationRuntimeError("runtime_failure", false);
  }
}
