import { homedir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SQLiteStateError } from "../../src/adapters/sqlite/sqliteDatabase.js";
import type { StartedLocalApi, StartLocalApiOptions } from "../../src/api/apiListener.js";
import { LocalTokenError } from "../../src/api/apiToken.js";
import type { MainSignalSource, RunMainDependencies } from "../../src/api/main.js";
import { createProcessMainDependencies, parseMainOptions, runMain } from "../../src/api/main.js";

describe("main", () => {
  describe("parseMainOptions", () => {
    it("enables read-only activity independently from provider reviews", () => {
      expect(parseMainOptions(["--openclaw-activity"], {})).toEqual({
        stateDir: resolve(homedir(), ".development-risk-agent"),
        port: 4317,
        openClawActivity: true,
      });
    });
    it("selects a dedicated investigator explicitly or through the environment", () => {
      expect(
        parseMainOptions(["gateway", "--openclaw-agent", "risk-review"], {
          DEVELOPMENT_RISK_OPENCLAW_AGENT: "ignored",
        }),
      ).toMatchObject({ investigationAgentId: "risk-review" });
      expect(
        parseMainOptions([], { DEVELOPMENT_RISK_OPENCLAW_AGENT: "risk-review" }),
      ).toMatchObject({ investigationAgentId: "risk-review" });
    });

    it("uses private-state and listener defaults", () => {
      expect(parseMainOptions([], {})).toEqual({
        stateDir: resolve(homedir(), ".development-risk-agent"),
        port: 4317,
      });
    });

    it("accepts bounded environment values, argument overrides, and strict arguments", () => {
      expect(
        parseMainOptions(["--state-dir", "../argument-state", "--port", "0"], {
          DEVELOPMENT_RISK_STATE_DIR: "../environment-state",
          DEVELOPMENT_RISK_API_PORT: "4318",
        }),
      ).toEqual({ stateDir: resolve("../argument-state"), port: 0 });
      expect(
        parseMainOptions([], {
          DEVELOPMENT_RISK_STATE_DIR: "../environment-state",
          DEVELOPMENT_RISK_API_PORT: "4318",
        }),
      ).toEqual({
        stateDir: resolve("../environment-state"),
        port: 4318,
      });
    });

    it.each([
      [["--unknown", "value"], {}],
      [["--state-dir"], {}],
      [["--port"], {}],
      [["--openclaw-agent"], {}],
      [["--open"], {}],
      [["--no-open"], {}],
      [["--open=true"], {}],
      [["--open", "true"], {}],
      [[], { DEVELOPMENT_RISK_STATE_DIR: "" }],
      [[], { DEVELOPMENT_RISK_STATE_DIR: " padded " }],
      [[], { DEVELOPMENT_RISK_STATE_DIR: "x".repeat(4_097) }],
      [[], { DEVELOPMENT_RISK_OPENCLAW_AGENT: "" }],
      [[], { DEVELOPMENT_RISK_OPENCLAW_AGENT: " padded " }],
      [[], { DEVELOPMENT_RISK_OPENCLAW_AGENT: "x".repeat(65) }],
      [["--openclaw-agent", "main"], {}],
      [["--openclaw-agent", "default"], {}],
      [[], { DEVELOPMENT_RISK_API_PORT: "" }],
      [[], { DEVELOPMENT_RISK_API_PORT: "01" }],
      [[], { DEVELOPMENT_RISK_API_PORT: "1.5" }],
      [[], { DEVELOPMENT_RISK_API_PORT: "-1" }],
      [[], { DEVELOPMENT_RISK_API_PORT: "65536" }],
    ] as const)("rejects invalid arguments or environment %#", (argv, env) => {
      expect(() => parseMainOptions(argv, env)).toThrow(TypeError);
    });
  });

  describe("runMain", () => {
    it("prints a renewed one-use link without starting or restarting the service", async () => {
      const start = vi.fn<RunMainDependencies["start"]>();
      const requestLink = vi
        .fn<NonNullable<RunMainDependencies["requestLink"]>>()
        .mockResolvedValue("http://127.0.0.1:4321/#bootstrap=one-use");
      const stdout = vi.fn<(line: string) => void>();
      const stderr = vi.fn<(line: string) => void>();
      const signals = new FakeSignalSource();
      const exitCode = vi.fn<(code: number) => void>();
      await runMain({
        start,
        requestLink,
        stdout,
        stderr,
        signals,
        exitCode,
        argv: ["--sign-in-link", "--state-dir", "../private-state", "--port", "4321"],
        env: {},
      });
      expect(start).not.toHaveBeenCalled();
      expect(requestLink).toHaveBeenCalledWith({
        stateDir: resolve("../private-state"),
        port: 4321,
        signInLink: true,
      });
      expect(stdout).toHaveBeenCalledWith("http://127.0.0.1:4321/#bootstrap=one-use");
      expect(signals.activeCount()).toBe(0);
      requestLink.mockRejectedValue(new Error("private token details"));
      await runMain({
        start,
        requestLink,
        stdout,
        stderr,
        signals,
        exitCode,
        argv: ["--sign-in-link"],
        env: {},
      });
      expect(stderr).toHaveBeenLastCalledWith(
        "Could not get a sign-in link. Check the running app, state directory, and port.",
      );
      expect(exitCode).toHaveBeenCalledWith(1);
      expect(signals.activeCount()).toBe(0);
    });

    it.each([
      ["--help"],
      ["help"],
      ["gateway", "--help"],
      ["gateway", "help"],
      ["gateway", "--port", "0", "--help"],
    ])(
      "prints help without opening state, starting a runtime, or installing signal handlers (%j)",
      async (...argv: string[]) => {
        const start = vi.fn<RunMainDependencies["start"]>();
        const stdout = vi.fn<(line: string) => void>();
        const stderr = vi.fn<(line: string) => void>();
        const exitCode = vi.fn<(code: number) => void>();
        const signals = new FakeSignalSource();
        expect(
          await runMain({
            start,
            stdout,
            stderr,
            exitCode,
            signals,
            argv,
            env: { DEVELOPMENT_RISK_STATE_DIR: "", DEVELOPMENT_RISK_API_PORT: "invalid" },
          }),
        ).toBeUndefined();
        expect(start).not.toHaveBeenCalled();
        expect(signals.activeCount()).toBe(0);
        expect(stdout).toHaveBeenCalledOnce();
        expect(stdout.mock.calls[0]?.[0]).toContain("127.0.0.1:4317");
        expect(stdout.mock.calls[0]?.[0]).toContain("authenticated API");
        expect(stdout.mock.calls[0]?.[0]).toContain("Model calls are disabled by default");
        expect(stderr).not.toHaveBeenCalled();
        expect(exitCode).not.toHaveBeenCalled();
      },
    );

    it("forwards one startup line and closes idempotently for both signals", async () => {
      const signalSource = new FakeSignalSource();
      const stdout = vi.fn<(line: string) => void>();
      const stderr = vi.fn<(line: string) => void>();
      const exitCode = vi.fn<(code: number) => void>();
      const close = vi.fn<StartedLocalApi["close"]>().mockResolvedValue();
      const startupLine = "Dashboard ready at http://127.0.0.1:4317/";
      const start = vi.fn((options: StartLocalApiOptions): Promise<StartedLocalApi> => {
        options.writeLine?.(startupLine);
        return Promise.resolve({ address: "http://127.0.0.1:4317", close });
      });

      const service = await runMain({
        start,
        stdout,
        stderr,
        signals: signalSource,
        exitCode,
        argv: ["--state-dir", "../state", "--port", "4317"],
        env: {},
      });
      expect(service).toBeDefined();
      expect(start).toHaveBeenCalledWith({
        stateDir: resolve("../state"),
        port: 4317,

        writeLine: stdout,
        writeWarning: stderr,
      });
      expect(stdout).toHaveBeenCalledOnce();
      expect(stdout).toHaveBeenCalledWith(startupLine);
      expect(stdout.mock.calls.flat().join(" ")).not.toContain("#token=");
      expect(stdout.mock.calls.flat().join(" ")).not.toContain("#bootstrap=");
      expect(stderr).not.toHaveBeenCalled();
      expect(exitCode).not.toHaveBeenCalled();

      signalSource.listener("SIGINT")();
      signalSource.listener("SIGTERM")();
      await vi.waitFor(() => {
        expect(close).toHaveBeenCalledOnce();
      });
      await service?.close();
      await service?.close();
      expect(close).toHaveBeenCalledOnce();
    });

    it("handles a rejected shutdown without leaking details or leaving signal handlers", async () => {
      const signals = new FakeSignalSource();
      const stderr = vi.fn();
      const exitCode = vi.fn();
      await runMain({
        start: vi.fn().mockResolvedValue({
          address: "http://127.0.0.1:4317",
          close: vi.fn().mockRejectedValue(new Error("private close detail")),
        }),
        stdout: vi.fn(),
        stderr,
        exitCode,
        signals,
        argv: [],
        env: {},
      });
      signals.listener("SIGTERM")();
      await vi.waitFor(() => {
        expect(signals.activeCount()).toBe(0);
      });
      expect(stderr).toHaveBeenCalledWith("Failed to close local API");
      expect(exitCode).toHaveBeenCalledWith(1);
    });

    it.each([
      [new Error("token-must-not-leak"), ""],
      [
        new LocalTokenError("state_directory_inside_repository", "token-must-not-leak"),
        " (state_directory_inside_repository)",
      ],
      [new SQLiteStateError("database_file_not_regular"), " (database_file_not_regular)"],
    ])("reports safe startup categories without error details (%s)", async (error, suffix) => {
      const signalSource = new FakeSignalSource();
      const secret = "token-must-not-leak";
      const stdout = vi.fn<(line: string) => void>();
      const stderr = vi.fn<(line: string) => void>();
      const exitCode = vi.fn<(code: number) => void>();

      await expect(
        runMain({
          start: vi.fn().mockRejectedValue(error),
          stdout,
          stderr,
          signals: signalSource,
          exitCode,
          argv: ["--state-dir", "../state"],
          env: {},
        }),
      ).resolves.toBeUndefined();
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).toHaveBeenCalledWith(`Failed to start local API${suffix}`);
      expect(stderr.mock.calls.flat().join(" ")).not.toContain(secret);
      expect(exitCode).toHaveBeenCalledWith(1);
      expect(signalSource.activeCount()).toBe(0);
    });

    it("builds process dependencies that write one line and set the process exit code", () => {
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const previousExitCode = process.exitCode;
      try {
        const dependencies = createProcessMainDependencies();
        dependencies.stdout("startup");
        dependencies.stderr("failure");
        dependencies.exitCode(7);
        expect(stdout).toHaveBeenCalledWith("startup\n");
        expect(stderr).toHaveBeenCalledWith("failure\n");
        expect(process.exitCode).toBe(7);
      } finally {
        process.exitCode = previousExitCode;
        stdout.mockRestore();
        stderr.mockRestore();
      }
    });
  });

  class FakeSignalSource implements MainSignalSource {
    private readonly listeners = new Map<"SIGINT" | "SIGTERM", () => void>();

    once(signal: "SIGINT" | "SIGTERM", listener: () => void): void {
      this.listeners.set(signal, listener);
    }

    off(signal: "SIGINT" | "SIGTERM", listener: () => void): void {
      if (this.listeners.get(signal) === listener) this.listeners.delete(signal);
    }

    listener(signal: "SIGINT" | "SIGTERM"): () => void {
      const listener = this.listeners.get(signal);
      if (listener === undefined) throw new Error(`missing ${signal} listener`);
      return listener;
    }

    activeCount(): number {
      return this.listeners.size;
    }
  }
});
