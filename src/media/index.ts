/**
 * Media sources. Public surface:
 *   createCameraSource(opts, env?)  → CameraSource (FrameSource + status events + device list)
 *   createFileSource(file|url, env?) → FileSource (FrameSource + transport: play/pause/seek/loop + onTransport)
 *   MediaSourceError                 → rejection type of start()
 *   isObservableSource / isCameraSource / isFileSource / hasTransportEvents → guards for extended features
 */
export { createCameraSource, buildCameraConstraints, isCameraSource, type CameraSource } from './cameraSource';
export { createFileSource, describeMediaError, isFileSource, hasTransportEvents, type FileSource, type TransportEventSource, type TransportListener } from './fileSource';
export { MediaSourceError, classifyGetUserMediaError, type SourceFailureStatus } from './errors';
export { isObservableSource, type ObservableFrameSource } from './sourceBase';
export { createFrameClock, type FrameClock, type FrameCallback } from './frameClock';
export { defaultMediaEnv, resolveMediaEnv, type MediaEnv } from './env';
export type { FileTransport, TransportState } from '@/types';
