import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SQLiteStateError } from "../adapters/sqlite/sqliteDatabase.js";
import { startLocalApi, type StartedLocalApi } from "./apiListener.js";
import { LocalTokenError } from "./apiToken.js";
import { DEFAULT_API_PORT } from "./httpServer.js";
const STATE_DIRECTORY_MAX_LENGTH = 4_096;
const STATE_DIRECTORY_ENV = "DEVELOPMENT_RISK_STATE_DIR";
const PORT_ENV = "DEVELOPMENT_RISK_API_PORT";
const INVESTIGATOR_ENV = "DEVELOPMENT_RISK_OPENCLAW_AGENT";
const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"] as const;
const HELP = `Usage:
  pnpm gateway [--state-dir PATH] [--port PORT] [--openclaw-agent ID]
  pnpm start [--state-dir PATH] [--port PORT]
  pnpm gateway --help

Starts the dashboard and authenticated API on localhost (127.0.0.1:4317).
The command prints a one-use sign-in link.
State defaults to ~/.development-risk-agent. --port 0 selects an available port.
Environment defaults: DEVELOPMENT_RISK_STATE_DIR and DEVELOPMENT_RISK_API_PORT.
--openclaw-agent ID enables investigations with a separately configured dedicated OpenClaw agent.
DEVELOPMENT_RISK_OPENCLAW_AGENT supplies its default. Model calls are disabled by default.
Help does not start a server or open local state.`;

export interface LocalApiMainOptions {
  readonly stateDir: string;
  readonly port: number;
  readonly investigationAgentId?: string;
}

export interface MainSignalSource {
  once(signal: (typeof SHUTDOWN_SIGNALS)[number], listener: () => void): void;
  off(signal: (typeof SHUTDOWN_SIGNALS)[number], listener: () => void): void;
}

export interface RunMainDependencies {
  readonly start: typeof startLocalApi;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly signals: MainSignalSource;
  readonly exitCode: (code: number) => void;
  readonly argv?: readonly string[];
  readonly env?: Readonly<NodeJS.ProcessEnv>;
}

/**
 * Resolve explicit CLI options over environment defaults.
 * @throws TypeError for invalid paths, ports, or dedicated investigator IDs.
 */
export function parseMainOptions(
  argv: readonly string[],
  env: Readonly<NodeJS.ProcessEnv>,
): LocalApiMainOptions {
  let stateDir = env[STATE_DIRECTORY_ENV] ?? resolve(homedir(), ".development-risk-agent");
  let portText = env[PORT_ENV];
  let investigationAgentId = env[INVESTIGATOR_ENV];
  const gateway = argv[0] === "gateway";

  for (let index = gateway ? 1 : 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--state-dir" && value !== undefined) {
      stateDir = value;
      index += 1;
    } else if (argument === "--port" && value !== undefined) {
      portText = value;
      index += 1;
    } else if (argument === "--openclaw-agent" && value !== undefined) {
      investigationAgentId = value;
      index += 1;
    } else {
      throw new TypeError("invalid local API arguments");
    }
  }

  if (
    stateDir.length === 0 ||
    stateDir.length > STATE_DIRECTORY_MAX_LENGTH ||
    stateDir.trim() !== stateDir
  ) {
    throw new TypeError("invalid local API state directory");
  }

  const port = portText === undefined ? DEFAULT_API_PORT : Number(portText);
  if (
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65_535 ||
    (portText !== undefined && String(port) !== portText)
  ) {
    throw new TypeError("invalid local API port");
  }
  if (
    investigationAgentId !== undefined &&
    (!/^[a-z][a-z0-9_-]{0,63}$/u.test(investigationAgentId) ||
      investigationAgentId === "main" ||
      investigationAgentId === "default")
  ) {
    throw new TypeError("invalid dedicated OpenClaw agent ID");
  }
  return Object.freeze({
    stateDir: resolve(stateDir),
    port,
    ...(investigationAgentId === undefined ? {} : { investigationAgentId }),
  });
}

/** Start the local service and handle process shutdown without exposing private errors. */
export async function runMain(
  dependencies: RunMainDependencies,
): Promise<StartedLocalApi | undefined> {
  const argv = dependencies.argv ?? [];
  if (
    argv.includes("--help") ||
    argv[0] === "help" ||
    (argv[0] === "gateway" && argv[1] === "help")
  ) {
    dependencies.stdout(HELP);
    return undefined;
  }
  let started: StartedLocalApi | undefined;
  let closePromise: Promise<void> | undefined;
  const lifecycle = { shutdownRequested: false };
  const removeSignalHandlers = () => {
    for (const signal of SHUTDOWN_SIGNALS) dependencies.signals.off(signal, shutdown);
  };
  const close = (): Promise<void> => {
    if (started === undefined) return Promise.resolve();
    closePromise ??= started.close();
    return closePromise;
  };
  const shutdown = () => {
    lifecycle.shutdownRequested = true;
    void close()
      .catch(() => {
        dependencies.stderr("Failed to close local API");
        dependencies.exitCode(1);
      })
      .finally(removeSignalHandlers);
  };

  for (const signal of SHUTDOWN_SIGNALS) dependencies.signals.once(signal, shutdown);
  try {
    const options = parseMainOptions(argv, dependencies.env ?? {});
    const startedService = await dependencies.start({
      ...options,
      writeLine: dependencies.stdout,
      writeWarning: dependencies.stderr,
    });
    started = startedService;
    if (lifecycle.shutdownRequested) await close();
    return Object.freeze({
      address: startedService.address,
      close: async () => {
        removeSignalHandlers();
        await close();
      },
    });
  } catch (error) {
    removeSignalHandlers();
    const reason =
      error instanceof LocalTokenError || error instanceof SQLiteStateError
        ? ` (${error.code})`
        : "";
    dependencies.stderr(`Failed to start local API${reason}`);
    dependencies.exitCode(1);
    return undefined;
  }
}

/** Connect the entrypoint to process arguments, output, and signals. */
export function createProcessMainDependencies(): RunMainDependencies {
  return {
    start: startLocalApi,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    signals: process,
    exitCode: (code) => {
      process.exitCode = code;
    },
    argv: process.argv.slice(2),
    env: process.env,
  };
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(realpathSync(entrypoint)).href) {
  await runMain(createProcessMainDependencies());
}
