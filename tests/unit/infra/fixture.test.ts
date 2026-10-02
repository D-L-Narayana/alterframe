/** Fixture generator (owner: W10): schedule semantics + Y4M framing + a few rasterized pixels. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FIXTURE, PHASES, FACE, scheduleAt, buildSchedule, renderFrame, y4mHeader, palmsAt } from '../../fixtures/make-fixture.mjs';

describe('fixture schedule', () => {
  it('phases cover 0–12 s contiguously in the contract order', () => {
    expect(PHASES.map((p) => [p.start, p.end])).toEqual([
      [0, 2],
      [2, 8],
      [8, 10],
      [10, 12],
    ]);
    expect(PHASES.map((p) => p.together)).toEqual([true, false, true, false]);
  });

  it('together phases satisfy W7 gesture semantics (palms < 0.12 apart AND tip-quad area < openArea/2); apart phases open the window (area > openArea)', () => {
    for (const t of [0.5, 1, 1.5, 8.5, 9, 9.5]) {
      const s = scheduleAt(t);
      expect(s.together, `t=${t}`).toBe(true);
      expect(s.palmDistance).toBeLessThan(0.12);
      expect(s.tipArea).toBeLessThan(0.01);
    }
    for (const t of [3, 5, 7, 10.5, 11, 11.9]) {
      const s = scheduleAt(t);
      expect(s.together, `t=${t}`).toBe(false);
      expect(s.tipArea, `t=${t} window area > openArea (0.02)`).toBeGreaterThan(0.02);
    }
  });

  it('hands are sorted screen-left first with index tips above palms and thumbs pointing inward', () => {
    const s = scheduleAt(5);
    const [L, R] = s.hands;
    expect(L!.side).toBe('left');
    expect(R!.side).toBe('right');
    expect(L!.palmCenter.x).toBeLessThan(R!.palmCenter.x);
    expect(L!.indexTip.y).toBeLessThan(L!.palmCenter.y);
    expect(R!.indexTip.y).toBeLessThan(R!.palmCenter.y);
    expect(L!.thumbTip.x).toBeGreaterThan(L!.palmCenter.x);
    expect(R!.thumbTip.x).toBeLessThan(R!.palmCenter.x);
  });

  it('2–8 s pose is skewed (left hand higher); 10–12 s pose is level and wide', () => {
    const skew = scheduleAt(5);
    expect(skew.hands[0]!.palmCenter.y).toBeLessThan(skew.hands[1]!.palmCenter.y - 0.1);
    const wide = scheduleAt(11);
    expect(Math.abs(wide.hands[0]!.palmCenter.y - wide.hands[1]!.palmCenter.y)).toBeLessThan(1e-9);
    expect(wide.hands[1]!.palmCenter.x - wide.hands[0]!.palmCenter.x).toBeGreaterThan(0.6);
  });

  it('motion is continuous (no teleport): max per-frame displacement is small', () => {
    let maxStep = 0;
    let prev = palmsAt(0);
    for (let i = 1; i <= FIXTURE.fps * FIXTURE.durationS; i++) {
      const cur = palmsAt(i / FIXTURE.fps);
      maxStep = Math.max(maxStep, Math.hypot(cur.left.x - prev.left.x, cur.left.y - prev.left.y), Math.hypot(cur.right.x - prev.right.x, cur.right.y - prev.right.y));
      prev = cur;
    }
    expect(maxStep).toBeLessThan(0.06);
  });

  it('all coordinates stay inside [0,1]', () => {
    const sched = buildSchedule();
    for (const s of sched.samples) {
      for (const h of s.hands) {
        for (const p of [h.palmCenter, h.indexTip, h.thumbTip]) {
          expect(p.x).toBeGreaterThanOrEqual(0);
          expect(p.x).toBeLessThanOrEqual(1);
          expect(p.y).toBeGreaterThanOrEqual(0);
          expect(p.y).toBeLessThanOrEqual(1);
        }
      }
    }
    expect(sched.samples.length).toBe(FIXTURE.durationS / FIXTURE.sampleStepS + 1);
  });

  it('committed hands.schedule.json matches the generator output', () => {
    const committed = JSON.parse(readFileSync(fileURLToPath(new URL('../../fixtures/hands.schedule.json', import.meta.url)), 'utf8'));
    expect(committed).toEqual(JSON.parse(JSON.stringify(buildSchedule())));
  });
});

describe('fixture raster', () => {
  it('Y4M header is Chromium-compatible I420', () => {
    expect(y4mHeader()).toBe('YUV4MPEG2 W640 H360 F30:1 Ip A1:1 C420jpeg\n');
  });

  it('frame planes have I420 sizes', () => {
    const f = renderFrame(0);
    expect(f.Y.length).toBe(640 * 360);
    expect(f.U.length).toBe(320 * 180);
    expect(f.V.length).toBe(320 * 180);
  });

  it('draws the head at the mirrored face centre and background elsewhere', () => {
    const f = renderFrame(150);
    const W = f.width;
    const px = (nx: number, ny: number): number => f.idx[Math.round(ny * f.height) * W + Math.round((1 - nx) * W)]!;
    expect(px(FACE.center.x, FACE.center.y)).toBe(1); // skin
    expect(px(FACE.leftEye.x, FACE.leftEye.y)).toBe(2); // eye
    expect(px(0.05, 0.05)).toBe(0); // background corner
  });

  it('draws the screen-left hand on the camera-right side (mirror) at t=5 s', () => {
    const f = renderFrame(150);
    const L = f.sample.hands[0]!;
    const camX = Math.round((1 - L.palmCenter.x) * f.width);
    const camY = Math.round(L.palmCenter.y * f.height);
    expect(camX).toBeGreaterThan(f.width / 2);
    expect(f.idx[camY * f.width + camX]).toBe(1);
    // Index tip highlight above the palm.
    const tipY = Math.round(L.indexTip.y * f.height);
    expect(f.idx[(tipY + 1) * f.width + camX]).not.toBe(0);
  });
});
