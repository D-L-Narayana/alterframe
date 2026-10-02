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
}

export interface RuntimeStats { fps: number; frameMs: number; trackingMs: number; renderMs: number }
