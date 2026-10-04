export type SourceKind = 'camera' | 'file';

export interface CameraOptions {
  deviceId?: string;
  facingMode?: 'user' | 'environment';
  /** Ideal capture size; actual may differ. Default 1280x720. */
  width?: number;
  height?: number;
  frameRate?: number;
}

export type SourceStatus = 'idle' | 'requesting' | 'ready' | 'denied' | 'unavailable' | 'error';

/** Playback controls of a file source (cameras have none). */
export interface FileTransport {
  play(): Promise<boolean>;
  pause(): void;
  /** Seek to an absolute position in seconds (clamped to [0, duration]). */
  seek(seconds: number): void;
  setLoop(loop: boolean): void;
  readonly paused: boolean;
  readonly currentTime: number;
  /** Seconds; NaN until metadata is known. */
  readonly duration: number;
  readonly loop: boolean;
}

/** Snapshot of a FileTransport mirrored into the session slice for the UI. */
export interface TransportState { paused: boolean; currentTime: number; duration: number; loop: boolean }

export interface FrameSource {
  readonly kind: SourceKind;
  readonly video: HTMLVideoElement;
  readonly status: SourceStatus;
  readonly width: number;
  readonly height: number;
  /** Camera facing; file sources report 'user' and should still be mirrored by default. */
  readonly facingMode: 'user' | 'environment';
  start(): Promise<void>;
  stop(): void;
  /** Resolves on each new video frame (requestVideoFrameCallback with rAF fallback). */
  onFrame(cb: (t: number, meta: { presentedFrames: number }) => void): () => void;
  /** Enumerated devices (camera sources only). */
  listDevices?(): Promise<MediaDeviceInfo[]>;
  /** Human-readable error for `denied | unavailable | error`, else null. */
  readonly error?: string | null;
  /** Fires on every status transition. Returns unsubscribe. */
  onStatus?(cb: (status: SourceStatus, error: string | null) => void): () => void;
  /** Playback controls (file sources only). */
  readonly transport?: FileTransport;
}

export interface RuntimeStats { fps: number; frameMs: number; trackingMs: number; renderMs: number }
