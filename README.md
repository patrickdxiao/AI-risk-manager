# Development Risk Agent

A local risk investigator for one developer's sprints, tasks, and approved repositories.
Plan work, capture read-only Git metadata, and use an optional OpenClaw investigator to follow evidence and report cited risks.
Tasks can depend on work across repositories without a project setup step.
Completion remains an explicit user action.

## Run locally

Requires Node.js 26+, pnpm 10.15.1, and Git for repository discovery and capture.

```sh
pnpm install --frozen-lockfile
pnpm gateway
```

`pnpm gateway` builds the application, then starts it.
Open the one-use sign-in link printed in the terminal.
The service listens on `127.0.0.1:4317` and saves SQLite state and local credentials in `~/.development-risk-agent`, outside monitored repositories.
Older prototype database formats are rejected; there is no automatic migration.
Use `--state-dir /absolute/path/to/new-state` to start with a fresh directory while retaining existing state.
The browser removes the sign-in fragment and keeps its session credential in memory.
After a page reload, an expired session, or a used sign-in link, stop the service with Ctrl+C and run the same command again to get a fresh link; saved plans and findings remain in the same state directory.

Use `pnpm gateway --state-dir /absolute/path/to/app-state --port 4318` to change the location or port.
`DEVELOPMENT_RISK_STATE_DIR` and `DEVELOPMENT_RISK_API_PORT` supply defaults; explicit flags take precedence.
`pnpm gateway --help` lists the options, and `pnpm start` runs the already-built service.

AI reviews are **disabled by default**.
Planning, task completion, repository discovery, and local metadata capture work without a provider.
To enable reviews, follow [OpenClaw setup](docs/openclaw.md), then run `pnpm gateway --openclaw-agent risk-investigator` with the configured dedicated agent ID.
`DEVELOPMENT_RISK_OPENCLAW_AGENT` supplies the same option.
Enabling it permits queued and scheduled reviews to call the configured provider; the application does not configure a provider or change your OpenClaw setup automatically.

## Use the dashboard

1. Create a sprint in **Plan**, then add tasks with points, completion criteria, and optional prerequisites. Task dates default to the sprint window.
2. Approve a folder to discover repositories. **Capture metadata** saves local observations without authorizing an AI review.
3. Choose repositories explicitly before a review. Checkboxes start unchecked; an empty selection means plan-only. **Review now** uses saved evidence, while **Resync** captures the selected repositories before queuing a review.
4. Open a task's finding to inspect citations, uncertainty, and the next check. Correct or dismiss findings, answer saved questions to request a follow-up, and mark tasks done yourself.
5. Use **Archive** for completed work from ended sprints. Unfinished work carries forward; reopening a task preserves its history.

With reviews enabled, plan changes queue reviews using the selected scope.
A local worker checks deadlines and sprint cadence every 30 seconds using plan-only scope and drains saved requests with their original repository selection.
There is no automatic Git watcher or OpenClaw cron configuration.
Git capture reads bounded metadata without fetching, running monitored code, or collecting source contents.
Selected metadata, saved plans, and answers can be sent to the provider during an authorized review.

Each attempt has an explicit repository scope, credential, deadline, and read-call budget.
Immutable receipts and ownership checks prevent stale attempts from replacing accepted results; partial reviews retain unexamined blockers.
Changed planning inputs invalidate an earlier healthy assessment.
Missing token usage or cost stays unknown, and cancellation does not guarantee that remote spending stops.

## Verify changes

```sh
pnpm check
pnpm build
```

The checks cover formatting, lint, types, and coverage tests; the build emits the service, dashboard assets, and local OpenClaw plugin.
GitHub Actions runs both for pull requests and changes to `main`.
Tests exercise real temporary Git repositories, SQLite transactions and recovery, authenticated HTTP routes, scripted investigations, and dashboard behavior.
The built OpenClaw plugin also passes native registration checks without provider calls.
These checks do not establish model accuracy, abrupt-crash durability, OS sandbox isolation, or production latency.
See [the design](docs/design.md) for access boundaries, remaining limitations, and separately labeled historical POC evidence.
