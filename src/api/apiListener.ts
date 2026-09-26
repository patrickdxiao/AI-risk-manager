import type { FastifyListenOptions } from "fastify";
import type { AddressInfo } from "node:net";
import { DEFAULT_API_PORT, localApiListenOptions } from "./httpServer.js";
import { createLocalApiRuntime, type CreateLocalApiRuntimeOptions } from "./localRuntime.js";
const SIGN_IN_WARNING =
  "The dashboard is running, but a one-use sign-in link could not be created.";

export type BrowserBootstrapUrlFactory = (address: string) => Promise<string> | string;

export interface StartLocalApiOptions {
  readonly stateDir: string;
  readonly port?: number;
  readonly investigationAgentId?: string;
  readonly openClawActivity?: boolean;
  readonly writeLine?: (line: string) => void;
  readonly writeWarning?: (line: string) => void;
}

export interface StartedLocalApi {
  readonly address: string;
  close(): Promise<void>;
}

export interface LocalApiListenerRuntime {
  readonly app: {
    listen(options: FastifyListenOptions): Promise<string>;
    readonly server: {
      address(): AddressInfo | string | null;
    };
  };
  readonly token: string;
  readonly createBrowserBootstrapUrl?: BrowserBootstrapUrlFactory;
  close(): Promise<void>;
}

export interface StartLocalApiDependencies {
  createRuntime(
    options: Pick<
      CreateLocalApiRuntimeOptions,
      "stateDir" | "openClaw" | "openClawActivity" | "writeWarning"
    >,
  ): Promise<LocalApiListenerRuntime>;
}

const DEFAULT_DEPENDENCIES: StartLocalApiDependencies = Object.freeze({
  createRuntime: (
    options: Pick<
      CreateLocalApiRuntimeOptions,
      "stateDir" | "openClaw" | "openClawActivity" | "writeWarning"
    >,
  ) => createLocalApiRuntime(options),
});

/**
 * Listen on loopback and print the one-use dashboard link.
 * @returns The bound address and an idempotent shutdown function.
 */
export async function startLocalApi(
  options: StartLocalApiOptions,
  dependencies: StartLocalApiDependencies = DEFAULT_DEPENDENCIES,
): Promise<StartedLocalApi> {
  const runtime = await dependencies.createRuntime({
    stateDir: options.stateDir,
    ...(options.openClawActivity ? { openClawActivity: true } : {}),
    ...(options.writeWarning === undefined ? {} : { writeWarning: options.writeWarning }),
    ...(options.investigationAgentId === undefined
      ? {}
      : { openClaw: { mode: "cli" as const, investigationAgentId: options.investigationAgentId } }),
  });
  let closePromise: Promise<void> | undefined;

  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      await runtime.close();
    })();
    return closePromise;
  };

  try {
    await runtime.app.listen({ ...localApiListenOptions(options.port ?? DEFAULT_API_PORT) });
    const bound = runtime.app.server.address();
    if (bound === null || typeof bound === "string") {
      throw new Error("local API did not expose a TCP address");
    }
    const address = `http://127.0.0.1:${String(bound.port)}`;

    const writeLine = options.writeLine ?? ((line: string) => process.stdout.write(`${line}\n`));
    const writeWarning =
      options.writeWarning ?? ((line: string) => process.stderr.write(`${line}\n`));
    const readyLine = `Dashboard ready at ${address}/`;
    try {
      if (runtime.createBrowserBootstrapUrl === undefined) throw new Error("unavailable");
      const bootstrapUrl = await runtime.createBrowserBootstrapUrl(address);
      writeLine(bootstrapUrl);
    } catch {
      writeLine(readyLine);
      writeWarning(SIGN_IN_WARNING);
    }
    return Object.freeze({ address, close });
  } catch (error) {
    await close();
    throw error;
  }
}
