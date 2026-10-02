import type { FrameSource } from '@/types';
import { createCameraSource, createFileSource } from './runtimeBridge';

/** What the user asked to look at. Kept in React state (a File cannot live in the shared store). */
export type SourceSpec =
  | { kind: 'camera'; deviceId: string | null; facingMode: 'user' | 'environment' }
  | { kind: 'file'; file: File };

export function createSourceFromSpec(spec: SourceSpec): FrameSource {
  if (spec.kind === 'file') return createFileSource(spec.file);
  return createCameraSource({
    ...(spec.deviceId ? { deviceId: spec.deviceId } : {}),
    facingMode: spec.facingMode,
    width: 1280,
    height: 720,
    frameRate: 30,
  });
}
