# Development Risk Agent

A local risk agent for one developer's sprints, tasks, and approved repositories.
Tasks can depend on each other and span repositories without a project setup step.
This revision validates plans, evidence, and repository identities and implements transactional sprint creation and versioned task edits.
Services use storage interfaces; SQLite, repository access enforcement, and runtime integration come in later changes.

Read [the design](docs/design.md) for the architecture and scope.

Requires Node.js 26+ and pnpm 10.15.1.
Run `pnpm install`, then `pnpm check` to verify the available modules.
Run `pnpm build` to compile the production TypeScript into `dist`.
GitHub Actions runs both commands for pull requests and changes to `main`.
