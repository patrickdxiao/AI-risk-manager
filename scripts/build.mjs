import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { URL, fileURLToPath, pathToFileURL } from "node:url";

/** Build from a clean output directory; failed compilation cannot leave a runnable stale bundle. */
export function build(root = fileURLToPath(new URL("../", import.meta.url))) {
  const output = join(root, "dist");
  rmSync(output, { recursive: true, force: true });
  execFileSync(
    process.execPath,
    [join(root, "node_modules/typescript/bin/tsc"), "--project", "tsconfig.build.json"],
    { cwd: root, stdio: "inherit" },
  );
  for (const asset of [
    "dashboard/index.html",
    "dashboard/dashboard.css",
    "dashboard/dashboard.js",
    "plugin/openclaw.plugin.json",
  ]) {
    const destination = join(output, asset);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(root, "src", asset), destination);
  }
  const manifest = JSON.parse(readFileSync(join(root, "src/plugin/package.json"), "utf8"));
  manifest.openclaw.extensions = ["./index.js"];
  writeFileSync(join(output, "plugin/package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
)
  build();
