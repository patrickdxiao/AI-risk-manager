import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { DASHBOARD_CLIENT_JS, DASHBOARD_HTML } from "../../src/dashboard/dashboardRoutes.js";

type Body = Record<string, unknown>;
type Request = { path: string; method: string; body?: Body; headers?: Body };
type Handler = (request: Request) => unknown;
const sprint = {
  id: "sprint-1",
  goal: "Ship checkout",
  state: "active",
  startAt: "2026-09-01T00:00:00.000Z",
  endAt: "2026-09-30T00:00:00.000Z",
  reviewCadenceMinutes: 30,
  assumptions: [],
};
const repositories = [
  { id: "repo-1", canonicalPath: "/approved/api" },
  { id: "repo-2", canonicalPath: "/approved/web" },
];
const task = {
  id: "task-1",
  sprintId: sprint.id,
  title: "Show the correct price",
  description: "Use stored cents",
  points: 3,
  version: 2,
  completionCriteria: ["1299 displays as $12.99"],
  dependencyIds: [],
  startAt: sprint.startAt,
  endAt: sprint.endAt,
  state: "planned",
  riskState: "uncertain",
  allowedUserTransitions: ["in_progress", "done"],
};
const finding = {
  id: "finding-1",
  rationale: "Price is not verified",
  uncertainty: "No test result",
  recommendedUserAction: "Check the display",
  missingEvidence: ["manual check"],
  nextCheckCondition: "After checking",
  nextCheckAt: sprint.endAt,
};
const assessment = {
  finding,
  statement: "Price is not verified",
  assessedAt: sprint.startAt,
  evidenceIds: ["evidence-1"],
  unavailableEvidenceIds: ["lost"],
  coverageGap: "The plan changed",
};
const overview = () => ({
  sprint,
  tasks: [task],
  totalPoints: 3,
  confirmedDonePoints: 0,
  overallRisk: "uncertain",
  generatedAt: "2026-09-16T12:00:00.000Z",
});
const taskFields = {
  title: "New task",
  description: "",
  points: "2",
  completionCriteria: "Check output\nCheck empty input",
  dependencyIds: [task.id],
  startAt: "",
  endAt: "",
};

