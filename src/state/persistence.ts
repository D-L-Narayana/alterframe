/**
 * Settings persistence for the app store (W1).
 *
 * Project override: settings live in MEMORY only — no localStorage/sessionStorage —
 * so the app works in sandboxed previews. The storage adapter is pluggable so the lead
 * can swap in a Web Storage adapter later without touching the store logic.
 */
import {
  DEFAULT_INTERACTION_SETTINGS,
  DEFAULT_QUALITY,
  type InteractionSettings,
  type QualitySettings,
  type SettingsSlice,
  type WindowOrdering,
} from '@/types';

export const SETTINGS_STORAGE_KEY = 'alterframe.settings.v1';
export const SETTINGS_VERSION = 1;

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
    },
  };
  return JSON.stringify(env);
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

function parseQuality(v: unknown): QualitySettings {
  const q = isRecord(v) ? v : {};
  return {
    renderScale: clamp(num(q.renderScale, DEFAULT_QUALITY.renderScale), 0.5, 1),
    maxDpr: clamp(num(q.maxDpr, DEFAULT_QUALITY.maxDpr), 1, 3),
    segmentationStride: clamp(Math.round(num(q.segmentationStride, DEFAULT_QUALITY.segmentationStride)), 1, 4),
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
  return out;
}
