import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("live evaluation opt-in", () => {
  it.each([
    [],
    ["--auth-profile", "/unread/credentials.json", "--model", "openai/example"],
    ["--allow-provider-calls", "--model", "openai/example"],
    ["--allow-provider-calls", "--auth-profile", "/unread/credentials.json"],
  ])(
    "refuses incomplete authorization before importing the build or reading credentials: %j",
    (...args) => {
      const result = spawnSync(
        process.execPath,
        [resolve(import.meta.dirname, "../../scripts/live-evaluation.mjs"), ...args],
        { encoding: "utf8" },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "Explicit --allow-provider-calls, --auth-profile PATH and --model PROVIDER/MODEL are required",
      );
      expect(result.stderr).not.toContain("ENOENT");
    },
  );
});