describe("dashboard user flow", () => {
  it("exchanges and removes the one-use fragment, stores only sprint preference, and starts plan-only", async () => {
    const client = await harness();
    expect(client.events[0]).toBe("fragment-cleared");
    expect(client.requests[0]?.path).toBe("/api/ui/bootstrap");
    expect(client.requests[0]?.headers).not.toHaveProperty("Authorization");
    expect(client.requests[1]?.headers).toHaveProperty("Authorization", "Bearer synthetic-token");
    expect(client.stored()).toBe(sprint.id);
    expect(client.content("repository-list")).toContain("/approved/web");
    expect(client.content("scope-summary")).toContain("plan context only");
    expect(client.get("resync-button").disabled).toBe(true);
    await client.click("review-button");
    expect(client.requests.find((r) => r.path === "/api/reviews")?.body).toMatchObject({
      sprintId: sprint.id,
      repositoryIds: [],
      requestId: expect.any(String) as unknown,
    });
  });

  it("uses only explicitly checked repositories and preserves scope through polling", async () => {
    const client = await harness();
    const check = descendants(client.get("repository-scope")).find((e) => e.tag === "input");
    if (!check) throw new Error("Missing repository checkbox");
    check.checked = true;
    await check.emit("change");
    expect(client.get("resync-button").disabled).toBe(false);
    await client.click("resync-button");
    expect(client.requests.find((r) => r.path === "/api/reviews")?.body).toMatchObject({
      repositoryIds: ["repo-1"],
      resync: true,
    });
    expect(client.content("scope-summary")).toContain("1 repository");
  });

  it("disables provider reviews while allowing local planning and metadata capture", async () => {
    const client = await harness(({ path }) =>
      path === "/api/status" ? { investigationsEnabled: false } : undefined,
    );
    expect(client.get("review-button").disabled).toBe(true);
    expect(client.get("task-fields").disabled).toBe(false);
    expect(client.content("provider-status")).toContain("disabled");
    await client.button("repository-list", "Capture metadata").emit("click");
    expect(client.requests.some((r) => r.path === "/api/repositories/repo-1/reconcile")).toBe(true);
    expect(client.requests.some((r) => r.path === "/api/reviews")).toBe(false);
  });

  it("reuses an action ID after an ambiguous failure and prevents in-flight duplicate clicks", async () => {
    let release: ((value: unknown) => void) | undefined;
    let attempts = 0;
    const client = await harness(({ path }) => {
      if (path !== "/api/reviews") return undefined;
      attempts += 1;
      if (attempts === 1)
        return new Promise((resolve) => {
          release = resolve;
        });
      return undefined;
    });
    const first = client.click("review-button");
    await vi.waitFor(() => {
      expect(release).toBeDefined();
    });
    await client.click("review-button");
    expect(attempts).toBe(1);
    release?.(failure(503, "review_unavailable"));
    await first;
    expect(client.content("action-status")).toContain("disabled");
    await client.click("review-button");
    const requests = client.requests.filter((r) => r.path === "/api/reviews");
    expect(requests[0]?.body?.["requestId"]).toBe(requests[1]?.body?.["requestId"]);
  });

  it("creates tasks with criteria, inherited dates and explicit dependencies", async () => {
    const client = await harness();
    await client.submit("task", taskFields);
    expect(
      client.requests.find((r) => r.method === "POST" && r.path === "/api/tasks")?.body,
    ).toEqual({
      title: "New task",
      points: 2,
      completionCriteria: ["Check output", "Check empty input"],
      dependencyIds: [task.id],
      repositoryIds: [],
      sprintId: sprint.id,
    });
    expect(client.content("action-status")).toBe("Task saved.");
  });

  it("edits with the loaded version, preserves rejected edits, and clears descriptions explicitly", async () => {
    const client = await harness(({ path, method }) =>
      path === "/api/tasks/task-1" && method === "PATCH"
        ? failure(409, "task_version_conflict")
        : undefined,
    );
    await client.button("task-list", "Edit task").emit("click");
    expect(client.get("task-title").value).toBe(task.title);
    await client.submit("task", taskFields);
    expect(client.requests.find((r) => r.method === "PATCH")?.body).toMatchObject({
      version: 2,
      description: null,
    });
    expect(client.content("action-status")).toContain("Your edits are still here");
    expect(client.content("save-task")).toBe("Save changes");
    await client.click("cancel-edit");
    expect(client.content("save-task")).toBe("Add task");
  });

  it("only changes completion through an explicit user action", async () => {
    const client = await harness();
    await client.button("task-list", "Mark done").emit("click");
    expect(client.requests.find((r) => r.method === "PATCH")?.body).toEqual({
      version: 2,
      state: "done",
      repositoryIds: [],
    });
    expect(client.requests.filter((r) => r.method === "PATCH")).toHaveLength(1);
  });

  it("loads archived work and lets the user reopen it", async () => {
    const client = await harness(({ path }) =>
      path === "/api/tasks?view=archive"
        ? { tasks: [{ ...task, state: "done", allowedUserTransitions: undefined }] }
        : undefined,
    );
    await client.click("show-archive");
    expect(client.get("archive-panel").hidden).toBe(false);
    await client.button("archive-list", "Reopen").emit("click");
    expect(client.requests.find((r) => r.method === "PATCH")?.body?.["state"]).toBe("in_progress");
  });

  it("creates and edits a sprint without a project entity", async () => {
    const client = await harness();
    await client.submit("sprint", {
      goal: "Ship safely",
      startAt: "2026-09-24T10:00",
      endAt: "2026-09-30T10:00",
      reviewCadenceMinutes: "60",
      assumptions: "One engineer",
    });
    const created = client.requests.find((r) => r.path === "/api/sprints" && r.method === "POST");
    expect(created?.body).toMatchObject({
      goal: "Ship safely",
      state: "active",
      reviewCadenceMinutes: 60,
      assumptions: ["One engineer"],
      repositoryIds: [],
    });
    expect(created?.body).not.toHaveProperty("projectId");
    await client.submit("settings", {
      goal: "Reduce scope",
      reviewCadenceMinutes: "30",
      assumptions: "No migration",
    });
    expect(
      client.requests.find((r) => r.path === "/api/sprints/sprint-1" && r.method === "PATCH")?.body,
    ).toMatchObject({ goal: "Reduce scope" });
  });

  it("discovers only supplied roots and surfaces partial-scan issues", async () => {
    const client = await harness();
    await client.submit("discovery", {
      root: "/approved/folder ",
      exclusions: "node_modules\n.cache",
    });
    expect(client.requests.find((r) => r.path.endsWith("/discover"))?.body).toEqual({
      roots: ["/approved/folder "],
      exclusions: ["node_modules", ".cache"],
    });
    expect(client.content("discovery-list")).toContain("Entry limit reached");
    expect(client.content("scope-summary")).toContain("plan context only");
  });

  it("shows citation gaps and exact saved evidence as text, with feedback independent of task state", async () => {
    const client = await harness(({ path }) =>
      path.endsWith("/overview")
        ? { ...overview(), tasks: [{ ...task, assessment }], sprintRisk: assessment }
        : undefined,
    );
    expect(client.content("task-list")).toContain("The plan changed");
    expect(client.content("task-list")).toContain("Some cited evidence is unavailable");
    await client.button("task-list", "Evidence evidence-1").emit("click");
    expect(client.content("evidence-detail")).toContain("<script>literal</script>");
    expect(client.get("evidence-panel").hidden).toBe(false);
    await client.click("close-evidence");
    expect(client.get("evidence-panel").hidden).toBe(true);
    await client.button("task-list", "Confirm").emit("click");
    expect(
      client.requests.find((r) => r.path.endsWith("/feedback") && r.method === "POST")?.body,
    ).toMatchObject({ kind: "confirm", id: expect.any(String) as unknown });
    expect(client.requests.some((r) => r.method === "PATCH")).toBe(false);
    await client.button("task-list", "Feedback history").emit("click");
    expect(client.content("task-list")).toContain("No feedback yet");
  });

  it("preserves focused draft controls during changed polling results", async () => {
    let changed = false;
    const client = await harness(({ path }) =>
      path.endsWith("/overview")
        ? {
            ...overview(),
            tasks: [{ ...task, assessment, title: changed ? "Updated title" : task.title }],
          }
        : undefined,
    );
    const field = descendants(client.get("task-list")).find((e) => e.tag === "textarea");
    if (!field) throw new Error("Missing feedback field");
    field.value = "My unfinished correction";
    await field.emit("input");
    client.document.activeElement = field;
    changed = true;
    client.tick();
    await vi.waitFor(() => {
      expect(client.timers.size).toBe(1);
    });
    expect(descendants(client.get("task-list"))).toContain(field);
    client.document.activeElement = null;
    client.tick();
    await vi.waitFor(() => {
      expect(client.content("task-list")).toContain("Updated title");
    });
    expect(descendants(client.get("task-list")).find((e) => e.tag === "textarea")?.value).toBe(
      "My unfinished correction",
    );
  });

  it("shows saved questions, submits an explicit follow-up, and reports unknown usage", async () => {
    const investigation = { id: "i1", status: "completed", requestedAt: sprint.startAt };
    const client = await harness(({ path }) => {
      if (path.endsWith("/investigations?limit=10"))
        return {
          investigations: [
            {
              investigation,
              executionState: "completed",
              latestAttempt: { id: "a1", provider: "fixture", model: "scripted", durationMs: 20 },
            },
          ],
          pending: [
            {
              trigger: { reason: "Manual review", observedAt: sprint.startAt },
              dispatch: { status: "pending" },
            },
          ],
        };
      if (path === "/api/investigations/i1")
        return {
          investigation,
          attempts: [],
          receipt: { question: { question: "Was this checked?" } },
        };
      return undefined;
    });
    expect(client.content("review-list")).toContain("Tokens unknown · Cost unknown");
    expect(client.content("review-list")).toContain("completed · question saved");
    const answer = descendants(client.get("review-list")).find((e) => e.tag === "textarea");
    if (!answer) throw new Error("Missing question");
    answer.value = "Checked locally";
    await client.button("review-list", "Answer and review").emit("click");
    expect(client.requests.find((r) => r.path.endsWith("/answer"))?.body).toMatchObject({
      answer: "Checked locally",
      repositoryIds: [],
      requestId: expect.any(String) as unknown,
    });
    expect(client.requests.filter((r) => r.path === "/api/investigations/i1")).toHaveLength(1);
  });

  it("updates question controls when provider availability changes without changing history", async () => {
    let enabled = true;
    const investigation = { id: "i1", status: "completed", requestedAt: sprint.startAt };
    const client = await harness(({ path }) => {
      if (path === "/api/status") return { investigationsEnabled: enabled };
      if (path.endsWith("/investigations?limit=10"))
        return { investigations: [{ investigation, executionState: "completed" }], pending: [] };
      if (path === "/api/investigations/i1")
        return { investigation, receipt: { question: { question: "Checked?" } } };
      return undefined;
    });
    expect(client.button("review-list", "Answer and review").disabled).toBe(false);
    enabled = false;
    client.tick();
    await vi.waitFor(() => {
      expect(client.button("review-list", "Answer and review").disabled).toBe(true);
    });
  });

  it("cancels the displayed attempt and accepts an empty 204 response", async () => {
    const client = await harness(({ path }) => {
      if (path.endsWith("/investigations?limit=10"))
        return {
          investigations: [
            {
              investigation: { id: "i1", requestedAt: sprint.startAt },
              latestAttempt: {
                id: "a1",
                usage: { inputTokens: 3, outputTokens: 4, estimatedCostUsd: 0.01 },
              },
              executionState: "running",
            },
          ],
          pending: [],
        };
      if (path.endsWith("/cancel")) return { responseStatus: 204 };
      return undefined;
    });
    expect(client.content("review-list")).toContain("7 tokens");
    await client.button("review-list", "Cancel review").emit("click");
    expect(client.requests.find((r) => r.path.endsWith("/cancel"))?.body).toEqual({
      executionAttemptId: "a1",
    });
    expect(client.content("action-status")).toContain("Cancelled");
  });

  it("offers sprint creation for an empty installation and requires a fresh bootstrap link", async () => {
    const empty = await harness(({ path }) =>
      path === "/api/sprints" ? { sprints: [] } : undefined,
    );
    expect(empty.get("sprint-fields").disabled).toBe(false);
    expect(empty.get("task-fields").disabled).toBe(true);
    const locked = await harness(undefined, "");
    expect(locked.requests).toHaveLength(0);
    expect(locked.content("connection-status")).toContain("Open the sign-in link");
  });

  it("labels goal-less sprints and queued requests using saved observation time even before dispatch", async () => {
    const untitled = { ...sprint, goal: undefined };
    const client = await harness(({ path }) => {
      if (path === "/api/sprints") return { sprints: [untitled] };
      if (path.endsWith("/overview")) return { ...overview(), sprint: untitled };
      if (path.endsWith("/investigations?limit=10"))
        return {
          investigations: [],
          pending: [{ trigger: { reason: "Manual review", observedAt: sprint.startAt } }],
        };
      return undefined;
    });
    expect(client.content("sprint-summary")).toContain("Sprint ");
    expect(client.content("sprint-summary")).not.toContain("undefined");
    expect(client.content("review-list")).toContain("Manual review");
    expect(client.content("review-list")).not.toContain("Unknown time");
  });

  it("pauses hidden polling and disables writes when the session expires", async () => {
    let expired = false;
    const client = await harness(() => (expired ? failure(401, "unauthorized") : undefined));
    await client.visibility(true);
    expect(client.timers.size).toBe(0);
    await client.visibility(false);
    await vi.waitFor(() => {
      expect(client.timers.size).toBe(1);
    });
    expired = true;
    client.tick();
    await vi.waitFor(() => {
      expect(client.get("task-fields").disabled).toBe(true);
    });
    expect(client.timers.size).toBe(0);
    expect(client.content("connection-status")).toContain("Session expired");
  });
});
function failure(status: number, code: string, message = code) {
  return { responseStatus: status, error: { code, message } };
}

