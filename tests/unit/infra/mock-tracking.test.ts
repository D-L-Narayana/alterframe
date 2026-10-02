/** Mock tracking builder (owner: W10): produces contract-shaped TrackingFrames from the schedule. */
import { describe, it, expect } from 'vitest';
import { HAND_LM, FACE_LM } from '@/types';
import { buildTrackingFrame, sampleAt, samplesInPhase, SCHEDULE_SAMPLES, POSES, FACE_OVAL } from '../../e2e/helpers/mockTracking';

describe('buildTrackingFrame', () => {
  const frame = buildTrackingFrame(POSES.skewed, 1234);

  it('stamps time and source size', () => {
    expect(frame.t).toBe(1234);
    expect(frame.sourceWidth).toBe(640);
    expect(frame.sourceHeight).toBe(360);
    expect(frame.segmentation).not.toBeNull();
  });

  it('segmentation mask is 256² display-space with person=1 at the face centre and 0 at the top-left corner', () => {
    const seg = frame.segmentation!;
    expect(seg.width).toBe(256);
    expect(seg.height).toBe(256);
    expect(seg.data.length).toBe(256 * 256);
    const at = (nx: number, ny: number) => seg.data[Math.floor(ny * 256) * 256 + Math.floor(nx * 256)]!;
    const f = POSES.skewed.face!;
    expect(at(f.center.x, f.center.y)).toBe(1);
    expect(at(0.02, 0.02)).toBe(0);
    const L = POSES.skewed.hands[0]!;
    expect(at(L.palmCenter.x, L.palmCenter.y)).toBe(1);
    expect(at(L.indexTip.x, L.indexTip.y + 0.01)).toBe(1);
    expect(buildTrackingFrame(POSES.skewed, 0, { withSegmentation: false }).segmentation).toBeNull();
  });

  it('produces two hands sorted by palmCenter.x with sides by screen position', () => {
    expect(frame.hands).toHaveLength(2);
    expect(frame.hands[0]!.palmCenter.x).toBeLessThan(frame.hands[1]!.palmCenter.x);
    expect(frame.hands.map((h) => h.side)).toEqual(['left', 'right']);
  });

  it('each hand has 21 landmarks; tips match landmarks 8 and 4', () => {
    for (const h of frame.hands) {
      expect(h.landmarks).toHaveLength(21);
      expect(h.landmarks[HAND_LM.INDEX_TIP]!.x).toBeCloseTo(h.indexTip.x, 9);
      expect(h.landmarks[HAND_LM.INDEX_TIP]!.y).toBeCloseTo(h.indexTip.y, 9);
      expect(h.landmarks[HAND_LM.THUMB_TIP]!.x).toBeCloseTo(h.thumbTip.x, 9);
      expect(h.landmarks[HAND_LM.THUMB_TIP]!.y).toBeCloseTo(h.thumbTip.y, 9);
      expect(h.score).toBeGreaterThan(0.5);
      expect(h.size).toBeGreaterThan(0.03);
    }
  });

  it('L pose: index tip above thumb tip (window height = index–thumb gap)', () => {
    for (const h of frame.hands) expect(h.indexTip.y).toBeLessThan(h.thumbTip.y - 0.1);
  });

  it('face has 478 landmarks with named anchors consistent with FACE_LM indices', () => {
    const f = frame.face!;
    expect(f.landmarks).toHaveLength(478);
    expect(f.leftEye.x).toBeLessThan(f.rightEye.x);
    expect(f.landmarks[FACE_LM.LEFT_IRIS_CENTER]!.x).toBeCloseTo(f.leftEye.x, 9);
    expect(f.landmarks[FACE_LM.RIGHT_IRIS_CENTER]!.x).toBeCloseTo(f.rightEye.x, 9);
    expect(f.landmarks[FACE_LM.CHIN]!.y).toBeCloseTo(f.chin.y, 9);
    expect(f.landmarks[FACE_LM.FOREHEAD]!.y).toBeCloseTo(f.forehead.y, 9);
    expect(f.landmarks[FACE_LM.MOUTH_LEFT]!.x).toBeLessThan(f.landmarks[FACE_LM.MOUTH_RIGHT]!.x);
    expect(f.landmarks[FACE_LM.UPPER_LIP]!.y).toBeLessThan(f.landmarks[FACE_LM.LOWER_LIP]!.y);
    for (const idx of FACE_OVAL) {
      const p = f.landmarks[idx]!;
      // On the ellipse boundary: ((x-cx)/rx)^2 + ((y-cy)/ry)^2 ≈ 1
      const cx = f.faceBox.x + f.faceBox.w / 2;
      const cy = f.faceBox.y + f.faceBox.h / 2;
      const v = ((p.x - cx) / (f.faceBox.w / 2)) ** 2 + ((p.y - cy) / (f.faceBox.h / 2)) ** 2;
      expect(v).toBeCloseTo(1, 6);
    }
    expect(Object.keys(f.blendshapes)).toEqual(expect.arrayContaining(['eyeBlinkLeft', 'eyeBlinkRight', 'jawOpen', 'mouthSmileLeft', 'mouthSmileRight']));
  });

  it('mouthOpen option moves the lower lip and the scalar', () => {
    const open = buildTrackingFrame(POSES.skewed, 0, { mouthOpen: 0.6 }).face!;
    const closed = buildTrackingFrame(POSES.skewed, 0, { mouthOpen: 0.0 }).face!;
    expect(open.mouthOpen).toBe(0.6);
    expect(open.landmarks[FACE_LM.LOWER_LIP]!.y).toBeGreaterThan(closed.landmarks[FACE_LM.LOWER_LIP]!.y);
  });

  it('handCount / withFace options drop hands and face', () => {
    expect(buildTrackingFrame(POSES.wide, 0, { handCount: 0 }).hands).toHaveLength(0);
    expect(buildTrackingFrame(POSES.wide, 0, { handCount: 1 }).hands).toHaveLength(1);
    expect(buildTrackingFrame(POSES.wide, 0, { withFace: false }).face).toBeNull();
  });

  it('is self-contained: source has no free identifiers from this module', () => {
    const src = buildTrackingFrame.toString();
    for (const forbidden of ['FACE_OVAL', 'SCHEDULE_SAMPLES', 'sampleAt', 'import(', 'require(']) expect(src).not.toContain(forbidden);
  });
});

describe('schedule helpers', () => {
  it('interpolates between samples', () => {
    const a = sampleAt(2.0);
    const b = sampleAt(2.25);
    const c = sampleAt(2.5);
    expect(b.hands[0]!.palmCenter.x).toBeCloseTo((a.hands[0]!.palmCenter.x + c.hands[0]!.palmCenter.x) / 2, 9);
  });

  it('phase filters work and named poses are correct', () => {
    expect(samplesInPhase('together').every((s) => s.together)).toBe(true);
    expect(samplesInPhase('apart-wide').length).toBeGreaterThan(3);
    expect(POSES.together.together).toBe(true);
    expect(POSES.skewed.phase).toBe('apart-skewed');
    expect(POSES.wide.phase).toBe('apart-wide');
    expect(SCHEDULE_SAMPLES.length).toBe(25);
  });
});
