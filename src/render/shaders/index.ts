/**
 * Stylization shader passes (W5). Each pass is a GLSL ES 3.00 fragment body that the core
 * (W4) wraps with the shared prelude. Presets that chain them live in `../styles.ts`.
 */
import type { StylePass } from '../../types/render';
import { smoothH, smoothV } from './smooth';
import { quantizeClean, quantizeWarm } from './quantize';
import { inkPaper, inkComic } from './ink';
import { halftone } from './halftone';
import { backdrop } from './backdrop';
import { gradePaper, gradeComic } from './grade';

export { smoothH, smoothV, quantizeClean, quantizeWarm, inkPaper, inkComic, halftone, backdrop, gradePaper, gradeComic };
export { PRELUDE, glsl, glslUniformDecls, inkWidthTexels, pxScale } from './glsl';
export { hexToRgb } from './ink';

/** Every pass we ship, for tests and the compile harness. */
export const ALL_PASSES: readonly StylePass[] = [
  smoothH, smoothV, quantizeClean, quantizeWarm, inkPaper, inkComic, halftone, backdrop, gradePaper, gradeComic,
];
