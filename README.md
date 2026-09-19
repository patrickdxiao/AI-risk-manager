# Development Risk Agent

A local risk agent for one developer's sprints, tasks, and approved repositories.
Tasks can depend on each other and span repositories without a project setup step.
This revision defines data contracts; runtime behavior and storage enforcement come in later changes.

Read [the design](docs/design.md) for the architecture and scope.

Requires Node.js 26+ and pnpm 10.15.1.
Run `pnpm install`, then `pnpm check` to verify the available modules.
