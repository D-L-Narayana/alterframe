/**
 * Chunked background work for shader warm-up. One item (one preset) is processed per idle slot so
 * compiling a dozen programs never blocks a frame for long; `requestIdleCallback` is preferred,
 * `setTimeout(0)` is the fallback and, when neither exists (Node tests), work runs synchronously.
 */

/** Schedules `run` once in the background; returns a cancel function. */
export type IdleScheduler = (run: () => void) => () => void;

/** The globals `pickIdleScheduler` looks at (injectable for tests). */
export interface IdleGlobals {
  requestIdleCallback?: (callback: (deadline: IdleDeadline) => void, options?: IdleRequestOptions) => number;
  cancelIdleCallback?: (handle: number) => void;
  setTimeout?: (handler: () => void, timeout: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

/** requestIdleCallback → setTimeout(0) → null (caller runs synchronously). */
export function pickIdleScheduler(g: IdleGlobals = globalThis as unknown as IdleGlobals): IdleScheduler | null {
  const ric = g.requestIdleCallback;
  if (typeof ric === 'function') {
    const cancel = g.cancelIdleCallback;
    return (run) => {
      // A timeout keeps warm-up moving on busy pages where true idle periods are rare.
      const handle = ric.call(g, () => run(), { timeout: 500 });
      return () => { if (typeof cancel === 'function') cancel.call(g, handle); };
    };
  }
  const st = g.setTimeout;
  if (typeof st === 'function') {
    const clear = g.clearTimeout;
    return (run) => {
      const handle = st.call(g, run, 0);
      return () => { if (typeof clear === 'function') clear.call(g, handle); };
    };
  }
  return null;
}

/**
 * De-duplicating FIFO that performs `work(item)` for one item per scheduler slot. Items already
 * queued are not re-added (idempotent `push`); without a scheduler every item runs immediately.
 */
export class WarmQueue<T> {
  private readonly queue: T[] = [];
  private cancel: (() => void) | null = null;
  private disposed = false;

  constructor(
    private readonly work: (item: T) => void,
    private readonly schedule: IdleScheduler | null,
    private readonly onError?: (error: unknown, item: T) => void,
  ) {}

  /** Items waiting to be processed. */
  get pending(): number {
    return this.queue.length;
  }

  push(items: readonly T[]): void {
    if (this.disposed) return;
    for (const item of items) if (!this.queue.includes(item)) this.queue.push(item);
    if (!this.schedule) {
      this.drainSync();
      return;
    }
    this.arm();
  }

  dispose(): void {
    this.disposed = true;
    this.queue.length = 0;
    if (this.cancel) {
      this.cancel();
      this.cancel = null;
    }
  }

  private arm(): void {
    if (this.cancel || this.queue.length === 0 || !this.schedule) return;
    this.cancel = this.schedule(() => {
      this.cancel = null;
      this.step();
      this.arm();
    });
  }

  private step(): void {
    const item = this.queue.shift();
    if (item === undefined) return;
    this.run(item);
  }

  private drainSync(): void {
    while (this.queue.length > 0 && !this.disposed) this.step();
  }

  private run(item: T): void {
    try {
      this.work(item);
    } catch (e) {
      if (this.onError) this.onError(e, item);
    }
  }
}
