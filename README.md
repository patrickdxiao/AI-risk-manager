# Development Risk Agent

A local-first agent that investigates blockers and at-risk work across one developer's sprints and repositories.

- **Dashboard** — Plan tasks and dependencies; track points, risks, and your OpenClaw agents in one desktop workspace. You decide when work is complete.
- **Git adapter** — Capture metadata from approved repositories without fetching, editing, or executing their code.
- **OpenClaw investigator** — Follow saved evidence and report risks with citations, uncertainty, and next checks.
- **Build pipeline** — A dashboard status area is scaffolded for future CI and build signals.
- **SQLite** — Persist plans, evidence, and review history across sessions.

<p align="center">
  <img src="docs/images/dashboard-v2.png" width="1100" alt="Desktop dashboard with task planning, sprint points, risks, and OpenClaw agent activity">
</p>
<p align="center"><em>Working local dashboard with synthetic tasks and agent sessions.</em></p>

## Quick start

Requires **Node.js 26+**, **pnpm 10.15.1**, and **Git**.

```sh
pnpm install --frozen-lockfile
pnpm gateway
```

Open the one-use sign-in link printed in the terminal.

- **Local service:** `127.0.0.1:4317`.
- **Saved state:** `~/.development-risk-agent`, outside monitored repositories.
- **Fresh sign-in link:** Run `pnpm dashboard` in another terminal while the service is running.
- **Agent activity:** Add `--openclaw-activity` to read sessions from your configured Gateway. This does not start agents or enable AI reviews.

## Enable AI reviews

Planning and Git capture work without AI. Reviews are **disabled by default**.

Follow [OpenClaw setup](docs/openclaw.md), then start with your configured agent:

```sh
pnpm gateway --openclaw-agent risk-investigator
```

- Use **New sprint**, then add tasks in the left panel.
- Under **Review scope & connection → Manage repositories**, approve a folder, discover repositories, and select which to include. No selection means plan-only.
- Use **Resync** to capture metadata and queue a review; **Review now** uses saved evidence.
- Inspect findings, answer follow-up questions, and mark completed tasks done yourself.

Reviews can send plans, answers, and selected Git metadata to your configured provider.

## Development

```sh
pnpm check   # Formatting, lint, types, and coverage tests
pnpm build   # Service, dashboard, and OpenClaw plugin
```

## Docs

- [Local use](docs/local-use.md) — Configuration, sign-in, dashboard workflow, and backups.
- [Design](docs/design.md) — Architecture, evidence boundaries, and tradeoffs.
- [Verification](docs/verification.md) · [Model evaluation](docs/evaluation.md) — Results and known limits.
