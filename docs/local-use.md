# Local use

Setup, dashboard workflow, and backup procedures for Development Risk Agent.

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
The browser removes the sign-in fragment and keeps its expiring session credential in tab-scoped session storage, so reloading stays signed in. Repository checkboxes still reset to plan-only after a reload.
For an expired session, another tab, or a used link, keep the service running and run `pnpm dashboard` in another terminal in this checkout to print a fresh one-use link. If you started with custom settings, use the same values, for example `pnpm dashboard --state-dir /absolute/path/to/app-state --port 4318`.
Browser sessions expire after 12 hours or a service restart. If the browser blocks session storage, the current page still works; use `pnpm dashboard` again after reloading. The permanent local API credential stays on disk and is never copied into browser storage.

Use `pnpm gateway --state-dir /absolute/path/to/app-state --port 4318` to change the location or port.
`DEVELOPMENT_RISK_STATE_DIR` and `DEVELOPMENT_RISK_API_PORT` supply defaults; explicit flags take precedence.
`pnpm gateway --help` lists the options, and `pnpm start` runs the already-built service.

AI reviews are **disabled by default**.
Planning, task completion, repository discovery, and local metadata capture work without a provider.
To enable reviews, follow [OpenClaw setup](openclaw.md), then run `pnpm gateway --openclaw-agent risk-investigator` with the configured dedicated agent ID.
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

## Back up and restore state

After `pnpm build`, create a private backup folder outside monitored repositories and choose a new snapshot filename:

```sh
mkdir -m 700 "$HOME/development-risk-backups"
node dist/adapters/sqlite/stateSnapshot.js "$HOME/.development-risk-agent/state.sqlite" "$HOME/development-risk-backups/snapshot.sqlite"
```

The command uses [SQLite's online backup API](https://nodejs.org/api/sqlite.html#sqlitebackupsourcedb-path-options) to include committed WAL data, checks the schema and integrity, and refuses an existing destination.
It can read live application state; do not copy only a live `state.sqlite` file or its sidecars yourself.
Snapshots contain saved plans, selected evidence, answers, and review history, so keep them private.

To restore, stop the original application and its investigator, then choose a fresh state directory:

```sh
mkdir -m 700 "$HOME/.development-risk-agent-restored"
node dist/adapters/sqlite/stateSnapshot.js "$HOME/development-risk-backups/snapshot.sqlite" "$HOME/.development-risk-agent-restored/state.sqlite"
env -u DEVELOPMENT_RISK_OPENCLAW_AGENT pnpm start --state-dir "$HOME/.development-risk-agent-restored"
```

Check the restored plans and citations with AI reviews disabled before configuring an investigator again.
Local API tokens and session credential files are not copied; the new state directory generates a fresh sign-in credential.
Saved pending reviews, attempt credential hashes, leases, and unknown usage reservations remain in the snapshot: restoring does not revoke remote attempts or recover work performed after the snapshot.
Expired leases recover when reviews are enabled; do not run the original and restored copies together.

## Verify changes

```sh
pnpm check
pnpm build
```

The checks cover formatting, lint, types, and coverage tests; the build emits the service, dashboard assets, and local OpenClaw plugin.
GitHub Actions runs both for pull requests and changes to `main`.
Tests exercise real temporary Git repositories, SQLite transactions and SIGKILL recovery, consistent snapshot restoration, authenticated HTTP routes, scripted investigations, and dashboard behavior.
The built OpenClaw plugin also passes native registration checks without provider calls.
Clock-gap tests exercise expired leases and scheduler recovery; they do not suspend the operating system.
These checks do not establish model accuracy, power-loss durability, OS sandbox isolation, or production latency.
See [the design](design.md) for access boundaries, remaining limitations, and separately labeled historical POC evidence.
Run `pnpm benchmark` for a provider-free local HTTP measurement; [verification notes](verification.md) cover the measured workload, browser checks, and recovery drills.
The separate [live evaluation](evaluation.md) records three synthetic provider-backed reviews, reported usage, and the limits of those results.
