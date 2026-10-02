import type { FaceTrack, TrackingFrame, WindowQuad, SceneState, Vec2, Vec3 } from '../../../src/types';

/** Synthetic face: eyes at given screen positions, mouth below the nose. */
export function makeFace(partial: Partial<FaceTrack> = {}): FaceTrack {
  const leftEye: Vec2 = { x: 0.45, y: 0.40 };
  const rightEye: Vec2 = { x: 0.55, y: 0.40 };
  const landmarks: Vec3[] = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  // Mouth corners (FACE_LM.MOUTH_LEFT = 61, MOUTH_RIGHT = 291), lips 13/14.
  landmarks[61] = { x: 0.47, y: 0.58, z: 0 };
  landmarks[291] = { x: 0.53, y: 0.58, z: 0 };
  landmarks[13] = { x: 0.5, y: 0.57, z: 0 };
  landmarks[14] = { x: 0.5, y: 0.60, z: 0 };
  return {
    landmarks,
    blendshapes: {},
    transform: null,
    leftEye,
    rightEye,
    noseTip: { x: 0.5, y: 0.48 },
    chin: { x: 0.5, y: 0.66 },
    forehead: { x: 0.5, y: 0.30 },
    faceBox: { x: 0.4, y: 0.3, w: 0.2, h: 0.36 },
    roll: 0,
    eyeOpenLeft: 1,
    eyeOpenRight: 1,
    mouthOpen: 0,
    smile: 0,
    ...partial,
  };
}

export function makeFrame(partial: Partial<TrackingFrame> = {}): TrackingFrame {
  return {
    t: 0,
    sourceWidth: 1280,
    sourceHeight: 720,
    hands: [],
    face: null,
    segmentation: null,
    timings: { handsMs: 0, faceMs: 0, segMs: 0, totalMs: 0 },
    ...partial,
  };
}

export function makeQuad(partial: Partial<WindowQuad> = {}): WindowQuad {
  const corners: WindowQuad['corners'] = [
    { x: 0.30, y: 0.25 },
    { x: 0.70, y: 0.25 },
    { x: 0.70, y: 0.60 },
    { x: 0.30, y: 0.60 },
  ];
  return {
    corners,
    opacity: 1,
    thickness: 0.35,
    area: 0.14,
    centroid: { x: 0.5, y: 0.425 },
    visible: true,
    ordering: 'convex',
    ...partial,
  };
}

export const LIVE_SCENE: SceneState = { base: 'live', persona: 'portrait', hudTint: 'white' };
export const COMIC_SCENE: SceneState = { base: 'comic', persona: 'masked', hudTint: 'red' };

export const NO_EXTRAS = { recording: false, fps: null, showFps: false } as const;
