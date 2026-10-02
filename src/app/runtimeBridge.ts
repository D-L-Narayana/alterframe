/**
 * Single import point for W2's runtime + media sources so the App only depends on the
 * contract names (`startRuntime`, `createCameraSource`, `createFileSource`). If W2 has not
 * landed yet this is the only W1 file that fails to type-check.
 */
export { startRuntime } from '@/runtime';
export { createCameraSource } from '@/media/cameraSource';
export { createFileSource } from '@/media/fileSource';
