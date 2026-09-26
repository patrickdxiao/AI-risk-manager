(() => {
  "use strict";
  const nonce = new URLSearchParams(window.location.hash.slice(1)).get("bootstrap");
  window.history.replaceState(
    null,
    document.title,
    window.location.pathname + window.location.search,
  );
  const STORAGE_KEY = "development-risk.sprint";
  const SESSION_KEY = "development-risk.session";
  let token, sprintId, overview, editingTask, timer;
  let sprints = [],
    repositories = [],
    archive = [],
    generation = 0,
    refreshing = false,
    refreshAgain = false,
    pageActive = true,
    investigationsEnabled = false;
  try {
    sprintId = window.localStorage.getItem(STORAGE_KEY) || undefined;
  } catch {
    /* Optional preference. */
  }
  const pending = new Set(),
    rendered = new Map(),
    openTasks = new Set(),
    scope = new Set(),
    drafts = new Map(),
    retries = new Map(),
    receipts = new Map();
  const byId = (id) => document.getElementById(id);
  const text = (id, value) => {
    byId(id).textContent = value;
  };
  const path = (suffix) => "/api/sprints/" + encodeURIComponent(sprintId) + suffix;
  const lines = (value) =>
    String(value || "")
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
  const human = (value) => String(value || "unknown").replaceAll("_", " ");
  const formValue = (form, name) => String(form.get(name) || "").trim();
  const selectedRepositories = () => [...scope].sort();
  const sprintName = (sprint) => sprint.goal || "Sprint " + date(sprint.startAt);
  const localDate = (value) => {
    const date = new Date(value);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  };
  const utcDate = (value) => new Date(value).toISOString();
  const messages = {
    validation_error: "Check the required fields, dates, points, and completion criteria.",
    task_version_conflict:
      "This task changed. Your edits are still here; reload the task before saving again.",
    investigation_queue_full: "The review queue is full. Wait for a review to finish, then retry.",
    investigation_budget_exhausted:
      "The review budget is currently exhausted. Saved work remains available.",
    attempt_scope_revoked:
      "Repository approval changed. Refresh your repository selection before reviewing.",
    evidence_scope_mismatch: "This evidence is outside the selected review scope.",
    repository_not_found: "This repository is no longer registered. Refresh the repository list.",
    review_unavailable: "AI reviews are disabled in the local app.",
    sprint_not_found: "This sprint is no longer available. Choose another sprint.",
  };
  function errorMessage(error, fallback = "The request failed. Try refreshing the saved state.") {
    return (
      messages[error?.code] ||
      (typeof error?.message === "string" && error.message ? error.message : fallback)
    );
  }
  function node(tag, value, className) {
    const element = document.createElement(tag);
    if (value !== undefined) element.textContent = value;
    if (className) element.className = className;
    return element;
  }
  function button(label, action) {
    const element = node("button", label);
    element.type = "button";
    element.addEventListener("click", () => perform(element, action));
    return element;
  }
  function status(message, error = false) {
    text("action-status", message);
    byId("action-status").dataset.error = String(error);
  }
  function rememberSprint() {
    try {
      window.localStorage.setItem(STORAGE_KEY, sprintId || "");
    } catch {
      /* Session selection still works. */
    }
  }
  function clearSession() {
    token = undefined;
    try {
      window.sessionStorage.removeItem(SESSION_KEY);
    } catch {
      /* Storage can be disabled. */
    }
  }
  function restoreSession() {
    try {
      const raw = window.sessionStorage.getItem(SESSION_KEY);
      if (typeof raw === "string" && raw.length <= 256) {
        const saved = JSON.parse(raw);
        if (validSession(saved)) return saved.token;
      }
    } catch {
      /* A corrupt or unavailable tab store cannot prevent a new sign-in. */
    }
    clearSession();
    return undefined;
  }
  function validSession(session) {
    return (
      typeof session?.token === "string" &&
      /^[A-Za-z0-9_-]{43}$/u.test(session.token) &&
      Number.isSafeInteger(session.expiresAt) &&
      session.expiresAt > Date.now()
    );
  }
  function saveSession(session) {
    try {
      window.sessionStorage.setItem(
        SESSION_KEY,
        JSON.stringify({ token: session.token, expiresAt: session.expiresAt }),
      );
      return true;
    } catch {
      return false;
    }
  }
  function signInHelp(expired = false) {
    byId("sign-in-help").hidden = false;
    const port = window.location.port;
    text("sign-in-command", "pnpm dashboard" + (port && port !== "4317" ? " --port " + port : ""));
    if (!token) {
      text(
        "connection-status",
        expired
          ? "Session expired. Open a fresh sign-in link."
          : "Open a sign-in link from the local app.",
      );
      text("provider-status", "Sign in to manage plans and review settings.");
    }
  }
  function availability() {
    const busy = pending.size > 0;
    for (const name of ["sprint", "settings", "task", "discovery"])
      byId(name + "-fields").disabled =
        !token || busy || ((name === "task" || name === "settings") && !overview?.sprint);
    byId("sprint-select").disabled = !token || busy || sprints.length === 0;
    for (const id of ["review-button", "resync-button"])
      byId(id).disabled = !token || !sprintId || busy || !investigationsEnabled;
    byId("resync-button").disabled ||= scope.size === 0;
    byId("refresh-button").disabled = !token || busy;
  }
  async function api(url, body, method = body === undefined ? "GET" : "POST") {
    if (!token) throw new Error("Open a new sign-in link from the local app.");
    const response = await window.fetch(url, {
      method,
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        Authorization: "Bearer " + token,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 401) {
      clearSession();
      window.clearTimeout(timer);
      availability();
      signInHelp(true);
    }
    const value = response.status === 204 ? undefined : await response.json();
    if (!response.ok)
      throw Object.assign(new Error(errorMessage(value?.error)), { code: value?.error?.code });
    return value;
  }
  /** Keep a request ID when the same action is retried after an unknown network outcome. */
  async function sendAction(url, body, idField = "requestId") {
    const key = url + JSON.stringify(body);
    if (!retries.has(key)) retries.set(key, window.crypto.randomUUID());
    const result = await api(url, { ...body, [idField]: retries.get(key) });
    retries.delete(key);
    return result;
  }
  async function perform(control, action) {
    if (control.disabled || pending.size > 0) return;
    control.disabled = true;
    pending.add(control);
    availability();
    try {
      await action();
    } catch (error) {
      status(errorMessage(error), true);
    } finally {
      pending.delete(control);
      control.disabled = !token;
      availability();
      await refresh();
    }
  }
  function form(name, action) {
    byId(name + "-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      if (pending.size > 0 || byId(name + "-fields").disabled) return;
      const data = new FormData(event.currentTarget);
      await perform(byId(name + "-fields"), () => action(data));
    });
  }
  function selectView(view) {
    byId("main-content").dataset.view = view;
    for (const name of ["tasks", "plan", "archive"]) {
      byId(name + "-panel").hidden = name !== view;
      byId("show-" + name).setAttribute("aria-pressed", String(name === view));
    }
  }
  async function loadSprints(selected = sprintId) {
    const previous = sprintId;
    sprints = (await api("/api/sprints")).sprints;
    sprintId = sprints.some((sprint) => sprint.id === selected)
      ? selected
      : (sprints.find((sprint) => sprint.state === "active") || sprints[0])?.id;
    if (previous !== sprintId) {
      generation += 1;
      clearSprint();
    }
    byId("sprint-select").replaceChildren(
      ...sprints.map((sprint) => {
        const option = node(
          "option",
          sprintName(sprint) + (sprint.state === "completed" ? " (ended)" : ""),
        );
        option.value = sprint.id;
        return option;
      }),
    );
    byId("sprint-select").value = sprintId || "";
    rememberSprint();
    if (!sprintId) selectView("plan");
    availability();
  }
  async function refresh() {
    window.clearTimeout(timer);
    if (!token || !pageActive || document.hidden || pending.size > 0) return;
    if (refreshing) {
      refreshAgain = true;
      return;
    }
    refreshing = true;
    const version = generation,
      selected = sprintId;
    try {
      const [current, archived, reviews, registered, runtime, activity] = await Promise.allSettled([
        selected ? api(path("/overview")) : Promise.resolve(undefined),
        api("/api/tasks?view=archive"),
        selected
          ? api(path("/investigations?limit=10"))
          : Promise.resolve({ investigations: [], pending: [] }),
        api("/api/repositories"),
        api("/api/status"),
        api("/api/agents/activity"),
      ]);
      if (version !== generation || selected !== sprintId || !token) return;
      if (current.status === "rejected") throw current.reason;
      overview = current.value;
      if (archived.status === "fulfilled") archive = archived.value.tasks;
      if (registered.status === "fulfilled") repositories = registered.value.repositories;
      if (runtime.status === "fulfilled")
        investigationsEnabled = runtime.value.investigationsEnabled === true;
      else investigationsEnabled = false;
      updateRepositories();
      updatePlan();
      renderChanged("task-list", overview?.tasks || [], () =>
        renderTasks("task-list", overview?.tasks || [], false),
      );
      if (archived.status === "fulfilled")
        renderChanged("archive-list", archive, () => renderTasks("archive-list", archive, true));
      if (reviews.status === "fulfilled") {
        const records = reviews.value.investigations;
        for (const record of records) {
          if (
            record.investigation.status === "completed" &&
            !receipts.has(record.investigation.id)
          ) {
            try {
              receipts.set(
                record.investigation.id,
                await api("/api/investigations/" + encodeURIComponent(record.investigation.id)),
              );
            } catch {
              /* History stays visible and receipt loading retries on the next refresh. */
            }
          }
        }
        if (version !== generation || !token) return;
        renderChanged(
          "review-list",
          [
            records,
            investigationsEnabled,
            reviews.value.pending,
            records.map((record) => receipts.get(record.investigation.id)),
          ],
          () => renderReviews(records, reviews.value.pending || []),
        );
      }
      if ([archived, reviews, registered, runtime].some((result) => result.status === "rejected"))
        status("Some saved data could not be refreshed. Retrying shortly.", true);
      updateDashboardOverview();
      renderChanged("subagent-list", activity.status === "fulfilled" ? activity.value : null, () =>
        renderAgentActivity(activity.status === "fulfilled" ? activity.value : null),
      );
      text("api-status", runtime.status === "fulfilled" ? "Connected" : "Unavailable");
      renderChanged("sprint-finding", overview?.sprintRisk, () => {
        byId("sprint-finding").replaceChildren();
        if (overview?.sprintRisk)
          byId("sprint-finding").appendChild(findingDetail(overview.sprintRisk));
      });
      text(
        "progress-summary",
        String(overview?.confirmedDonePoints || 0) +
          " / " +
          String(overview?.totalPoints || 0) +
          " points complete",
      );
      text("coverage-summary", "Unassessed work stays uncertain. Dates use your device time zone.");
      text("last-updated", "Updated " + date(overview?.generatedAt || new Date().toISOString()));
    } catch (error) {
      text("api-status", "Unavailable");
      if (version === generation)
        status(errorMessage(error, "Could not refresh saved work."), true);
    } finally {
      refreshing = false;
      availability();
      if (token && pageActive && !document.hidden) {
        timer = window.setTimeout(() => void refresh(), refreshAgain ? 0 : 1000);
        refreshAgain = false;
      }
    }
  }
  /** A focused editor or in-flight action must not be replaced by a background response. */
  function renderChanged(key, value, render) {
    const active = document.activeElement;
    if (
      pending.size > 0 ||
      (active &&
        ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName) &&
        byId(key)?.contains(active))
    )
      return;
    const encoded = JSON.stringify(value);
    if (rendered.get(key) === encoded) return;
    rendered.set(key, encoded);
    render();
  }
  function updateRepositories() {
    const currentIds = new Set(repositories.map((repo) => repo.id));
    for (const id of scope) if (!currentIds.has(id)) scope.delete(id);
    renderChanged("repository-scope", repositories, () => {
      byId("repository-scope").replaceChildren(
        ...repositories.map((repo) => {
          const label = node("label"),
            checkbox = node("input");
          checkbox.type = "checkbox";
          checkbox.value = repo.id;
          checkbox.checked = scope.has(repo.id);
          checkbox.addEventListener("change", () => {
            if (checkbox.checked) scope.add(repo.id);
            else scope.delete(repo.id);
            updateScope();
            availability();
          });
          label.appendChild(checkbox);
          label.appendChild(node("span", repo.canonicalPath));
          return label;
        }),
      );
      if (!repositories.length)
        byId("repository-scope").appendChild(
          node("p", "Approve a folder in Plan to discover repositories."),
        );
    });
    renderChanged("repository-list", repositories, () => {
      byId("repository-list").replaceChildren(
        ...repositories.map((repo) => {
          const item = node("li", repo.canonicalPath);
          item.appendChild(
            button("Capture metadata", async () => {
              await api("/api/repositories/" + encodeURIComponent(repo.id) + "/reconcile", {});
              status("Repository metadata captured locally.");
            }),
          );
          return item;
        }),
      );
      if (!repositories.length)
        byId("repository-list").appendChild(node("li", "No repositories registered."));
    });
    updateScope();
  }
  function updateScope() {
    text(
      "scope-summary",
      scope.size
        ? String(scope.size) +
            (scope.size === 1 ? " repository" : " repositories") +
            " selected for reviews."
        : "No repositories selected. Reviews use plan context only.",
    );
    text(
      "provider-status",
      investigationsEnabled
        ? "AI reviews are enabled. Reviews may send saved plans, selected repository metadata, and your answers to the configured provider. Source contents are not captured."
        : "AI reviews are disabled. Planning and local metadata capture remain available.",
    );
  }
  function updateDashboardOverview() {
    const total = Number(overview?.totalPoints || 0);
    const complete = Number(overview?.confirmedDonePoints || 0);
    const percentage = total > 0 ? Math.min(100, Math.round((complete / total) * 100)) : 0;
    const progress = byId("progress-bar");
    progress.value = percentage;
    progress.setAttribute("value", String(percentage));
    byId("progress-percent").textContent = percentage + "%";
    byId("progress-summary").textContent = complete + " / " + total + " points";
    byId("progress-detail").textContent = total
      ? percentage === 100
        ? "All planned points are complete."
        : "Points update as you mark tasks done."
      : "Create a sprint and tasks to track progress.";

    const tasks = (overview?.tasks || []).filter((task) => task.state !== "done");
    const counts = tasks.reduce(
      (summary, task) => {
        const risk = task.riskState || "uncertain";
        if (risk === "blocked") summary.blocked += 1;
        else if (risk === "at_risk") summary.atRisk += 1;
        else if (risk === "healthy") summary.healthy += 1;
        else summary.uncertain += 1;
        return summary;
      },
      { blocked: 0, atRisk: 0, healthy: 0, uncertain: 0 },
    );
    const riskParts = [];
    if (counts.blocked) riskParts.push(counts.blocked + " blocked");
    if (counts.atRisk) riskParts.push(counts.atRisk + " at risk");
    if (counts.uncertain) riskParts.push(counts.uncertain + " uncertain");
    byId("risk-summary").textContent =
      riskParts.join(" · ") ||
      (tasks.length ? "All clear" : total ? "No unfinished tasks" : "No tasks yet");
    byId("risk-detail").textContent = tasks.length
      ? counts.healthy + " healthy · " + tasks.length + " unfinished tasks"
      : "No unfinished tasks.";
  }
  function renderAgentActivity(activity) {
    const connected = activity?.status === "connected";
    const cards = connected ? activity.sessions : [];
    text(
      "subagent-summary",
      connected
        ? cards.length + " recent sessions"
        : activity?.status === "disabled"
          ? "Not connected"
          : "Connection unavailable",
    );
    text(
      "agent-activity-note",
      connected
        ? "Session activity is not proof of task completion."
        : activity?.status === "disabled"
          ? "Connect your OpenClaw Gateway with --openclaw-activity when starting the app."
          : "Could not reach your OpenClaw Gateway. Retrying automatically.",
    );
    byId("subagent-list").replaceChildren(
      ...cards.map((card) => {
        const item = node("article", undefined, "agent-card");
        const heading = node("header");
        heading.appendChild(node("strong", card.label));
        const state = node("span", card.state, "agent-status");
        state.dataset.state = card.state;
        heading.appendChild(state);
        item.appendChild(heading);
        item.appendChild(node("p", card.agentId + " · " + card.kind, "muted"));
        item.appendChild(
          node(
            "p",
            card.updatedAt === null ? "Update time unknown" : date(card.updatedAt),
            "muted",
          ),
        );
        return item;
      }),
    );
    if (connected && !cards.length)
      byId("subagent-list").appendChild(node("p", "No recent agent sessions.", "muted"));
  }
  function updatePlan() {
    const sprint = overview?.sprint;
    byId("sprint-settings").hidden = !sprint;
    byId("next-sprint-note").hidden = !sprint;
    text("new-sprint-title", sprint ? "Create the next sprint" : "Create a sprint");
    renderChanged("sprint-settings", sprint?.id, () => {
      byId("settings-goal").value = sprint?.goal || "";
      byId("settings-assumptions").value = (sprint?.assumptions || []).join("\n");
    });
    text(
      "sprint-summary",
      sprint
        ? sprintName(sprint) + " · " + date(sprint.startAt) + " to " + date(sprint.endAt)
        : "Create a sprint to organize your tasks.",
    );
    const tasks = [
      ...new Map([...(overview?.tasks || []), ...archive].map((task) => [task.id, task])).values(),
    ];
    renderChanged(
      "task-dependencies",
      [tasks.map((task) => [task.id, task.title]), editingTask?.id],
      () => {
        const selected = new Set(
          [...byId("task-dependencies").selectedOptions].map((option) => option.value),
        );
        byId("task-dependencies").replaceChildren(
          ...tasks
            .filter((task) => task.id !== editingTask?.id)
            .map((task) => {
              const option = node("option", task.title);
              option.value = task.id;
              option.selected = selected.has(task.id);
              return option;
            }),
        );
        for (const id of editingTask?.dependencyIds || [])
          if (!tasks.some((task) => task.id === id)) {
            const option = node("option", "Saved prerequisite " + id);
            option.value = id;
            option.selected = true;
            byId("task-dependencies").appendChild(option);
          }
      },
    );
  }
  function date(value) {
    const parsed = new Date(value);
    return value && Number.isFinite(parsed.getTime()) ? parsed.toLocaleString() : "Unknown time";
  }
  function renderTasks(target, tasks, archived) {
    const list = byId(target);
    list.replaceChildren();
    if (!tasks.length) {
      list.appendChild(
        node("li", archived ? "No archived tasks." : "Add a task in Plan to begin."),
      );
      return;
    }
    for (const task of tasks) {
      const item = node("li"),
        details = node("details"),
        summary = node("summary"),
        heading = node("span", undefined, "task-summary");
      details.open = openTasks.has(task.id);
      details.addEventListener("toggle", () => {
        if (details.open) openTasks.add(task.id);
        else openTasks.delete(task.id);
      });
      heading.appendChild(node("span", task.title));
      heading.appendChild(node("span", String(task.points) + " pts", "task-points"));
      const badge = node(
        "span",
        archived || task.state === "done" ? "done" : human(task.riskState || "uncertain"),
        "badge",
      );
      if (!archived && task.state !== "done") badge.dataset.risk = task.riskState || "uncertain";
      heading.appendChild(badge);
      summary.appendChild(heading);
      details.appendChild(summary);
      details.appendChild(
        node(
          "p",
          human(task.state) + " · " + String(task.points) + " points · due " + date(task.endAt),
          "muted",
        ),
      );
      if (task.description) details.appendChild(node("p", task.description));
      if (task.completionCriteria?.length) {
        const criteria = node("ul");
        for (const criterion of task.completionCriteria)
          criteria.appendChild(node("li", criterion));
        details.appendChild(criteria);
      }
      if (!archived || task.assessment) details.appendChild(findingDetail(task.assessment));
      const actions = node("div", undefined, "actions");
      actions.appendChild(button("Edit task", () => editTask(task)));
      for (const next of task.allowedUserTransitions ||
        (task.state === "done" ? ["in_progress"] : [])) {
        actions.appendChild(
          button(
            next === "done"
              ? "Mark done"
              : next === "planned"
                ? "Return to planned"
                : task.state === "done"
                  ? "Reopen"
                  : "Start",
            async () => {
              await api(
                "/api/tasks/" + encodeURIComponent(task.id),
                { version: task.version, state: next, repositoryIds: selectedRepositories() },
                "PATCH",
              );
              status("Task updated.");
            },
          ),
        );
      }
      details.appendChild(actions);
      item.appendChild(details);
      list.appendChild(item);
    }
  }
  function findingDetail(assessment) {
    const detail = node("div"),
      finding = assessment?.finding;
    detail.appendChild(
      node("p", assessment?.statement || finding?.rationale || "No accepted assessment yet."),
    );
    if (assessment?.coverageGap) detail.appendChild(node("p", assessment.coverageGap));
    if (assessment?.unavailableEvidenceIds?.length)
      detail.appendChild(node("p", "Some cited evidence is unavailable."));
    if (assessment?.assessedAt)
      detail.appendChild(node("p", "Assessed " + date(assessment.assessedAt), "muted"));
    if (!finding) return detail;
    if (finding.uncertainty) detail.appendChild(node("p", finding.uncertainty));
    if (finding.missingEvidence?.length)
      detail.appendChild(node("p", "Missing evidence: " + finding.missingEvidence.join(", ")));
    if (finding.recommendedUserAction)
      detail.appendChild(node("p", "Next action: " + finding.recommendedUserAction));
    if (finding.nextCheckCondition || finding.nextCheckAt)
      detail.appendChild(
        node(
          "p",
          "Next check: " +
            [
              finding.nextCheckCondition,
              finding.nextCheckAt ? date(finding.nextCheckAt) : undefined,
            ]
              .filter(Boolean)
              .join(" · "),
        ),
      );
    const citations = node("ul", undefined, "citations");
    for (const id of assessment.evidenceIds || []) {
      const item = node("li");
      item.appendChild(button("Evidence " + id, () => openEvidence(id)));
      citations.appendChild(item);
    }
    detail.appendChild(citations);
    const feedback = node("details");
    feedback.appendChild(node("summary", "Review this finding"));
    const field = node("textarea"),
      key = "correction-" + finding.id;
    field.id = key;
    field.rows = 2;
    field.maxLength = 4000;
    field.value = drafts.get(key) || "";
    field.setAttribute("aria-label", "Correction or feedback note");
    field.addEventListener("input", () => drafts.set(key, field.value));
    feedback.appendChild(field);
    const actions = node("div", undefined, "actions");
    for (const [kind, label] of [
      ["correct", "Save correction"],
      ["confirm", "Confirm"],
      ["dismiss", "Dismiss"],
      ["resolve", "Resolve risk"],
    ])
      actions.appendChild(
        button(label, async () => {
          const statement = field.value.trim();
          if (kind === "correct" && !statement) throw new Error("Enter a correction first.");
          await sendAction(
            "/api/findings/" + encodeURIComponent(finding.id) + "/feedback",
            {
              kind,
              ...(kind === "correct"
                ? { correction: { statement } }
                : statement
                  ? { note: statement }
                  : {}),
            },
            "id",
          );
          drafts.delete(key);
          field.value = "";
          status("Feedback saved. The original finding and task state are unchanged.");
        }),
      );
    const history = node("ul");
    actions.appendChild(
      button("Feedback history", async () => {
        const result = await api("/api/findings/" + encodeURIComponent(finding.id) + "/feedback");
        history.replaceChildren(
          ...result.feedback.map((entry) =>
            node(
              "li",
              human(entry.kind) +
                ": " +
                (entry.correction?.statement || entry.note || "Recorded") +
                " · " +
                date(entry.createdAt),
            ),
          ),
        );
        if (!result.feedback.length) history.appendChild(node("li", "No feedback yet."));
      }),
    );
    feedback.appendChild(actions);
    feedback.appendChild(history);
    detail.appendChild(feedback);
    return detail;
  }
  async function openEvidence(id) {
    const { evidence } = await api("/api/evidence/" + encodeURIComponent(id));
    if (!evidence) throw new Error("This citation is no longer available.");
    const detail = byId("evidence-detail");
    detail.replaceChildren(
      node("h3", evidence.summary),
      node("p", human(evidence.kind) + " · " + date(evidence.occurredAt)),
      node("p", evidence.locator),
      node("pre", JSON.stringify(evidence.metadata, null, 2)),
    );
    if (evidence.selectedContent) detail.appendChild(node("pre", evidence.selectedContent.text));
    byId("evidence-panel").hidden = false;
    detail.focus();
    detail.scrollIntoView({ block: "nearest" });
  }
  function renderReviews(reviews, queued) {
    const list = byId("review-list");
    list.replaceChildren();
    for (const { trigger, dispatch } of queued) {
      if (
        dispatch?.investigationId &&
        reviews.some((record) => record.investigation.id === dispatch.investigationId)
      )
        continue;
      list.appendChild(
        node(
          "li",
          human(dispatch?.status || "queued") +
            " · " +
            trigger.reason +
            " · queued " +
            date(trigger.observedAt),
        ),
      );
    }
    for (const review of reviews) {
      const investigation = review.investigation,
        attempt = review.latestAttempt,
        usage = attempt?.usage;
      const question = receipts.get(investigation.id)?.receipt?.question;
      const item = node("li");
      item.appendChild(
        node("strong", human(review.executionState) + (question ? " · question saved" : "")),
      );
      item.appendChild(node("p", date(investigation.requestedAt), "muted"));
      if (attempt?.provider || attempt?.model)
        item.appendChild(
          node("p", [attempt.provider, attempt.model].filter(Boolean).join(" · "), "muted"),
        );
      const tokens =
        usage?.totalTokens ??
        (Number.isFinite(usage?.inputTokens) && Number.isFinite(usage?.outputTokens)
          ? usage.inputTokens + usage.outputTokens
          : undefined);
      item.appendChild(
        node(
          "p",
          (tokens === undefined ? "Tokens unknown" : String(tokens) + " tokens") +
            " · " +
            (Number.isFinite(usage?.estimatedCostUsd)
              ? "Estimated $" + usage.estimatedCostUsd.toFixed(4)
              : "Cost unknown"),
          "muted",
        ),
      );
      if (attempt?.durationMs !== undefined)
        item.appendChild(
          node("p", "Duration " + (attempt.durationMs / 1000).toFixed(1) + " s", "muted"),
        );
      if (attempt?.terminalReason || investigation.failure)
        item.appendChild(node("p", human(attempt?.terminalReason || investigation.failure.code)));
      if (question) {
        item.appendChild(node("p", question.question));
        const answer = node("textarea"),
          key = "answer-" + investigation.id;
        answer.id = key;
        answer.rows = 2;
        answer.maxLength = 4000;
        answer.value = drafts.get(key) || "";
        answer.setAttribute("aria-label", "Your answer to " + question.question);
        answer.addEventListener("input", () => drafts.set(key, answer.value));
        item.appendChild(answer);
        const submit = button("Answer and review", async () => {
          if (!answer.value.trim()) throw new Error("Enter an answer first.");
          await sendAction(
            "/api/investigations/" + encodeURIComponent(investigation.id) + "/answer",
            { answer: answer.value.trim(), repositoryIds: selectedRepositories() },
          );
          drafts.delete(key);
          answer.value = "";
          status("Answer saved. A new review is queued.");
        });
        submit.disabled = !investigationsEnabled;
        item.appendChild(submit);
      }
      if (["pending", "running"].includes(review.executionState))
        item.appendChild(
          button("Cancel review", async () => {
            await api(
              "/api/investigations/" + encodeURIComponent(investigation.id) + "/cancel",
              attempt ? { executionAttemptId: attempt.id } : {},
            );
            status("Cancelled. Remote work may still incur cost.");
          }),
        );
      list.appendChild(item);
    }
    if (!list.children.length)
      list.appendChild(
        node("li", "No reviews yet. Select Review now to investigate saved evidence."),
      );
  }
  function editTask(task) {
    editingTask = task;
    for (const [id, value] of [
      ["task-title", task.title],
      ["task-description", task.description || ""],
      ["task-points", task.points],
      ["task-criteria", (task.completionCriteria || []).join("\n")],
      ["task-start", localDate(task.startAt)],
      ["task-end", localDate(task.endAt)],
    ])
      byId(id).value = String(value);
    rendered.delete("task-dependencies");
    updatePlan();
    for (const option of byId("task-dependencies").options)
      option.selected = (task.dependencyIds || []).includes(option.value);
    text("task-form-title", "Edit task");
    text("save-task", "Save changes");
    byId("cancel-edit").hidden = false;
    selectView("tasks");
    byId("task-options").open = true;
    byId("task-title").focus();
  }
  function clearEditor() {
    editingTask = undefined;
    byId("task-form").reset();
    byId("task-points").value = "1";
    byId("task-options").open = false;
    text("task-form-title", "Add a task");
    text("save-task", "Add task");
    byId("cancel-edit").hidden = true;
    rendered.delete("task-dependencies");
  }
  function clearSprint() {
    overview = undefined;
    rendered.clear();
    clearEditor();
    for (const id of ["task-list", "review-list"])
      byId(id).replaceChildren(node("li", "Loading saved work…"));
    byId("sprint-finding").replaceChildren();
    byId("evidence-panel").hidden = true;
    text("progress-summary", "");
    text("progress-percent", "0%");
    text("progress-detail", "Loading selected sprint…");
    text("risk-summary", "Loading…");
    text("risk-detail", "Refreshing saved task signals.");
    byId("progress-bar").value = 0;
    byId("progress-bar").setAttribute("value", "0");
    text("coverage-summary", "Loading selected sprint…");
  }
  async function requestReview(resync) {
    const response = await sendAction("/api/reviews", {
      sprintId,
      repositoryIds: selectedRepositories(),
      ...(resync ? { resync: true } : {}),
    });
    if (!response.trigger?.id) throw new Error("The service did not return a saved review ID.");
    status(
      response.status === "existing"
        ? "This review is already queued."
        : "Review queued. The investigator will use the selected scope.",
    );
    selectView("tasks");
  }
  for (const name of ["tasks", "plan", "archive"])
    byId("show-" + name).addEventListener("click", () => selectView(name));
  byId("sprint-select").addEventListener("change", async () => {
    sprintId = byId("sprint-select").value;
    generation += 1;
    clearSprint();
    rememberSprint();
    availability();
    await refresh();
  });
  for (const [id, action] of [
    ["review-button", () => requestReview(false)],
    ["resync-button", () => requestReview(true)],
    [
      "refresh-button",
      async () => {
        await loadSprints();
      },
    ],
  ])
    byId(id).addEventListener("click", () => perform(byId(id), action));
  byId("cancel-edit").addEventListener("click", () => {
    clearEditor();
    updatePlan();
  });
  byId("close-evidence").addEventListener("click", () => {
    byId("evidence-panel").hidden = true;
  });
  const resume = () => {
    if (!document.hidden && pageActive) void refresh();
    else window.clearTimeout(timer);
  };
  document.addEventListener("visibilitychange", resume);
  window.addEventListener("hashchange", () => {
    if (new URLSearchParams(window.location.hash.slice(1)).has("bootstrap"))
      window.location.reload();
  });
  window.addEventListener("pagehide", () => {
    pageActive = false;
    window.clearTimeout(timer);
  });
  window.addEventListener("pageshow", () => {
    pageActive = true;
    resume();
  });
  form("sprint", async (data) => {
    const response = await api("/api/sprints", {
      goal: formValue(data, "goal"),
      startAt: utcDate(formValue(data, "startAt")),
      endAt: utcDate(formValue(data, "endAt")),
      assumptions: lines(formValue(data, "assumptions")),
      state: "active",
      repositoryIds: selectedRepositories(),
    });
    generation += 1;
    clearSprint();
    await loadSprints(response.sprint.id);
    status("Sprint saved.");
    selectView("tasks");
  });
  form("settings", async (data) => {
    await api(
      path(""),
      {
        goal: formValue(data, "goal"),
        assumptions: lines(formValue(data, "assumptions")),
        repositoryIds: selectedRepositories(),
      },
      "PATCH",
    );
    await loadSprints();
    status("Sprint settings saved.");
  });
  form("task", async (data) => {
    const body = {
      title: formValue(data, "title"),
      description: formValue(data, "description"),
      points: Number(formValue(data, "points")),
      completionCriteria: lines(formValue(data, "completionCriteria")),
      dependencyIds: data.getAll("dependencyIds").map(String),
      repositoryIds: selectedRepositories(),
    };
    if (!body.completionCriteria.length) throw new Error("Add at least one completion criterion.");
    if (!body.description) {
      if (editingTask) body.description = null;
      else delete body.description;
    }
    for (const key of ["startAt", "endAt"]) {
      const value = formValue(data, key);
      if (value) body[key] = utcDate(value);
    }
    if (editingTask)
      await api(
        "/api/tasks/" + encodeURIComponent(editingTask.id),
        { ...body, version: editingTask.version },
        "PATCH",
      );
    else await api("/api/tasks", { ...body, sprintId });
    clearEditor();
    status("Task saved.");
    selectView("tasks");
  });
  form("discovery", async (data) => {
    const response = await api("/api/repositories/discover", {
      roots: [String(data.get("root") || "")],
      exclusions: lines(formValue(data, "exclusions")),
    });
    text(
      "discovery-status",
      response.incomplete ? "Scan incomplete. Some folders were not inspected." : "Scan complete.",
    );
    byId("discovery-list").replaceChildren(
      ...(response.issues || []).map((issue) => node("li", issue)),
    );
    status(
      String(response.repositories.length) +
        " repositories found. Select repositories above to include them in a review.",
    );
  });
  async function start() {
    const now = new Date();
    byId("sprint-start").value = localDate(now);
    byId("sprint-end").value = localDate(new Date(now.getTime() + 7 * 86400000));
    token = restoreSession();
    let reloadAvailable = true;
    try {
      if (nonce) {
        clearSession();
        const response = await window.fetch("/api/ui/bootstrap", {
          method: "POST",
          cache: "no-store",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ nonce }),
        });
        const bootstrap = await response.json();
        if (!response.ok || !validSession(bootstrap))
          throw new Error(
            "This sign-in link expired or was used already. Run pnpm dashboard for a fresh link.",
          );
        token = bootstrap.token;
        reloadAvailable = saveSession(bootstrap);
      }
      if (!token) {
        signInHelp();
        availability();
        return;
      }
      text("connection-status", "Connected to the local app");
      text("api-status", "Connected");
      await loadSprints();
      byId("sign-in-help").hidden = true;
      status("Plans and findings are saved locally.");
      if (!reloadAvailable) {
        signInHelp();
        status("This browser blocks tab storage. Use a fresh sign-in link after reloading.");
      }
      await refresh();
    } catch (error) {
      status(errorMessage(error, "Could not connect to the local app."), true);
      if (!token) {
        if (byId("sign-in-help").hidden) signInHelp();
      } else {
        text("connection-status", "Unable to connect");
        text("api-status", "Unavailable");
      }
    }
    availability();
  }
  void start();
})();
