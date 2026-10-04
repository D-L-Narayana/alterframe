/**
 * Telemetry guard for the tracking library.
 *
 * `@mediapipe/tasks-vision` 1.0.1 bundles a usage logger: 60 s after a task is created, and again
 * when the task is closed, it POSTs an `application/x-protobuf` body with an `x-goog-api-key`
 * header (taken from the wasm module) to odml.pa.googleapis.com/v1/log through the global `fetch`
 * (`await fetch(url, …)`, looked up at call time — not captured at import). The package typings
 * mention an `enableLogging` switch; the shipped bundle has none. AlterFrame's binding rule is
 * "no third-party requests": the production CSP (`connect-src 'self'`) already refuses the request,
 * but the Vite dev server has no CSP, so this guard makes the rule hold everywhere by wrapping
 * `fetch`: a request to a blocked host is rejected locally with a `TypeError` (what a failed
 * network fetch looks like) and is never sent; every other call is forwarded untouched.
 *
 * MediaPipe's sender treats the rejection as a failed send: it records its own error, clears its
 * interval and never retries, and it passes no error callback, so nothing reaches the console.
 * Each blocked attempt is counted and reported to listeners; `createTracker()` turns it into a
 * `TrackerInfo.warnings` line (visible in the Diagnostics panel) and detaches on `dispose()`.
 *
 * The wrapper is a `Proxy` whose only trap is `apply`: `this` and the arguments are forwarded
 * as-is, and property access (`fetch.length`, a test double's `.mock`) still reaches the wrapped
 * function. Install is idempotent per target; if a test harness swaps the target's `fetch` after
 * the install, the next install re-arms on the new function (and recognises its own earlier
 * wrapper if that is put back) — never two wrappers on top of each other.
 */

export const BLOCKED_TELEMETRY_HOSTS: readonly string[] = ['odml.pa.googleapis.com'];

/** Warning line `createTracker()` appends to `TrackerInfo.warnings` per blocked attempt. */
export const TELEMETRY_BLOCKED_WARNING =
  'Blocked a telemetry request from the tracking library (odml.pa.googleapis.com) — nothing left the device.';

export interface TelemetryGuard {
  /** True while `target.fetch` is this guard's wrapper. */
  readonly installed: boolean;
  /** Requests refused so far on this target. */
  readonly blocked: number;
  /** Called with the refused URL on every blocked attempt. Returns an unsubscribe function. */
  onBlocked(cb: (url: string) => void): () => void;
  /** Put the original `fetch` back — only if `target.fetch` is still this guard's wrapper. */
  uninstall(): void;
}

type FetchFn = typeof fetch;
interface FetchHost { fetch?: FetchFn }

/** The request URL as a string: string / URL / Request (or any object carrying a string `url`). */
function urlStringOf(input: unknown): string | null {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (typeof input === 'object' && input !== null) {
    const url = (input as { url?: unknown }).url;
    if (typeof url === 'string') return url;
  }
  return null;
}

/** Lower-case host of the request, resolved the way the browser would (relative → same origin). */
function hostnameOf(input: unknown): string | null {
  const s = urlStringOf(input);
  if (s === null) return null;
  try {
    const base = typeof location !== 'undefined' && location.href ? location.href : 'http://localhost/';
    return new URL(s, base).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** True for the blocked hosts and their subdomains (string, URL or Request input; never throws). */
export function isBlockedTelemetryUrl(input: RequestInfo | URL): boolean {
  const host = hostnameOf(input);
  if (!host) return false;
  return BLOCKED_TELEMETRY_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

const guards = new WeakMap<object, Guard>();
/** Every wrapper ever created, so one that is put back is recognised instead of wrapped again. */
const wrappers = new WeakSet<FetchFn>();
const originals = new WeakMap<FetchFn, FetchFn>();

class Guard implements TelemetryGuard {
  blocked = 0;
  private wrapper: FetchFn | null = null;
  private readonly listeners = new Set<(url: string) => void>();

  constructor(private readonly target: FetchHost) {}

  get installed(): boolean {
    return this.wrapper !== null && this.target.fetch === this.wrapper;
  }

  /** Wrap the target's current fetch unless it already is one of ours. */
  arm(): void {
    const current = this.target.fetch;
    if (typeof current !== 'function') return; // nothing to guard in this environment
    if (wrappers.has(current)) { this.wrapper = current; return; } // already ours (possibly put back by a harness)
    const wrapper: FetchFn = new Proxy(current, {
      // Arrow function: `this` is the guard; `original` is the wrapped fetch (the trap's first argument).
      apply: (original, thisArg, args: unknown[]) => {
        const input = args[0] as RequestInfo | URL;
        if (isBlockedTelemetryUrl(input)) return this.refuse(input);
        return Reflect.apply(original, thisArg, args);
      },
    });
    wrappers.add(wrapper);
    originals.set(wrapper, current);
    this.wrapper = wrapper;
    this.target.fetch = wrapper;
  }

  private refuse(input: RequestInfo | URL): Promise<Response> {
    this.blocked++;
    const url = urlStringOf(input) ?? String(input);
    for (const cb of this.listeners) {
      try { cb(url); } catch { /* a listener must never break fetch */ }
    }
    const host = hostnameOf(input) ?? BLOCKED_TELEMETRY_HOSTS[0];
    return Promise.reject(new TypeError(`AlterFrame blocked a telemetry request to ${host}: this app makes no third-party requests.`));
  }

  onBlocked(cb: (url: string) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  uninstall(): void {
    if (this.wrapper !== null && this.target.fetch === this.wrapper) {
      const original = originals.get(this.wrapper);
      if (original) this.target.fetch = original;
    }
    this.wrapper = null;
  }
}

/**
 * Guard `target.fetch` (default: the global). Idempotent: the same target always yields the same
 * guard, an installed wrapper is left alone, and a replaced `fetch` is re-armed without stacking.
 */
export function installTelemetryGuard(target: FetchHost = globalThis): TelemetryGuard {
  let guard = guards.get(target);
  if (!guard) {
    guard = new Guard(target);
    guards.set(target, guard);
  }
  guard.arm();
  return guard;
}
