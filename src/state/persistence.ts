/**
 * Settings persistence for the app store.
 *
 * Project override: settings live in MEMORY only — no localStorage/sessionStorage —
 * so the app works in sandboxed previews. The storage adapter is pluggable so a
 * Web Storage adapter could be swapped in later without touching the store logic.
 */
import {
  DEFAULT_CAPTURE_SETTINGS,
  DEFAULT_INTERACTION_SETTINGS,
  DEFAULT_LOOK,
  DEFAULT_QUALITY,
  type CaptureSettings,
  type FitMode,
  type InteractionSettings,
  type LookSettings,
  type QualitySettings,
  type SettingsSlice,
  type WindowOrdering,
} from '@/types';

export const SETTINGS_STORAGE_KEY = 'alterframe.settings.v2';
export const SETTINGS_VERSION = 2;

/** Data-only part of the settings slice (no functions). */
export type SettingsData = Omit<SettingsSlice, 'setSettings'>;

export interface SettingsStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** In-memory adapter: the default. Lives as long as the page. */
export function createMemoryStorage(): SettingsStorage {
  const map = new Map<string, string>();
  return {
    get: (k) => map.get(k) ?? null,
    set: (k, v) => {
      map.set(k, v);
    },
    remove: (k) => {
      map.delete(k);
    },
  };
}

/** Reads `prefers-reduced-motion` safely in non-DOM environments (tests, SSR). */
export function systemPrefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function defaultSettings(): SettingsData {
  return {
    mirrored: true,
    hudEnabled: true,
    hudTintAuto: true,
    showFps: false,
    debugLandmarks: false,
    interaction: { ...DEFAULT_INTERACTION_SETTINGS },
    quality: { ...DEFAULT_QUALITY },
    adaptiveQuality: true,
    reducedMotion: systemPrefersReducedMotion(),
    fitMode: 'cover',
    thinStripGlitch: false,
    look: { ...DEFAULT_LOOK },
    capture: { ...DEFAULT_CAPTURE_SETTINGS },
  };
}

interface Envelope {
  version: number;
  settings: Partial<SettingsData>;
}

