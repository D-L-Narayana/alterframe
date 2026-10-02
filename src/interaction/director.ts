/**
 * W7 — Director: auto-plays the reference phase order (REFERENCE_SEQUENCE) in a loop.
 * Pure time → step mapping is exported separately so e2e/unit tests can assert boundaries.
 */
import { REFERENCE_SEQUENCE } from '../types';
import type { Director, DirectorStep, SceneState } from '../types';

/** Director with an extra `stepIndex(t)` helper (structurally still a `Director`). */
export interface DirectorWithSteps extends Director {
  /** Index into the sequence for absolute time t, or -1 when not running / sequence empty. */
  stepIndex(t: number): number;
  readonly sequence: readonly DirectorStep[];
}

/** Scene for a step; hudTint derived from the base (comic → red, else white), as observed. */
export function sceneForStep(step: DirectorStep): SceneState {
  return { base: step.base, persona: step.persona, hudTint: step.base === 'comic' ? 'red' : 'white' };
}

/**
 * Maps elapsed ms (since start) to a step index, looping over the total duration.
 * Steps with non-positive / non-finite duration are skipped. Returns -1 if nothing is playable.
 * Negative or non-finite elapsed clamps to 0 (first playable step). Intervals are half-open:
 * the boundary instant belongs to the following step.
 */
export function stepIndexAt(sequence: readonly DirectorStep[], elapsedMs: number): number {
  let total = 0;
  for (const s of sequence) if (Number.isFinite(s.durationMs) && s.durationMs > 0) total += s.durationMs;
  if (total <= 0) return -1;
  const e = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs % total : 0;
  let acc = 0;
  for (let i = 0; i < sequence.length; i++) {
    const d = sequence[i]!.durationMs;
    if (!Number.isFinite(d) || d <= 0) continue;
    acc += d;
    if (e < acc) return i;
  }
  // Floating-point tail: e can equal total-ε after modulo; last playable step.
  for (let i = sequence.length - 1; i >= 0; i--) {
    const d = sequence[i]!.durationMs;
    if (Number.isFinite(d) && d > 0) return i;
  }
  return -1;
}

export function createDirector(sequence: readonly DirectorStep[] = REFERENCE_SEQUENCE): DirectorWithSteps {
  // Defensive copy so callers can't mutate our timeline mid-play (and we never mutate theirs).
  const steps: readonly DirectorStep[] = sequence.map((s) => ({ ...s }));
  let running = false;
  let startT = 0;

  const elapsed = (t: number): number => (Number.isFinite(t) ? Math.max(0, t - startT) : 0);

  return {
    sequence: steps,
    get running() {
      return running;
    },
    start(t) {
      startT = Number.isFinite(t) ? t : 0;
      running = true;
    },
    stop() {
      running = false;
    },
    stepIndex(t) {
      if (!running) return -1;
      return stepIndexAt(steps, elapsed(t));
    },
    update(t) {
      if (!running) return null;
      const i = stepIndexAt(steps, elapsed(t));
      const step = i >= 0 ? steps[i] : undefined;
      return step ? sceneForStep(step) : null;
    },
  };
}
