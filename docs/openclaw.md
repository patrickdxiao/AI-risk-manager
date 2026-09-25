# OpenClaw runtime setup

This adapter supports **OpenClaw 2026.7.1-2**. It checks the installed version, creates a fresh session, and checks that the session's effective inventory contains exactly the four `development-risk` plugin tools before requesting an agent turn. It uses `gateway call agent --expect-final`; the ordinary `openclaw agent` command in this version can fall back to an embedded runtime with a different tool policy.

Build the local application first:

```sh
pnpm install --frozen-lockfile
pnpm build
```

Add the plugin through `plugins.load.paths` using the absolute path to this checkout's `dist/plugin` directory. The build copies the manifest and writes the plugin package entry as `./index.js`; do not point the built setup at the source `index.ts`. Keep the checkout, its complete `dist` tree, and installed dependencies available because the plugin imports adjacent application modules. This is a local checkout integration, not a separately published npm package.

Create a dedicated investigator agent and a dedicated empty workspace. Point its tools allowlist at only these four tools. The application's state setup creates its private `attempts` directory; both processes must use that same absolute canonical directory under the same local user. The directory must have mode `0700` and must not be a symlink. Existing unsafe directories are rejected rather than repaired.

Merge these settings into the OpenClaw config used by the application's `openclaw` subprocess and Gateway, replacing every example path:

```json
{
  "agents": {
    "list": [
      {
        "id": "risk-investigator",
        "workspace": "/absolute/path/to/empty-risk-workspace",
        "tools": {
          "allow": [
            "risk_get_context",
            "risk_get_evidence",
            "risk_list_evidence",
            "risk_inspect_git"
          ]
        }
      }
    ]
  },
  "plugins": {
    "allow": ["development-risk"],
    "load": { "paths": ["/absolute/path/to/development-risk-agent/dist/plugin"] },
    "entries": {
      "development-risk": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true },
        "config": {
          "investigationAgentId": "risk-investigator",
          "credentialsDirectory": "/absolute/path/to/app-state/attempts",
          "apiBaseUrl": "http://127.0.0.1:4317"
        }
      }
    }
  }
}
```

Use the same API port in the app and plugin settings. Only canonical HTTP `127.0.0.1` origins are accepted; redirects are rejected. Restart the configured Gateway after changing the plugin. Inspect registration without calling a model:

```sh
openclaw plugins inspect development-risk --runtime --json
```

The inspection should report status `loaded`, the four risk tools, three typed hooks, and no diagnostics. Configure a provider/model for the dedicated agent using OpenClaw's normal provider setup before requesting a real review. Neither loading this plugin nor the project's synthetic tests initiates model work.

Start the application with the same dedicated agent ID and state directory:

```sh
pnpm gateway --state-dir /absolute/path/to/app-state --openclaw-agent risk-investigator
```

The application creates `app-state/attempts` before starting investigations. Its path must match `credentialsDirectory` above, and its API port must match `apiBaseUrl`. The default state directory is `~/.development-risk-agent` and the default port is `4317`. Enabling the agent also enables saved queued work and periodic plan-only reviews; it can initiate provider calls immediately. Without `--openclaw-agent` or `DEVELOPMENT_RISK_OPENCLAW_AGENT`, the app stays in planning and local-capture mode.

Open the one-use browser link printed by `pnpm gateway`. Its expiring browser session survives reloads in tab-scoped session storage. To obtain a new link after expiry or for another tab, leave the app running and use `pnpm dashboard --state-dir /absolute/path/to/app-state` in another terminal; include `--port` if you changed the API port. Do not reuse an already consumed link. This renews browser access without restarting investigations or changing local plans and history.

`OpenClawCliAdapter` takes `{ investigationAgentId, credentialsDirectory, executable? }`. It writes the already-authorized attempt token into an exclusive mode-`0600` regular file keyed by a random session UUID. That token is never included in the prompt, session key, CLI arguments, model-visible tool schemas or responses. Each tool invocation reloads the matching unexpired credential and sends it only in the API's bearer header. Symlinks, hardlinks, permissive files, mismatched sessions and expired credentials are rejected. Cleanup removes the file after completion, failed startup or cancellation; a crash can leave an expired file that grants no further access.

The four POST endpoints receive direct JSON arguments: `{}` for context, `{ "evidenceIds": [...] }` for exact evidence, `{ "repositoryId": "optional", "limit": 20 }` for listing, and `{ "repositoryId": "required" }` for Git inspection. The model does not choose an attempt ID or token. API-side authority and its persisted 12-call budget are definitive; hooks also reject other tools and allow at most one final-answer format correction. Findings use result version `1`; automatic task completion is rejected.

CLI stdout/stderr and tool responses are bounded. Cancellation kills local CLI waiting and requests a best-effort Gateway abort, but does not prove that remote provider work stopped or that its cost is settled. Only reported token counters are retained; absent counters and cost remain unknown. Invalid model answers retain available run telemetry and are rejected by the application.

Compatibility was checked against the installed package's Gateway schemas, tool-factory signatures and hook types, plus the official [plugin guide](https://docs.openclaw.ai/plugins/building-plugins), [tool registration reference](https://docs.openclaw.ai/plugins/sdk-overview/tools-and-commands), [hook reference](https://docs.openclaw.ai/plugins/hooks/prompt-and-session), and [CLI reference](https://docs.openclaw.ai/cli/agent). Current online documentation describes newer versions too; upgrade this pin only after rechecking the actual installed contracts. Tests use synthetic responses, real local HTTP requests and child processes. An isolated native inspection loaded the built `dist/plugin/index.js` in OpenClaw 2026.7.1-2 with status `loaded`, exactly four risk tools, three hooks, and no diagnostics, without starting a Gateway or invoking a model. These checks do not establish model accuracy or remote cancellation guarantees.
