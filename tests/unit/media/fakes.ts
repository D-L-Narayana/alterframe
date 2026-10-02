/**
 * Node-side fakes for the media tests (no jsdom in the toolchain).
 * Only the surface the sources touch is modelled.
 */
import type { MediaEnv } from '@/media/env';

type Listener = (ev: Event) => void;

export class FakeEventTarget {
  private map = new Map<string, Set<Listener>>();
  addEventListener(type: string, cb: Listener): void {
    if (!this.map.has(type)) this.map.set(type, new Set());
    this.map.get(type)!.add(cb);
  }
  removeEventListener(type: string, cb: Listener): void {
    this.map.get(type)?.delete(cb);
  }
  dispatch(type: string): void {
    for (const cb of [...(this.map.get(type) ?? [])]) cb({ type } as Event);
  }
  listenerCount(type: string): number {
    return this.map.get(type)?.size ?? 0;
  }
}

export class FakeVideo extends FakeEventTarget {
  muted = false;
  playsInline = false;
  autoplay = false;
  loop = false;
  paused = true;
  readyState = 0;
  currentTime = 0;
  videoWidth = 0;
  videoHeight = 0;
  srcObject: MediaStream | null = null;
  src = '';
  error: { code: number } | null = null;
  attrs = new Map<string, string>();
  playCalls = 0;
  loadCalls = 0;
  rvfcCallbacks = new Map<number, (now: number, meta: { presentedFrames?: number }) => void>();
  private rvfcId = 0;
  /** Set false to emulate Firefox (no requestVideoFrameCallback). */
  constructor(public supportsRvfc = true) {
    super();
    if (!supportsRvfc) {
      // Remove the method so `typeof === 'function'` fails.
      (this as { requestVideoFrameCallback?: unknown }).requestVideoFrameCallback = undefined;
      (this as { cancelVideoFrameCallback?: unknown }).cancelVideoFrameCallback = undefined;
    }
  }
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
  }
  removeAttribute(k: string): void {
    this.attrs.delete(k);
  }
  play(): Promise<void> {
    this.playCalls += 1;
    this.paused = false;
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
  }
  load(): void {
    this.loadCalls += 1;
  }
  requestVideoFrameCallback(cb: (now: number, meta: { presentedFrames?: number }) => void): number {
    const id = ++this.rvfcId;
    this.rvfcCallbacks.set(id, cb);
    return id;
  }
  cancelVideoFrameCallback(id: number): void {
    this.rvfcCallbacks.delete(id);
  }
  /** Test helper: fire every pending rVFC callback as one presented frame. */
  presentFrame(now: number, presentedFrames: number): void {
    const cbs = [...this.rvfcCallbacks.entries()];
    this.rvfcCallbacks.clear();
    for (const [, cb] of cbs) cb(now, { presentedFrames });
  }
  /** Test helper: emulate the browser decoding metadata. */
  loadMetadata(w: number, h: number): void {
    this.videoWidth = w;
    this.videoHeight = h;
    this.readyState = 2;
    this.dispatch('loadedmetadata');
  }
}

export class FakeTrack extends FakeEventTarget {
  kind = 'video';
  stopped = false;
  constructor(public settings: MediaTrackSettings = {}) {
    super();
  }
  stop(): void {
    this.stopped = true;
  }
  getSettings(): MediaTrackSettings {
    return this.settings;
  }
}

export class FakeStream {
  constructor(public tracks: FakeTrack[]) {}
  getTracks(): MediaStreamTrack[] {
    return this.tracks as unknown as MediaStreamTrack[];
  }
  getVideoTracks(): MediaStreamTrack[] {
    return this.tracks as unknown as MediaStreamTrack[];
  }
}

export function domError(name: string, message = name): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

export interface FakeEnvOptions {
  getUserMedia?: (c: MediaStreamConstraints) => Promise<MediaStream>;
  enumerateDevices?: () => Promise<MediaDeviceInfo[]>;
  /** When false, `mediaDevices` is undefined (insecure context). */
  hasMediaDevices?: boolean;
  video?: FakeVideo;
  visibilityState?: DocumentVisibilityState;
}

export function makeEnv(o: FakeEnvOptions = {}) {
  const video = o.video ?? new FakeVideo();
  const doc = new FakeEventTarget() as FakeEventTarget & { visibilityState: DocumentVisibilityState };
  doc.visibilityState = o.visibilityState ?? 'visible';
  const rafQueue = new Map<number, (t: number) => void>();
  let rafId = 0;
  const gumCalls: MediaStreamConstraints[] = [];
  const revoked: string[] = [];
  let objectUrls = 0;
  const mediaDevices =
    o.hasMediaDevices === false
      ? undefined
      : ({
          getUserMedia: (c: MediaStreamConstraints) => {
            gumCalls.push(c);
            return (o.getUserMedia ?? (() => Promise.resolve(new FakeStream([new FakeTrack()]) as unknown as MediaStream)))(c);
          },
          enumerateDevices: o.enumerateDevices ?? (() => Promise.resolve([])),
        } as unknown as MediaDevices);
  const env: MediaEnv = {
    mediaDevices,
    createVideo: () => video as unknown as HTMLVideoElement,
    createObjectURL: () => `blob:fake/${++objectUrls}`,
    revokeObjectURL: (u) => {
      revoked.push(u);
    },
    documentRef: doc as unknown as MediaEnv['documentRef'],
    requestAnimationFrame: (cb) => {
      const id = ++rafId;
      rafQueue.set(id, cb);
      return id;
    },
    cancelAnimationFrame: (id) => {
      rafQueue.delete(id);
    },
    now: () => 0,
  };
  return {
    env,
    video,
    doc,
    gumCalls,
    revoked,
    /** Runs all queued rAF callbacks once. */
    flushRaf(t: number): void {
      const cbs = [...rafQueue.entries()];
      rafQueue.clear();
      for (const [, cb] of cbs) cb(t);
    },
    get rafPending(): number {
      return rafQueue.size;
    },
  };
}

/** Resolve microtasks a few times. */
export async function flush(n = 5): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}
