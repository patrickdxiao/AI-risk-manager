# Development Risk Agent

A local risk agent for one developer's sprints, tasks, and approved repositories.
Tasks can depend on each other and span repositories without a project setup step.
OpenClaw is the intended agent runtime; this milestone implements the application services behind storage, repository capture, and runtime ports.

The core workflow creates and edits plans, saves repository evidence, queues bounded reviews, executes scoped attempts, and accepts cited findings atomically.
Manual reviews and a bounded worker coordinate those services.
Interrupted handoffs and expired dispatch leases can be recovered without replacing an accepted result.
Task completion remains an explicit user action.

Each attempt has an explicit repository allowlist, credential, deadline, and enforced read-call budget.
Partial reviews retain unexamined blockers, and changed planning inputs invalidate an earlier healthy assessment.
Token admission accounts for reported usage and unresolved reservations; missing usage or cost remains unknown.
This accounting does not impose a hard cap on remote provider spending.

SQLite, the read-only Git adapter, OpenClaw integration, HTTP endpoints, and the dashboard are subsequent work.
Tests use serialized in-memory storage and scripted runtimes, so they do not establish filesystem isolation, SQLite crash recovery, model accuracy, or production latency.
Read [the design](docs/design.md) for the architecture, access boundaries, and remaining work.

Requires Node.js 26+ and pnpm 10.15.1.
Run `pnpm install`, then `pnpm check` for formatting, lint, type checks, and coverage tests.
Run `pnpm build` to compile the production TypeScript into `dist`.
GitHub Actions runs both commands for pull requests and changes to `main`.
