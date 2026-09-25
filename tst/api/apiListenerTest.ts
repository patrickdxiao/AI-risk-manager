import { describe, expect, it, vi } from "vitest";
import { startLocalApi, type LocalApiListenerRuntime } from "../../src/api/apiListener.js";

const SIGN_IN = `http://127.0.0.1:4444/#bootstrap=${"b".repeat(43)}`;

function harness(address: number | string | null = 4444) {
  const listen = vi.fn().mockResolvedValue("http://127.0.0.1");
  const close = vi.fn().mockResolvedValue(undefined);
  const createBrowserBootstrapUrl = vi.fn().mockResolvedValue(SIGN_IN);
  const runtime: LocalApiListenerRuntime = {
    app: {
      listen,
      server: {
        address: () =>
          typeof address === "number"
            ? { address: "127.0.0.1", family: "IPv4", port: address }
            : address,
      },
    },
    token: "t".repeat(43),
    createBrowserBootstrapUrl,
    close,
  };
  return {
    runtime,
    listen,
    close,
    createBrowserBootstrapUrl,
    dependencies: { createRuntime: vi.fn().mockResolvedValue(runtime) },
  };
}

describe("startLocalApi", () => {
  it("binds to loopback, prints the one-use link, and closes once", async () => {
    const test = harness();
    const writeLine = vi.fn();
    const service = await startLocalApi(
      { stateDir: "/private/state", port: 4444, writeLine },
      test.dependencies,
    );
    expect(test.listen).toHaveBeenCalledWith({ host: "127.0.0.1", port: 4444 });
    expect(writeLine).toHaveBeenCalledWith(SIGN_IN);
    expect(test.listen.mock.invocationCallOrder[0]).toBeLessThan(
      test.createBrowserBootstrapUrl.mock.invocationCallOrder[0] ?? 0,
    );
    expect(service.address).toBe("http://127.0.0.1:4444");
    expect(service.close()).toBe(service.close());
    await service.close();
    expect(test.close).toHaveBeenCalledOnce();
  });

  it("selects a dedicated investigator only when configured", async () => {
    const test = harness();
    const service = await startLocalApi(
      { stateDir: "/private/state", investigationAgentId: "reviewer", writeLine: vi.fn() },
      test.dependencies,
    );
    expect(test.dependencies.createRuntime).toHaveBeenCalledWith({
      stateDir: "/private/state",
      openClaw: { mode: "cli", investigationAgentId: "reviewer" },
    });
    await service.close();
  });

  it.each([null, "/private/api.sock"])(
    "closes when the bind has no TCP address (%s)",
    async (address) => {
      const test = harness(address);
      await expect(
        startLocalApi({ stateDir: "/private/state", writeLine: vi.fn() }, test.dependencies),
      ).rejects.toThrow("local API did not expose a TCP address");
      expect(test.close).toHaveBeenCalledOnce();
      expect(test.createBrowserBootstrapUrl).not.toHaveBeenCalled();
    },
  );

  it("closes after a bind failure", async () => {
    const test = harness();
    test.listen.mockRejectedValue(new Error("port unavailable"));
    await expect(startLocalApi({ stateDir: "/private/state" }, test.dependencies)).rejects.toThrow(
      "port unavailable",
    );
    expect(test.close).toHaveBeenCalledOnce();
  });

  it("sanitizes sign-in failures and keeps the authenticated service running", async () => {
    const test = harness();
    test.createBrowserBootstrapUrl.mockRejectedValue(new Error("private entropy detail"));
    const writeLine = vi.fn();
    const writeWarning = vi.fn();
    const service = await startLocalApi(
      { stateDir: "/private/state", writeLine, writeWarning },
      test.dependencies,
    );
    expect(writeLine).toHaveBeenCalledWith("Dashboard ready at http://127.0.0.1:4444/");
    expect(writeWarning).toHaveBeenCalledWith(
      "The dashboard is running, but a one-use sign-in link could not be created.",
    );
    expect(test.close).not.toHaveBeenCalled();
    await service.close();
  });
});
