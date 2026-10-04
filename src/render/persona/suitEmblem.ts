import type { Vec2 } from '../../types';

/*
 * Original, stylised spider crest for the suit persona: a small round head, an elongated oval
 * abdomen and eight legs, each a root→knee→tip polyline (drawn as quadratic curves). Pure data;
 * the overlay draws it. Nothing here is derived from any existing logo.
 */

export interface SpiderLeg { root: Vec2; knee: Vec2; tip: Vec2 }
export interface SpiderEmblem {
  center: Vec2;
  head: { c: Vec2; r: number };
  abdomen: { c: Vec2; rx: number; ry: number };
  legs: SpiderLeg[];
  /** Total horizontal span of the crest (px). */
  span: number;
}

/** Leg descriptors in units of half-span: angle from +x (deg, measured upward) and relative lengths. */
const LEG_ANGLES_DEG = [62, 28, -8, -42] as const;   // front → back, one side
const LEG_KNEE = 0.55;                                 // knee at 55 % of the reach
const LEG_LIFT = 0.28;                                 // knee lifted above the straight line (fraction of reach)

/** Build the crest centred at `center`, with a total span of 1.1 × `faceWidth`. */
export function spiderEmblem(center: Vec2, faceWidth: number): SpiderEmblem {
  const span = faceWidth * 1.1;
  const half = span / 2;
  const headR = half * 0.17;
  const abdomen = { c: { x: center.x, y: center.y + half * 0.3 }, rx: half * 0.26, ry: half * 0.42 };
  const head = { c: { x: center.x, y: center.y - half * 0.1 }, r: headR };
  const legs: SpiderLeg[] = [];
  for (const side of [-1, 1] as const) {
    for (const deg of LEG_ANGLES_DEG) {
      const a = (deg * Math.PI) / 180;
      const dir = { x: Math.cos(a) * side, y: -Math.sin(a) };          // y up on screen = negative
      const root = { x: center.x + dir.x * headR * 1.1, y: center.y + dir.y * headR * 0.6 };
      // reach is chosen so the tip x lands exactly on ±half for the widest leg (cos(-8°) ≈ 0.99)
      const reach = (half - headR * 1.1) / Math.cos((-8 * Math.PI) / 180);
      const tip = { x: root.x + dir.x * reach, y: root.y + dir.y * reach };
      // knee: part way along the leg, lifted straight up so every leg arches like a crouching spider
      const knee = { x: root.x + dir.x * reach * LEG_KNEE, y: root.y + dir.y * reach * LEG_KNEE - reach * LEG_LIFT };
      legs.push({ root, knee, tip });
    }
  }
  return { center, head, abdomen, legs, span };
}
