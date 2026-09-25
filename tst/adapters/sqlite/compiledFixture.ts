import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll } from "vitest";

let output: string;
beforeAll(() => {
  output = mkdtempSync(join(tmpdir(), "risk-sqlite-build-"));
  writeFileSync(join(output, "package.json"), '{"type":"module"}');
  execFileSync(
    process.execPath,
    [
      resolve("node_modules/typescript/bin/tsc"),
      "--project",
      "tsconfig.build.json",
      "--outDir",
      output,
    ],
    { stdio: "pipe" },
  );
}, 20_000);
afterAll(() => {
  rmSync(output, { recursive: true, force: true });
});

/** Build fresh production modules for actual child-process crash and command tests. */
export function compiledPath(path = ""): string {
  return join(output, path);
}
