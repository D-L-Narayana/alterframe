/** Type surface of tests/fixtures/make-fixture.mjs for the TypeScript tests that import it. */
export interface Pt { x: number; y: number }
export interface ScheduleHand { side: 'left' | 'right'; palmCenter: Pt; indexTip: Pt; thumbTip: Pt }
export interface ScheduleFace { center: Pt; leftEye: Pt; rightEye: Pt; box: { x: number; y: number; w: number; h: number } }
export interface ScheduleSample {
  t: number;
  phase: string;
  together: boolean;
  palmDistance: number;
  tipArea: number;
  hands: ScheduleHand[];
  face: ScheduleFace;
}
export interface Phase { start: number; end: number; name: string; together: boolean }
export interface Schedule {
  meta: {
    generator: string;
    coordinateSpace: string;
    width: number;
    height: number;
    fps: number;
    durationS: number;
    sampleStepS: number;
    togetherDistance: number;
  };
  phases: readonly Phase[];
  samples: ScheduleSample[];
}
export interface RenderedFrame {
  Y: Uint8Array;
  U: Uint8Array;
  V: Uint8Array;
  idx: Uint8Array;
  width: number;
  height: number;
  t: number;
  sample: ScheduleSample;
}
export const FIXTURE: Readonly<{ width: number; height: number; fps: number; durationS: number; sampleStepS: number; transitionS: number }>;
export const PHASES: readonly Phase[];
export const STILL: Readonly<{ frame: number; frames: number }>;
export const FACE: Readonly<{ center: Pt; rx: number; ry: number; leftEye: Pt; rightEye: Pt; eyeR: number; mouth: { x: number; y: number; w: number; h: number } }>;
export function palmsAt(t: number): { left: Pt; right: Pt; thumb: number };
export function handFromPalm(palm: Pt, inward: 1 | -1, thumbLen?: number): { palmCenter: Pt; indexTip: Pt; thumbTip: Pt };
export function phaseAt(t: number): Phase;
export function scheduleAt(t: number): ScheduleSample;
export function buildSchedule(): Schedule;
export function renderFrame(i: number, W?: number, H?: number): RenderedFrame;
export function y4mHeader(W?: number, H?: number, fps?: number): string;
export function writeY4m(outPath: string, opts?: { frames?: number; stillFrame?: number | null; log?: (m: string) => void }): Promise<number>;
export function writeSchedule(outPath: string): Schedule;
