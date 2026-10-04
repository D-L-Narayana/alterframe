/**
 * Telemetry guard: the tracking library's bundled usage logger POSTs to odml.pa.googleapis.com
 * (60 s after a task is created and on close()). The guard wraps `fetch` so that request is
 * refused locally and never leaves the device. Exercised directly on fake fetch targets and
 * through `createTracker()` on `globalThis` (MediaPipe mocked as in tracker.test.ts).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mediapipe/tasks-vision', () => {
  const task = () => ({
    close: () => undefined,
    detectForVideo: () => ({ landmarks: [], handedness: [], faceLandmarks: [], faceBlendshapes: [], facialTransformationMatrixes: [] }),
    segmentForVideo: () => undefined,
    getLabels: () => ['selfie'],
  });
  const make = () => ({ createFromOptions: vi.fn(async () => task()) });
  return { FilesetResolver: { forVisionTasks: vi.fn(async () => ({})) }, HandLandmarker: make(), FaceLandmarker: make(), ImageSegmenter: make() };
});

import { createTracker } from '../../../src/tracking';
import { BLOCKED_TELEMETRY_HOSTS, TELEMETRY_BLOCKED_WARNING, installTelemetryGuard, isBlockedTelemetryUrl } from '../../../src/tracking/telemetryGuard';

const LOG_URL = 'https://odml.pa.googleapis.com/v1/log';
const okResponse = () => new Response(new Uint8Array(16), { status: 200, headers: { 'content-length': '16' } });

type FetchFn = typeof fetch;
type FetchMock = ReturnType<typeof vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>>;

/** A fake host object with a recording fetch (never the real network). */
function fakeTarget(): { target: { fetch?: FetchFn }; original: FetchMock } {
  const original = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => okResponse());
  return { target: { fetch: original as unknown as FetchFn }, original };
}

function stubGlobalFetch(): FetchMock {
  const stub = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => okResponse());
  vi.stubGlobal('fetch', stub);
  return stub;
}

describe('isBlockedTelemetryUrl', () => {
  it('lists the logger host', () => {
    expect(BLOCKED_TELEMETRY_HOSTS).toContain('odml.pa.googleapis.com');
  });

  it('blocks the exact host as a string, with any path/query, and its subdomains', () => {
    expect(isBlockedTelemetryUrl(LOG_URL)).toBe(true);
    expect(isBlockedTelemetryUrl('https://odml.pa.googleapis.com/')).toBe(true);
    expect(isBlockedTelemetryUrl('https://ODML.pa.googleapis.com/v1/log?x=1')).toBe(true);
    expect(isBlockedTelemetryUrl('https://eu.odml.pa.googleapis.com/v1/log')).toBe(true);
    expect(isBlockedTelemetryUrl('//odml.pa.googleapis.com/v1/log')).toBe(true); // protocol-relative
  });

  it('accepts URL and Request objects', () => {
    expect(isBlockedTelemetryUrl(new URL(LOG_URL))).toBe(true);
    expect(isBlockedTelemetryUrl(new Request(LOG_URL, { method: 'POST' }))).toBe(true);
    expect(isBlockedTelemetryUrl(new URL('https://example.com/api'))).toBe(false);
    expect(isBlockedTelemetryUrl(new Request('https://example.com/api'))).toBe(false);
  });

  it('does not block the host inside a path, other hosts, look-alike hosts or same-origin relative URLs', () => {
    expect(isBlockedTelemetryUrl('https://example.com/odml.pa.googleapis.com')).toBe(false);
    expect(isBlockedTelemetryUrl('https://example.com/v1/log?to=odml.pa.googleapis.com')).toBe(false);
    expect(isBlockedTelemetryUrl('https://notodml.pa.googleapis.com/v1/log')).toBe(false);
    expect(isBlockedTelemetryUrl('https://example.com/api')).toBe(false);
    expect(isBlockedTelemetryUrl('/models/hand_landmarker.task')).toBe(false);
    expect(isBlockedTelemetryUrl('wasm/vision_wasm_internal.wasm')).toBe(false);
    expect(isBlockedTelemetryUrl('')).toBe(false);
  });
});

