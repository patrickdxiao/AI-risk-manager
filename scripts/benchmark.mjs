import { mkdtemp, rm } from "node:fs/promises";
import { arch, cpus, platform, release, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { createLocalApiRuntime } from "../dist/api/localRuntime.js";

// One local user, real HTTP and SQLite, synthetic plans, and no provider or repository access.
const stateDir = await mkdtemp(join(tmpdir(), "risk-benchmark-"));
let runtime;
try {
  runtime = await createLocalApiRuntime({ stateDir });
  const address = await runtime.app.listen({ host: "127.0.0.1", port: 0 });
  async function request(path, payload, method = "GET") {
    const response = await globalThis.fetch(`${address}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${runtime.token}`,
        ...(payload === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      signal: globalThis.AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status}`);
    return response.json();
  }
  const start = Date.now();
  const { sprint } = await request(
    "/api/sprints",
    {
      startAt: new Date(start).toISOString(),
      endAt: new Date(start + 7 * 86_400_000).toISOString(),
      reviewCadenceMinutes: 180,
    },
    "POST",
  );
  const tasks = [];
  for (let index = 0; index < 100; index++) {
    const { task } = await request(
      "/api/tasks",
      {
        sprintId: sprint.id,
        title: `Synthetic task ${index + 1}`,
        points: 1,
        completionCriteria: ["Explicit user verification"],
        dependencyIds: tasks.length === 0 ? [] : [tasks.at(-1).id],
      },
      "POST",
    );
    tasks.push(task);
  }
  let version = tasks[0].version;
  const operations = {
    status: () => request("/api/status"),
    sprints: () => request("/api/sprints"),
    overview: () => request(`/api/sprints/${sprint.id}/overview`),
    edit: () =>
      request(
        `/api/tasks/${tasks[0].id}`,
        { version: version++, description: "Measured edit" },
        "PATCH",
      ),
  };
  const results = {};
  for (const [name, operation] of Object.entries(operations)) {
    for (let warmup = 0; warmup < 20; warmup++) await operation();
    const timings = [];
    for (let sample = 0; sample < 1_000; sample++) {
      const before = performance.now();
      await operation();
      timings.push(performance.now() - before);
    }
    timings.sort((a, b) => a - b);
    const percentile = (p) => Number(timings[Math.ceil(p * timings.length) - 1].toFixed(2));
    results[name] = { samples: timings.length, p50Ms: percentile(0.5), p99Ms: percentile(0.99) };
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        environment: {
          node: process.version,
          os: `${platform()} ${release()} ${arch()}`,
          cpu: cpus()[0]?.model,
        },
        workload: { tasks: tasks.length, dependencyChain: true, concurrency: 1, providerCalls: 0 },
        results,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  try {
    await runtime?.close();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}
