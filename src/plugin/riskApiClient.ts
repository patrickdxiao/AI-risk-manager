import {
  INVESTIGATOR_TOOL_NAMES,
  type InvestigationToolName,
} from "../contracts/investigationTools.js";

export interface RiskPluginConfig {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
}

export type RiskApiClientErrorCode =
  | "invalid_config"
  | "timeout"
  | "unavailable"
  | "response_too_large"
  | "http_error"
  | "invalid_response";

/** Reports a public request failure category without response contents. */
export class RiskApiClientError extends Error {
  override readonly name = "RiskApiClientError";

  constructor(readonly code: RiskApiClientErrorCode) {
    super(`development-risk API request failed: ${code}`);
  }
}

export interface RiskApiClientOptions extends RiskPluginConfig {
  readonly fetch?: typeof fetch;
}

/** Calls only the authenticated loopback investigation-tool endpoint. */
export class RiskApiClient {
  private readonly baseUrl: URL;
  private readonly requestFetch: typeof fetch;

  private readonly options: RiskApiClientOptions;

  constructor(options: RiskApiClientOptions) {
    this.options = Object.freeze({ ...options });
    this.baseUrl = loopbackUrl(options.apiBaseUrl);
    if (!/^risk_attempt\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(options.token)) {
      throw new RiskApiClientError("invalid_config");
    }
    if (
      !Number.isInteger(options.timeoutMs) ||
      options.timeoutMs < 100 ||
      options.timeoutMs > 30_000
    ) {
      throw new RiskApiClientError("invalid_config");
    }
    if (
      !Number.isInteger(options.maxResponseBytes) ||
      options.maxResponseBytes < 1_024 ||
      options.maxResponseBytes > 2 * 1_024 * 1_024
    ) {
      throw new RiskApiClientError("invalid_config");
    }
    this.requestFetch = options.fetch ?? fetch;
  }

  /**
   * Call a scoped tool with bounded response size and deadline.
   * @param name - The registered risk tool to invoke.
   * @throws RiskApiClientError for rejected, unavailable, oversized, or malformed responses.
   */
  async invokeTool(
    name: InvestigationToolName,
    input: unknown,
    outerSignal?: AbortSignal,
  ): Promise<unknown> {
    if (!INVESTIGATOR_TOOL_NAMES.includes(name)) throw new RiskApiClientError("invalid_config");
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.options.timeoutMs);
    const abort = () => {
      controller.abort();
    };
    outerSignal?.addEventListener("abort", abort, { once: true });
    if (outerSignal?.aborted === true) controller.abort();
    try {
      const response = await this.requestFetch(
        new URL(`/api/investigation-tools/${encodeURIComponent(name)}`, this.baseUrl),
        {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${this.options.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(input),
          signal: controller.signal,
          redirect: "error",
        },
      );
      const text = await readBoundedBody(response, this.options.maxResponseBytes);
      if (!response.ok) throw new RiskApiClientError("http_error");
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new RiskApiClientError("invalid_response");
      }
    } catch (error) {
      if (error instanceof RiskApiClientError) throw error;
      throw new RiskApiClientError(controller.signal.aborted ? "timeout" : "unavailable");
    } finally {
      clearTimeout(timeout);
      outerSignal?.removeEventListener("abort", abort);
    }
  }
}

/** Reject service URLs outside the canonical HTTP loopback origin. */
function loopbackUrl(input: string): URL {
  try {
    const value = new URL(input);
    if (
      value.protocol !== "http:" ||
      value.hostname !== "127.0.0.1" ||
      value.username !== "" ||
      value.password !== "" ||
      value.pathname !== "/" ||
      value.search !== "" ||
      value.hash !== ""
    ) {
      throw new Error("invalid loopback URL");
    }
    return value;
  } catch {
    throw new RiskApiClientError("invalid_config");
  }
}

/** Read at most the configured response bytes and release the stream reader. */
async function readBoundedBody(response: Response, maximum: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > maximum) {
    await response.body?.cancel().catch(() => undefined);
    throw new RiskApiClientError("response_too_large");
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let done = false;
  try {
    while (!done) {
      const chunk = (await reader.read()) as ByteReadResult;
      done = chunk.done;
      if (!chunk.done) {
        length += chunk.value.length;
        if (length > maximum) {
          throw new RiskApiClientError("response_too_large");
        }
        chunks.push(chunk.value);
      }
    }
  } finally {
    if (!done) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const combined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(combined);
}

type ByteReadResult =
  | { readonly done: true; readonly value?: undefined }
  | { readonly done: false; readonly value: Uint8Array };