describe('installTelemetryGuard', () => {
  it('refuses a blocked URL without calling the original: TypeError, counter incremented', async () => {
    const { target, original } = fakeTarget();
    const guard = installTelemetryGuard(target);
    expect(guard.installed).toBe(true);
    expect(target.fetch === (original as unknown as FetchFn)).toBe(false);
    const p = target.fetch!(LOG_URL, { method: 'POST', headers: { 'content-type': 'application/x-protobuf' } });
    await expect(p).rejects.toBeInstanceOf(TypeError);
    await expect(p).rejects.toThrow(/blocked a telemetry request to odml\.pa\.googleapis\.com.*no third-party requests/);
    expect(original).not.toHaveBeenCalled();
    expect(guard.blocked).toBe(1);
  });

  it('blocks a Request object input too', async () => {
    const { target, original } = fakeTarget();
    installTelemetryGuard(target);
    await expect(target.fetch!(new Request(LOG_URL, { method: 'POST' }))).rejects.toBeInstanceOf(TypeError);
    expect(original).not.toHaveBeenCalled();
  });

  it('forwards every other call unchanged: same arguments, same `this`, the original result', async () => {
    const seen: { thisArg: unknown; args: unknown[] }[] = [];
    const result = Promise.resolve(okResponse());
    const original = function (this: unknown, ...args: unknown[]): Promise<Response> { seen.push({ thisArg: this, args }); return result; };
    const target: { fetch?: FetchFn } = { fetch: original as unknown as FetchFn };
    const guard = installTelemetryGuard(target);
    const init = { method: 'GET', credentials: 'same-origin' as const };
    const ctx = { tag: 'caller' };
    const p = target.fetch!.call(ctx, '/models/hand_landmarker.task', init);
    expect(p).toBe(result);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.thisArg).toBe(ctx);
    expect(seen[0]!.args).toHaveLength(2);
    expect(seen[0]!.args[0]).toBe('/models/hand_landmarker.task');
    expect(seen[0]!.args[1]).toBe(init);
    expect(guard.blocked).toBe(0);
    // The wrapper is transparent to property access (a test double's `.mock`, `name`, `length`).
    expect((target.fetch as unknown as { length: number }).length).toBe(original.length);
  });

  it('is idempotent: a second install returns the same guard, keeps one wrapper and forwards once per call', async () => {
    const { target, original } = fakeTarget();
    const a = installTelemetryGuard(target);
    const wrapper = target.fetch;
    const b = installTelemetryGuard(target);
    expect(b).toBe(a);
    expect(target.fetch).toBe(wrapper);
    await target.fetch!('https://example.com/api');
    expect(original).toHaveBeenCalledTimes(1);
    expect(original.mock.calls[0]![0]).toBe('https://example.com/api');
  });

  it('uninstall() restores the original, and leaves a foreign replacement alone', async () => {
    const { target, original } = fakeTarget();
    const guard = installTelemetryGuard(target);
    guard.uninstall();
    expect(guard.installed).toBe(false);
    expect(target.fetch === (original as unknown as FetchFn)).toBe(true);
    await target.fetch!(LOG_URL); // no guard → reaches the (fake) original
    expect(original).toHaveBeenCalledTimes(1);

    const again = installTelemetryGuard(target);
    expect(again).toBe(guard);
    expect(guard.installed).toBe(true);
    const foreign = vi.fn(async () => okResponse()) as unknown as FetchFn;
    target.fetch = foreign;
    guard.uninstall();
    expect(target.fetch).toBe(foreign);
  });

  it('notifies onBlocked listeners with the URL, supports unsubscribe, and survives a throwing listener', async () => {
    const { target } = fakeTarget();
    const guard = installTelemetryGuard(target);
    const urls: string[] = [];
    const off = guard.onBlocked((u) => urls.push(u));
    guard.onBlocked(() => { throw new Error('listener bug'); });
    await expect(target.fetch!(LOG_URL)).rejects.toBeInstanceOf(TypeError);
    expect(urls).toEqual([LOG_URL]);
    await expect(target.fetch!(new Request(LOG_URL))).rejects.toBeInstanceOf(TypeError);
    expect(urls).toEqual([LOG_URL, LOG_URL]);
    off();
    await expect(target.fetch!(LOG_URL)).rejects.toBeInstanceOf(TypeError);
    expect(urls).toHaveLength(2);
    expect(guard.blocked).toBe(3);
  });

  it('re-arms when the target fetch was replaced after the install (test harnesses do this) without double-wrapping', async () => {
    const { target } = fakeTarget();
    const guard = installTelemetryGuard(target);
    const first = target.fetch!;
    const replacement = vi.fn(async (_i: RequestInfo | URL, _n?: RequestInit) => okResponse());
    target.fetch = replacement as unknown as FetchFn;
    expect(guard.installed).toBe(false);
    expect(installTelemetryGuard(target)).toBe(guard);
    expect(guard.installed).toBe(true);
    expect(target.fetch).not.toBe(first);
    await target.fetch!('https://example.com/api');
    expect(replacement).toHaveBeenCalledTimes(1);
    await expect(target.fetch!(LOG_URL)).rejects.toBeInstanceOf(TypeError);
    expect(replacement).toHaveBeenCalledTimes(1);
    // Putting an earlier wrapper back (what vi.unstubAllGlobals can do) is recognised, not wrapped again.
    target.fetch = first;
    expect(installTelemetryGuard(target)).toBe(guard);
    expect(target.fetch).toBe(first);
  });

  it('does nothing when the target has no fetch', () => {
    const target: { fetch?: FetchFn } = {};
    const guard = installTelemetryGuard(target);
    expect(guard.installed).toBe(false);
    expect(target.fetch).toBeUndefined();
  });
});

