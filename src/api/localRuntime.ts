import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { DiscoverRepositories } from "../adapters/git/discoverRepositories.js";
import {
  GitRepositoryInspectionAdapter,
  GitRepositoryObservationAdapter,
} from "../adapters/git/inspectRepository.js";
import { OpenClawCliAdapter } from "../adapters/openclaw/openClawCli.js";
import { OpenClawActivityAdapter } from "../adapters/openclaw/openClawActivity.js";
import type { AgentActivityPort } from "../core/agentActivity.js";
import {
  openSQLiteDatabase,
  readSQLiteRepositoryPaths,
  createSQLiteUnitOfWork,
} from "../adapters/sqlite/sqliteDatabase.js";
import { ExecuteInvestigation } from "../core/investigation/executeInvestigation.js";
import { SubmitInvestigationResult } from "../core/investigation/submitInvestigationResult.js";
import type { InvestigationRuntimePort } from "../core/investigation/investigationModel.js";
import type { ClockPort, IdGeneratorPort } from "../core/primitives.js";
import { RegisterRepository } from "../core/repository/repositoryService.js";
import { ReconcileRepository } from "../core/repository/repositoryCapture.js";
import { EvaluateStoredTriggers } from "../core/triggers/storedTriggerEvaluation.js";
import { ProcessTriggerDispatch } from "../core/triggers/processTriggerDispatch.js";
import { ReviewWorker } from "../core/triggers/reviewWorker.js";
import { createDashboardAuth } from "../dashboard/dashboardSession.js";
import { registerDashboardRoutes } from "../dashboard/dashboardRoutes.js";
import {
  assertLocalStateOutsideRepositories,
  ensureLocalStateDirectory,
  ensureLocalToken,
} from "./apiToken.js";
import { buildApiServer } from "./httpServer.js";
import { registerPlanningRoutes } from "./planningRoutes.js";
import { registerReviewRoutes } from "./reviewRoutes.js";
import { registerInvestigationTools } from "./investigationTools.js";
import { ReviewScheduler } from "./reviewScheduler.js";
import { captureLocally } from "./localCapture.js";

export const LOCAL_API_DATABASE_FILE = "state.sqlite";
export type OpenClawRuntimeConfiguration =
  | { readonly mode: "injected"; readonly port: InvestigationRuntimePort }
  | { readonly mode: "cli"; readonly investigationAgentId: string; readonly executable?: string };
export interface CreateLocalApiRuntimeOptions {
  readonly stateDir: string;
  readonly token?: string;
  readonly openClaw?: OpenClawRuntimeConfiguration;
  readonly openClawActivity?: boolean;
  readonly agentActivity?: AgentActivityPort;
  readonly writeWarning?: (message: string) => void;
}
export interface LocalApiRuntime {
  readonly app: FastifyInstance;
  readonly token: string;
  readonly dbPath: string;
  createBrowserBootstrapUrl(address: string): string;
  close(): Promise<void>;
}

/** Open private local state and compose real adapters; model work requires explicit configuration. */
export async function createLocalApiRuntime(
  options: CreateLocalApiRuntimeOptions,
  dependencies: { readonly clock?: ClockPort; readonly ids?: IdGeneratorPort } = {},
): Promise<LocalApiRuntime> {
  const { stateDir, token: suppliedToken, writeWarning } = options;
  const configuration = options.openClaw === undefined ? undefined : { ...options.openClaw };
  const stateDirectory = await ensureLocalStateDirectory(stateDir);
  const dbPath = join(stateDirectory, LOCAL_API_DATABASE_FILE);
  await assertLocalStateOutsideRepositories(stateDirectory, readSQLiteRepositoryPaths(dbPath));
  const token = suppliedToken ?? (await ensureLocalToken(stateDirectory));
  const database = openSQLiteDatabase({ path: dbPath });
  const auth = createDashboardAuth();
  let app: FastifyInstance | undefined;
  let scheduler: ReviewScheduler | undefined;
  let released = false;
  function release(): void {
    if (released) return;
    released = true;
    try {
      auth.close();
    } finally {
      database.close();
    }
  }
  try {
    const store = createSQLiteUnitOfWork(database.raw);
    const clock = dependencies.clock ?? { now: () => new Date().toISOString() };
    const ids = dependencies.ids ?? { next: randomUUID };
    const inspector = new GitRepositoryInspectionAdapter();
    const observer = new GitRepositoryObservationAdapter();
    const register = new RegisterRepository(store, inspector, ids, clock);
    const discovery = new DiscoverRepositories(store, inspector, ids, clock, stateDirectory);
    const capture = new ReconcileRepository(store, observer, ids, clock);
    const runtime =
      configuration === undefined
        ? undefined
        : configuration.mode === "injected"
          ? configuration.port
          : new OpenClawCliAdapter({
              investigationAgentId: configuration.investigationAgentId,
              ...(configuration.executable === undefined
                ? {}
                : { executable: configuration.executable }),
              credentialsDirectory: await ensureLocalStateDirectory(
                join(stateDirectory, "attempts"),
              ),
            });
    if (runtime !== undefined) {
      const executor = new ExecuteInvestigation(
        store,
        runtime,
        new SubmitInvestigationResult(store, ids, clock),
        clock,
      );
      const worker = new ReviewWorker(
        new EvaluateStoredTriggers(store, ids, clock),
        new ProcessTriggerDispatch(store, executor, ids, clock),
      );
      scheduler = new ReviewScheduler(
        worker,
        writeWarning ??
          ((message) => {
            process.stderr.write(`${message}\n`);
          }),
      );
    }
    const server = buildApiServer({ token, dashboardAuth: auth });
    app = server;
    const services = {
      store,
      ids,
      clock,
      investigationsEnabled: runtime !== undefined,
      wakeWorker: () => {
        scheduler?.wake();
      },
      registerRepository: (input: { path: string; approvedRoot?: string }) =>
        register.execute({ ...input, stateDirectory }),
      discoverRepositories: (input: { roots: readonly string[]; exclusions?: readonly string[] }) =>
        discovery.execute(input),
      reconcile: (input: { repositoryId: string }) =>
        captureLocally(store, observer, ids, clock, input.repositoryId),
    };
    registerPlanningRoutes(server, services);
    const activity =
      options.agentActivity ??
      (options.openClawActivity ? new OpenClawActivityAdapter() : undefined);
    server.get(
      "/api/agents/activity",
      () => activity?.list() ?? { status: "disabled", sessions: [] },
    );
    registerReviewRoutes(server, services);
    registerInvestigationTools(server, {
      store,
      clock,
      capture: (input) => capture.execute(input),
    });
    registerDashboardRoutes(server, { auth });
    server.addHook("onListen", () => {
      scheduler?.start();
      return Promise.resolve();
    });
    // Abort provider waiting before HTTP shutdown waits for in-flight tool requests.
    server.addHook("preClose", () => scheduler?.stop() ?? Promise.resolve());
    server.addHook("onClose", () => {
      release();
      return Promise.resolve();
    });
    let closing: Promise<void> | undefined;
    return Object.freeze({
      app: server,
      token,
      dbPath,
      createBrowserBootstrapUrl: (address: string) => auth.issueBootstrapUrl(address).url,
      close() {
        closing ??= (async () => {
          try {
            await scheduler?.stop();
            await server.close();
          } finally {
            release();
          }
        })();
        return closing;
      },
    });
  } catch (error) {
    try {
      await app?.close();
    } finally {
      release();
    }
    throw error;
  }
}
