/**
 * Shared geometry primitives. ALL coordinates exchanged between modules are in
 * NORMALIZED DISPLAY SPACE: x,y in [0,1], origin top-left, x→right, y→down,
 * AFTER mirroring has been applied (so what the user sees on screen-left is x≈0).
 * Pixel conversion happens only at the edges (renderer / canvas overlays).
 */
export interface Vec2 { x: number; y: number }
export interface Vec3 extends Vec2 { z: number }
export interface Rect { x: number; y: number; w: number; h: number }
export interface Size { width: number; height: number }

/** Four corners in order TL, TR, BR, BL (screen-left hand supplies TL/BL). */
export type QuadCorners = [Vec2, Vec2, Vec2, Vec2];