export function serializeSettings(s: SettingsData): string {
  const env: Envelope = {
    version: SETTINGS_VERSION,
    settings: {
      mirrored: s.mirrored,
      hudEnabled: s.hudEnabled,
      hudTintAuto: s.hudTintAuto,
      showFps: s.showFps,
      debugLandmarks: s.debugLandmarks,
      interaction: s.interaction,
      quality: s.quality,
      adaptiveQuality: s.adaptiveQuality,
      reducedMotion: s.reducedMotion,
      fitMode: s.fitMode,
      thinStripGlitch: s.thinStripGlitch,
      look: s.look,
      capture: s.capture,
    },
  };
  return JSON.stringify(env);
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const oneOf = <T extends string | number>(v: unknown, allowed: readonly T[], fallback: T): T =>
  (allowed as readonly unknown[]).includes(v) ? (v as T) : fallback;

function parseQuality(v: unknown): QualitySettings {
  const q = isRecord(v) ? v : {};
  return {
    renderScale: clamp(num(q.renderScale, DEFAULT_QUALITY.renderScale), 0.5, 1),
    maxDpr: clamp(num(q.maxDpr, DEFAULT_QUALITY.maxDpr), 1, 3),
    segmentationStride: clamp(Math.round(num(q.segmentationStride, DEFAULT_QUALITY.segmentationStride)), 1, 4),
    inferenceMaxHeight: clamp(Math.round(num(q.inferenceMaxHeight, DEFAULT_QUALITY.inferenceMaxHeight)), 240, 2160),
    faceStride: clamp(Math.round(num(q.faceStride, DEFAULT_QUALITY.faceStride)), 1, 4),
  };
}

function parseInteraction(v: unknown): InteractionSettings {
  const i = isRecord(v) ? v : {};
  const d = DEFAULT_INTERACTION_SETTINGS;
  const ordering: WindowOrdering = i.ordering === 'faithful' ? 'faithful' : 'convex';
  return {
    ordering,
    holdMs: clamp(num(i.holdMs, d.holdMs), 0, 5000),
    fadeMs: clamp(num(i.fadeMs, d.fadeMs), 0, 5000),
    minHandScore: clamp(num(i.minHandScore, d.minHandScore), 0, 1),
    togetherDistance: clamp(num(i.togetherDistance, d.togetherDistance), 0.01, 1),
    togetherArmMs: clamp(num(i.togetherArmMs, d.togetherArmMs), 0, 5000),
    openArea: clamp(num(i.openArea, d.openArea), 0, 1),
    gestureCycleEnabled: bool(i.gestureCycleEnabled, d.gestureCycleEnabled),
    cornerSpring: clamp(num(i.cornerSpring, d.cornerSpring), 0, 0.9),
    dwellMs: clamp(num(i.dwellMs, d.dwellMs), 0, 10_000),
    dwellTolerance: clamp(num(i.dwellTolerance, d.dwellTolerance), 0.001, 0.2),
  };
}

function parseLook(v: unknown): LookSettings {
  const l = isRecord(v) ? v : {};
  const d = DEFAULT_LOOK;
  return {
    inkWidth: clamp(num(l.inkWidth, d.inkWidth), 0.25, 3),
    inkThreshold: clamp(num(l.inkThreshold, d.inkThreshold), 0.25, 3),
    halftone: clamp(num(l.halftone, d.halftone), 0, 2),
    saturation: clamp(num(l.saturation, d.saturation), 0, 2),
    bands: clamp(Math.round(num(l.bands, d.bands)), 3, 8),
    grain: clamp(num(l.grain, d.grain), 0, 3),
    overlayStrength: clamp(num(l.overlayStrength, d.overlayStrength), 0, 1),
  };
}

function parseCapture(v: unknown): CaptureSettings {
  const c = isRecord(v) ? v : {};
  const d = DEFAULT_CAPTURE_SETTINGS;
  return {
    aspect: oneOf(c.aspect, ['source', '16:9', '9:16', '1:1'] as const, d.aspect),
    selfTimer: oneOf(c.selfTimer, [0, 3, 5, 10] as const, d.selfTimer),
    autoStop: oneOf(c.autoStop, [0, 10, 15, 30, 60] as const, d.autoStop),
    snapshotFormat: oneOf(c.snapshotFormat, ['png', 'jpeg', 'webp'] as const, d.snapshotFormat),
    dwellAction: oneOf(c.dwellAction, ['off', 'snapshot', 'record'] as const, d.dwellAction),
  };
}

/**
 * Parses a persisted envelope. Returns null when the payload is missing, malformed,
 * or from a different version (we prefer defaults over guessing a migration).
 * Only known keys survive; numbers are clamped to their valid ranges.
 */
export function deserializeSettings(json: string | null): Partial<SettingsData> | null {
  if (!json) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw.version !== SETTINGS_VERSION || !isRecord(raw.settings)) return null;
  const s = raw.settings;
  const d = defaultSettings();
  const out: Partial<SettingsData> = {};
  if ('mirrored' in s) out.mirrored = bool(s.mirrored, d.mirrored);
  if ('hudEnabled' in s) out.hudEnabled = bool(s.hudEnabled, d.hudEnabled);
  if ('hudTintAuto' in s) out.hudTintAuto = bool(s.hudTintAuto, d.hudTintAuto);
  if ('showFps' in s) out.showFps = bool(s.showFps, d.showFps);
  if ('debugLandmarks' in s) out.debugLandmarks = bool(s.debugLandmarks, d.debugLandmarks);
  if ('adaptiveQuality' in s) out.adaptiveQuality = bool(s.adaptiveQuality, d.adaptiveQuality);
  if ('reducedMotion' in s) out.reducedMotion = bool(s.reducedMotion, d.reducedMotion);
  if ('quality' in s) out.quality = parseQuality(s.quality);
  if ('interaction' in s) out.interaction = parseInteraction(s.interaction);
  if ('fitMode' in s) out.fitMode = (s.fitMode === 'contain' ? 'contain' : 'cover') as FitMode;
  if ('thinStripGlitch' in s) out.thinStripGlitch = bool(s.thinStripGlitch, d.thinStripGlitch);
  if ('look' in s) out.look = parseLook(s.look);
  if ('capture' in s) out.capture = parseCapture(s.capture);
  return out;
}