describe('createTracker() installs the guard on globalThis', () => {
  afterEach(() => {
    installTelemetryGuard().uninstall();
    vi.unstubAllGlobals();
  });

  it('wraps the global fetch before any task exists, refuses the logger POST and records one warning per attempt', async () => {
    const stub = stubGlobalFetch();
    const tracker = createTracker();
    expect(globalThis.fetch === (stub as unknown as FetchFn)).toBe(false);
    expect(installTelemetryGuard().installed).toBe(true);
    await expect(globalThis.fetch(LOG_URL, { method: 'POST' })).rejects.toBeInstanceOf(TypeError);
    expect(stub).not.toHaveBeenCalled();
    expect(tracker.getInfo().warnings).toEqual([TELEMETRY_BLOCKED_WARNING]);
    await expect(fetch(new Request(LOG_URL, { method: 'POST' }))).rejects.toBeInstanceOf(TypeError);
    expect(tracker.getInfo().warnings).toEqual([TELEMETRY_BLOCKED_WARNING, TELEMETRY_BLOCKED_WARNING]);
    // dispose() detaches the tracker's listener (no leak); the guard itself stays active.
    tracker.dispose();
    await expect(fetch(LOG_URL)).rejects.toBeInstanceOf(TypeError);
    expect(tracker.getInfo().warnings).toHaveLength(2);
    expect(stub).not.toHaveBeenCalled();
  });

  it('model downloads still go through the wrapper, which stays introspectable as the test double', async () => {
    const stub = stubGlobalFetch();
    const tracker = createTracker();
    await tracker.init();
    expect(tracker.ready).toBe(true);
    const urls = stub.mock.calls.map((c) => String(c[0]));
    expect(urls).toEqual(expect.arrayContaining(['/models/hand_landmarker.task', '/models/face_landmarker.task', '/models/selfie_segmenter.tflite']));
    // tracker.test.ts reads `fetch.mock.calls` off the GLOBAL; that must keep working through the wrapper.
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(3);
    expect(tracker.getInfo().warnings).toEqual([]);
  });

  it('a second tracker re-arms the guard after a test harness replaced the global fetch', () => {
    stubGlobalFetch();
    createTracker();
    const second = stubGlobalFetch(); // vi.stubGlobal swaps our wrapper out
    expect(globalThis.fetch === (second as unknown as FetchFn)).toBe(true);
    createTracker();
    expect(globalThis.fetch === (second as unknown as FetchFn)).toBe(false);
    expect(installTelemetryGuard().installed).toBe(true);
  });
});
