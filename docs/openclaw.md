# OpenClaw runtime setup

## Show your agents in the dashboard

Run `pnpm gateway --openclaw-activity` with your existing Gateway configuration to show recent
agent and subagent sessions. This read-only connection is independent of the investigator below;
both flags can be used together. It uses the same `OPENCLAW_STATE_DIR` and `OPENCLAW_CONFIG_PATH`
environment as the OpenClaw CLI, so select the Gateway that owns the sessions you want to see.

- Reads at most 30 recent sessions with `sessions.list`, refreshed every 15 seconds.
- Reads labels, parent relationships, update times, and runtime status; never transcripts.
- Excludes this application's internal investigation sessions.
- Uses the Gateway's active-run flag for running status, and explicit saved outcomes for completed/failed sessions. Recency alone does not establish liveness or task completion.
- Shows an unavailable state on connection or format errors; planning remains usable.

## Enable the investigator

This adapter supports **OpenClaw 2026.7.1-2**. It checks the installed version, creates a fresh session, and checks that the session's effective inventory contains exactly the four `development-risk` plugin tools before requesting an agent turn. It uses `gateway call agent --expect-final`; the ordinary `openclaw agent` command in this version can fall back to an embedded runtime with a different tool policy.

Build the local application first:

```sh
pnpm install --frozen-lockfile
pnpm build
```

Add the plugin through `plugins.load.paths` using the absolute path to this checkout's `dist/plugin` directory. The build copies the manifest and writes the plugin package entry as `./index.js`; do not point the built setup at the source `index.ts`. Keep the checkout, its complete `dist` tree, and installed dependencies available because the plugin imports adjacent application modules. This is a local checkout integration, not a separately published npm package.

Create a dedicated investigator agent and a dedicated empty workspace. Point its tools allowlist at only these four tools. Both processes must use the same absolute canonical `attempts` directory under the same local user. The directory must have mode `0700` and must not be a symlink. Existing unsafe directories are rejected rather than repaired.

Before inspecting the plugin or starting its Gateway, create the private credentials directory. For a new state location, create its parent first:

```sh
mkdir -m 700 /absolute/path/to/app-state
mkdir -m 700 /absolute/path/to/app-state/attempts
```

Skip a command if that directory already exists with the required permissions. Planning-only startup creates the state directory but not `attempts`; enabled startup creates both, but plugin inspection must already be able to open `attempts`.

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

Use the same API port in the app and plugin settings. Only canonical HTTP `127.0.0.1` origins are accepted; redirects are rejected. Restart the configured Gateway after changing the plugin. Inspect registration without calling a model, using the same configuration environment as that Gateway. The [isolated-profile recipe](#keep-a-dedicated-local-profile) below includes the required environment variables:

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

## Keep a dedicated local profile

An isolated profile avoids changing an existing Gateway or the user's global OpenClaw config. Create a private directory such as `~/.development-risk-agent/openclaw` for OpenClaw state and a separate empty workspace. Save the configuration above as `~/.development-risk-agent/risk-openclaw.json`, with `gateway.mode` set to `local`, a private Gateway bearer token, and Gateway port `4319`. The plugin's API URL remains `http://127.0.0.1:4317`.

Set the dedicated agent's `agentDir` to `~/.development-risk-agent/openclaw/agents/risk-investigator/agent` using an absolute expanded path. Configure provider authentication for that isolated agent through OpenClaw's normal auth flow, or explicitly import an authorized current profile into its private credential store. Do not put provider credentials in this repository or share the entire agent directory with another agent. OAuth credentials can expire and may require renewal in the same isolated profile.

After building the checkout and creating the private `attempts` directory described above, inspect the plugin with the isolated profile:

```sh
RISK_STATE="$HOME/.development-risk-agent"
OPENCLAW_STATE_DIR="$RISK_STATE/openclaw" \
OPENCLAW_CONFIG_PATH="$RISK_STATE/risk-openclaw.json" \
  openclaw plugins inspect development-risk --runtime --json
```

Then run these in separate terminals. Replace the state path if needed, and use the same environment in both terminals:

```sh
RISK_STATE="$HOME/.development-risk-agent"
OPENCLAW_STATE_DIR="$RISK_STATE/openclaw" \
OPENCLAW_CONFIG_PATH="$RISK_STATE/risk-openclaw.json" \
  openclaw gateway run --port 4319 --bind loopback
```

```sh
RISK_STATE="$HOME/.development-risk-agent"
OPENCLAW_STATE_DIR="$RISK_STATE/openclaw" \
OPENCLAW_CONFIG_PATH="$RISK_STATE/risk-openclaw.json" \
  pnpm gateway --state-dir "$RISK_STATE" --openclaw-agent risk-investigator
```

Use the final checkout's absolute `dist/plugin` path in the profile. Stop both foreground commands when finished; no daemon or global configuration change is required. Ordinary `pnpm gateway` continues to keep provider calls disabled unless the explicit agent option or its documented environment default is supplied.

The opt-in [live evaluation](evaluation.md) runs the same built application, plugin, and Gateway against synthetic fixtures. Native Codex hook names in this pinned version can include an `openclaw` prefix; the plugin accepts only the four exact aliases and charges the actual bare-name invocation once, while the HTTP service independently charges every authenticated read.