async function harness(handler?: Handler, hash = "#bootstrap=one-use-link") {
  const elements = new Map<string, Element>();
  for (const match of DASHBOARD_HTML.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/gu)) {
    const element = new Element(/^<([a-z]+)/u.exec(match[0])?.[1] ?? "div");
    element.id = String(match[1]);
    element.hidden = /\bhidden\b/u.test(match[0]);
    element.disabled = /\bdisabled\b/u.test(match[0]);
    elements.set(element.id, element);
  }
  const get = (id: string) => {
    const element = elements.get(id);
    if (!element) throw new Error("Missing element " + id);
    return element;
  };
  const events: string[] = [],
    requests: Request[] = [];
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let nextTimer = 0,
    stored = "";
  const documentEvents = new Element("document"),
    windowEvents = new Element("window");
  const document = {
    hidden: false,
    activeElement: null as Element | null,
    title: "Development Risk",
    addEventListener: documentEvents.addEventListener.bind(documentEvents),
    getElementById: get,
    createElement: (tag: string) => new Element(tag),
  };
  vm.runInNewContext(
    DASHBOARD_CLIENT_JS,
    {
      URLSearchParams,
      Intl,
      Date,
      Error,
      Map,
      Set,
      Object,
      JSON,
      Number,
      String,
      Promise,
      encodeURIComponent,
      FormData: class {
        constructor(private readonly element: Element) {}
        get(name: string) {
          const value = this.element.fields[name];
          return Array.isArray(value) ? value[0] : (value ?? null);
        }
        getAll(name: string) {
          const value = this.element.fields[name];
          return value === undefined ? [] : Array.isArray(value) ? value : [value];
        }
      },
      document,
      window: {
        crypto: { randomUUID: () => `request-${String(++nextTimer)}` },
        location: { hash, pathname: "/", search: "" },
        history: { replaceState: () => events.push("fragment-cleared") },
        localStorage: {
          getItem: () => stored,
          setItem: (_key: string, value: string) => {
            stored = value;
          },
        },
        addEventListener: windowEvents.addEventListener.bind(windowEvents),
        setTimeout: (callback: () => void, delay: number) => {
          const id = ++nextTimer;
          timers.set(id, { callback, delay });
          return id;
        },
        clearTimeout: (id: number) => timers.delete(id),
        fetch: async (
          path: string,
          options: { method?: string; body?: string; headers?: Body } = {},
        ) => {
          const request: Request = {
            path,
            method: options.method || "GET",
            ...(options.body ? { body: JSON.parse(options.body) as Body } : {}),
            ...(options.headers ? { headers: options.headers } : {}),
          };
          requests.push(request);
          const value = (await handler?.(request)) ?? defaultResponse(request);
          const body = value as Body;
          const status = typeof body["responseStatus"] === "number" ? body["responseStatus"] : 200;
          return {
            ok: status < 400,
            status,
            json: () =>
              Promise.resolve(Object.hasOwn(body, "responseBody") ? body["responseBody"] : body),
          };
        },
      },
    },
    { filename: fileURLToPath(new URL("../../src/dashboard/dashboard.js", import.meta.url)) },
  );
  if (hash)
    await vi.waitFor(() => {
      expect(timers.size).toBe(1);
    });
  return {
    get,
    document,
    events,
    requests,
    timers,
    stored: () => stored,
    content: (id: string) => content(get(id)),
    button: (id: string, label: string) => {
      const result = descendants(get(id)).find(
        (element) => element.tag === "button" && element.textContent === label,
      );
      if (!result) throw new Error("Missing button " + label);
      return result;
    },
    click: (id: string) => get(id).emit("click"),
    submit: async (name: string, fields: Record<string, string | string[]>) => {
      get(name + "-form").fields = fields;
      await get(name + "-form").emit("submit");
    },
    tick: () => {
      const next = timers.entries().next().value;
      if (!next) throw new Error("No pending timer");
      timers.delete(next[0]);
      next[1].callback();
    },
    visibility: async (hidden: boolean) => {
      document.hidden = hidden;
      await documentEvents.emit("visibilitychange");
    },
  };
}
function defaultResponse({ path, method }: Request): unknown {
  if (path === "/api/ui/bootstrap") return { token: "synthetic-token" };
  if (path === "/api/status") return { investigationsEnabled: true };
  if (path === "/api/sprints") return method === "POST" ? { sprint } : { sprints: [sprint] };
  if (path.endsWith("/overview")) return overview();
  if (path === "/api/tasks?view=archive") return { tasks: [] };
  if (path.endsWith("/investigations?limit=10")) return { investigations: [], pending: [] };
  if (path === "/api/reviews") return { status: "queued", trigger: { id: "review-1" } };
  if (path === "/api/repositories") return { repositories };
  if (path.endsWith("/discover"))
    return { repositories, incomplete: true, issues: ["Entry limit reached"] };
  if (path === "/api/evidence/evidence-1")
    return {
      evidence: {
        id: "evidence-1",
        summary: "Saved observation",
        kind: "commit",
        occurredAt: sprint.startAt,
        locator: "git:fixture",
        metadata: { cents: 1299 },
        selectedContent: { text: "<script>literal</script>" },
      },
    };
  if (path.endsWith("/feedback") && method === "GET") return { feedback: [] };
  return {};
}
class Element {
  constructor(readonly tag: string) {}
  id = "";
  value = "";
  textContent = "";
  className = "";
  hidden = false;
  disabled = false;
  open = false;
  selected = false;
  checked = false;
  get tagName() {
    return this.tag.toUpperCase();
  }
  contains(element: Element) {
    return element === this || descendants(this).includes(element);
  }
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  fields: Record<string, string | string[]> = {};
  children: Element[] = [];
  private listeners = new Map<
    string,
    (event: { currentTarget: Element; preventDefault(): void }) => unknown
  >();
  get options() {
    return this.children;
  }
  get selectedOptions() {
    return this.children.filter((element) => element.selected);
  }
  addEventListener(
    name: string,
    callback: (event: { currentTarget: Element; preventDefault(): void }) => unknown,
  ) {
    this.listeners.set(name, callback);
  }
  appendChild(element: Element) {
    this.children.push(element);
    return element;
  }
  replaceChildren(...elements: Element[]) {
    this.children = elements;
  }
  setAttribute(key: string, value: string) {
    this.attributes[key] = value;
  }
  reset() {}
  focus() {}
  scrollIntoView() {}
  async emit(name: string) {
    await this.listeners.get(name)?.({ currentTarget: this, preventDefault() {} });
  }
}
function descendants(element: Element): Element[] {
  return element.children.flatMap((child) => [child, ...descendants(child)]);
}
function content(element: Element) {
  return [element, ...descendants(element)].map((child) => child.textContent).join(" ");
}
