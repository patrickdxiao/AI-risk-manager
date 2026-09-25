import type { ReviewWorker } from "../core/triggers/reviewWorker.js";

/** Coalesce local wakeups while each bounded worker turn owns its own cancellation signal. */
export class ReviewScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private active: Promise<void> | undefined;
  private controller: AbortController | undefined;
  private requested = false;
  private started = false;
  private stopped = false;

  constructor(
    private readonly worker: Pick<ReviewWorker, "execute">,
    private readonly report: (message: string) => void,
  ) {}

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.timer = setInterval(() => {
      this.wake();
    }, 30_000);
    this.timer.unref();
    this.wake();
  }

  wake(): void {
    if (this.stopped) return;
    this.requested = true;
    if (!this.started || this.active !== undefined) return;
    this.requested = false;
    const controller = new AbortController();
    this.controller = controller;
    this.active = this.turn(controller.signal).finally(() => {
      this.active = undefined;
      if (this.requested) this.wake();
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.requested = false;
    clearInterval(this.timer);
    this.controller?.abort();
    await this.active;
  }

  private async turn(signal: AbortSignal): Promise<void> {
    try {
      // This timer reviews the plan and saved jobs; repository discovery never grants scope.
      const result = await this.worker.execute({ repositoryIds: [], reviewLimit: 10, signal });
      for (const error of result.errors) this.warn(`Review ${error.stage} failed (${error.code})`);
    } catch {
      this.warn("Review worker failed (persistence_failure)");
    }
  }

  private warn(message: string): void {
    try {
      this.report(message);
    } catch {
      /* Diagnostics must not interrupt shutdown or recovery. */
    }
  }
}
