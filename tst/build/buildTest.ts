import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function buildFixture() {
  const root = mkdtempSync(join(tmpdir(), "risk-build-test-"));
  folders.push(root);
  function write(file: string, contents: string) {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  write("package.json", '{"type":"module"}');
  write(
    "tsconfig.build.json",
    JSON.stringify({
      compilerOptions: {
        target: "ES2023",
        module: "NodeNext",
        rootDir: "src",
        outDir: "dist",
        strict: true,
        noEmitOnError: true,
        types: [],
      },
      include: ["src/**/*.ts"],
    }),
  );
  write("src/plugin/index.ts", 'export default { id: "development-risk" };');
  write("src/plugin/package.json", '{"type":"module","openclaw":{"extensions":["./index.ts"]}}');
  write("src/plugin/openclaw.plugin.json", '{"id":"development-risk"}');
  for (const name of ["index.html", "dashboard.css", "dashboard.js"])
    write(`src/dashboard/${name}`, `asset:${name}`);
  mkdirSync(join(root, "scripts"));
  copyFileSync(
    resolve(import.meta.dirname, "../../scripts/build.mjs"),
    join(root, "scripts/build.mjs"),
  );
  symlinkSync(
    resolve(import.meta.dirname, "../../node_modules"),
    join(root, "node_modules"),
    "dir",
  );
  return {
    root,
    write,
    run: () =>
      execFileSync(process.execPath, [join(root, "scripts/build.mjs")], {
        cwd: root,
        encoding: "utf8",
        stdio: "pipe",
      }),
  };
}

describe("production build", () => {
  it("compiles cleanly and packages dashboard assets plus a loadable compiled plugin manifest", () => {
    const fixture = buildFixture();
    fixture.write("dist/obsolete.js", "old output");
    fixture.run();
    expect(existsSync(join(fixture.root, "dist/obsolete.js"))).toBe(false);
    for (const name of ["index.html", "dashboard.css", "dashboard.js"])
      expect(readFileSync(join(fixture.root, "dist/dashboard", name), "utf8")).toBe(
        `asset:${name}`,
      );
    expect(
      JSON.parse(readFileSync(join(fixture.root, "dist/plugin/package.json"), "utf8")),
    ).toMatchObject({ openclaw: { extensions: ["./index.js"] } });
    expect(readFileSync(join(fixture.root, "dist/plugin/openclaw.plugin.json"), "utf8")).toBe(
      '{"id":"development-risk"}',
    );
    const module = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import plugin from "./dist/plugin/index.js"; process.stdout.write(plugin.id)',
      ],
      { cwd: fixture.root, encoding: "utf8" },
    );
    expect(module).toBe("development-risk");
  });

  it("removes stale output and emits no runnable assets when compilation fails", () => {
    const fixture = buildFixture();
    fixture.run();
    fixture.write("src/plugin/index.ts", "export const broken: string = 42;");
    expect(() => fixture.run()).toThrow();
    expect(existsSync(join(fixture.root, "dist/plugin/index.js"))).toBe(false);
    expect(existsSync(join(fixture.root, "dist/dashboard/index.html"))).toBe(false);
  });
});
