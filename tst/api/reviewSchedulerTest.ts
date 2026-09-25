import { afterEach, describe, expect, it, vi } from "vitest";
import { ReviewScheduler } from "../../src/api/reviewScheduler.js";

afterEach(() => {
  vi.useRealTimers();
});

function gate() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const empty = { dispatches: [], errors: [] };

describe("bounded local review scheduling", () => {
  it("coalesces wakeups, uses plan-only automatic scope and never overlaps worker turns", async () => {
    const pause = gate();
    const run = vi.fn(async () => {
      await pause.promise;
      return empty;
    });
    const scheduler = new ReviewScheduler({ execute: run }, vi.fn());
    scheduler.wake();
    expect(run).not.toHaveBeenCalled();
    scheduler.start();
    scheduler.start();
    scheduler.wake();
    scheduler.wake();
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith({
      repositoryIds: [],
      reviewLimit: 10,
      signal: expect.any(AbortSignal) as unknown,
    });
    pause.resolve();
    await vi.waitFor(() => {
      expect(run).toHaveBeenCalledTimes(2);
    });
    await scheduler.stop();
    scheduler.wake();
    scheduler.start();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("retries due work on its timer without spinning on failures or exposing private errors", async () => {
    vi.useFakeTimers();
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("private provider details"))
      .mockResolvedValue({
        dispatches: [],
        errors: [{ stage: "dispatch", code: "persistence_failure" }],
      });
    const report = vi.fn();
    const scheduler = new ReviewScheduler({ execute: run }, report);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(run).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    expect(report.mock.calls).toEqual([
      ["Review worker failed (persistence_failure)"],
      ["Review dispatch failed (persistence_failure)"],
    ]);
    await scheduler.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("aborts active waiting and awaits cleanup even when diagnostics throw", async () => {
    const ended = gate();
    const run = vi.fn(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise<typeof empty>((resolve) => {
          signal?.addEventListener(
            "abort",
            () => {
              void ended.promise.then(() => {
                resolve({ dispatches: [], errors: [] });
              });
            },
            { once: true },
          );
        }),
    );
    const scheduler = new ReviewScheduler({ execute: run }, () => {
      throw new Error("logger failed");
    });
    scheduler.start();
    const stopped = scheduler.stop();
    expect(run.mock.calls[0]?.[0].signal?.aborted).toBe(true);
    let finished = false;
    void stopped.then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    ended.resolve();
    await stopped;
    await scheduler.stop();
    const failures = new ReviewScheduler(
      { execute: () => Promise.reject(new Error("failure")) },
      () => {
        throw new Error("logger failed");
      },
    );
    failures.start();
    await failures.stop();
  });
});
