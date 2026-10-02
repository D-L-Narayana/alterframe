/**
 * W2 — media sources. Public surface:
 *   createCameraSource(opts, env?)  → CameraSource (FrameSource + status events + device list)
 *   createFileSource(file|url, env?) → FileSource (FrameSource + play/pause)
 *   MediaSourceError                 → rejection type of start()
 *   isObservableSource / isCameraSource / isFileSource → guards for extended features
 */
export { createCameraSource, buildCameraConstraints, isCameraSource, type CameraSource } from './cameraSource';
export { createFileSource, describeMediaError, isFileSource, type FileSource } from './fileSource';
export { MediaSourceError, classifyGetUserMediaError, type SourceFailureStatus } from './errors';
export { isObservableSource, type ObservableFrameSource } from './sourceBase';
export { createFrameClock, type FrameClock, type FrameCallback } from './frameClock';
export { defaultMediaEnv, resolveMediaEnv, type MediaEnv } from './env';
