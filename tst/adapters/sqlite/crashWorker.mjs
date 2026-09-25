// Runs compiled production services in a process that the parent deliberately kills.
import process from "node:process";
import { setInterval } from "node:timers";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const [build, path, mode, now] = process.argv.slice(2);
const load = (name) => import(pathToFileURL(join(build, name)).href);
const { openSQLiteDatabase, createSQLiteUnitOfWork } = await load(
  "adapters/sqlite/sqliteDatabase.js",
);
const { ExecuteInvestigation } = await load("core/investigation/executeInvestigation.js");
const { SubmitInvestigationResult } = await load("core/investigation/submitInvestigationResult.js");
const { ProcessTriggerDispatch } = await load("core/triggers/processTriggerDispatch.js");
const db = openSQLiteDatabase({ path });
const store = createSQLiteUnitOfWork(db.raw);
const clock = { now: () => now };
let sequence = 0;
const ids = { next: () => `child-${++sequence}` };
const pause = (message) => {
  process.send(message);
  return new Promise(() => {
    setInterval(() => {}, 60_000);
  });
};
if (mode === "transaction") {
  await store.execute(async (tx) => {
    const task = await tx.planning.findTaskById("task");
    await tx.planning.addTask({ ...task, id: "committed-child" });
  });
  await store.execute(async (tx) => {
    const task = await tx.planning.findTaskById("task");
    const evidence = await tx.evidence.findById("evidence");
    await tx.planning.addTask({ ...task, id: "uncommitted-child" });
    await tx.evidence.add({ ...evidence, id: "uncommitted-evidence", digest: "uncommitted" });
    await pause({ stage: "uncommitted" });
  });
} else {
  const submit = new SubmitInvestigationResult(store, ids, clock);
  const result = {
    version: "1",
    findings: [
      {
        state: "at_risk",
        riskType: "completion_unverified",
        confidence: 0.6,
        rationale: "Saved evidence lacks verification",
        nextCheckCondition: "New verification",
        evidenceCitations: [{ evidenceId: "evidence" }],
      },
    ],
  };
  const runtime = {
    runInvestigation: async (input) => {
      if (mode === "running") return pause({ stage: "running", token: input.attemptToken });
      return {
        runId: "child-run",
        sessionId: "child-session",
        structuredResult: result,
        usage: { totalTokens: 100 },
      };
    },
  };
  const acceptance = {
    execute: async (input) => {
      const receipt = await submit.execute(input);
      await pause({ stage: "accepted", receipt });
      return receipt;
    },
  };
  const executor = new ExecuteInvestigation(store, runtime, acceptance, clock);
  await new ProcessTriggerDispatch(store, executor, ids, clock).execute({
    leaseMinutes: 15,
    maxAttempts: 2,
    retryDelayMinutes: 1,
  });
}
