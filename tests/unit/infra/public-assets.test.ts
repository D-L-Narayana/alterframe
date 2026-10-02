/** Public icons + manifest (owner: W10). */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { APP_ROOT } from './paths';

interface Manifest { name: string; short_name: string; start_url: string; display: string; background_color: string; theme_color: string; icons: { src: string; sizes: string; type: string; purpose?: string }[] }
const manifest = JSON.parse(readFileSync(join(APP_ROOT, 'public/manifest.webmanifest'), 'utf8')) as Manifest;

describe('manifest.webmanifest', () => {
  it('has required fields and dark theme colours from the design system', () => {
    expect(manifest.name).toBe('AlterFrame');
    expect(manifest.short_name.length).toBeLessThanOrEqual(12);
    // Relative so the PWA also works when hosted under a sub-path (Vite base './').
    expect(manifest.start_url).toBe('./');
    expect(['standalone', 'fullscreen', 'minimal-ui']).toContain(manifest.display);
    expect(manifest.background_color.toLowerCase()).toBe('#0b0b0d');
    expect(manifest.theme_color.toLowerCase()).toBe('#0b0b0d');
  });

  it('every icon exists, is SVG, declares sizes and includes a maskable one', () => {
    expect(manifest.icons.length).toBeGreaterThanOrEqual(2);
    for (const icon of manifest.icons) {
      const p = join(APP_ROOT, 'public', icon.src.replace(/^\.?\//, ''));
      expect(existsSync(p), `${icon.src} exists`).toBe(true);
      expect(icon.type).toBe('image/svg+xml');
      expect(icon.sizes).toMatch(/^\d+x\d+( \d+x\d+)*$|^any$/);
      const svg = readFileSync(p, 'utf8');
      expect(svg).toMatch(/^<svg[\s>]/);
      expect(svg).toMatch(/viewBox="0 0 \d+ \d+"/);
      expect(svg).not.toMatch(/<script|<image|href="http/);
    }
    expect(manifest.icons.some((i) => i.purpose?.includes('maskable'))).toBe(true);
  });
});

describe('favicon and index.html links', () => {
  it('favicon.svg exists and is self-contained', () => {
    const svg = readFileSync(join(APP_ROOT, 'public/favicon.svg'), 'utf8');
    expect(svg).toMatch(/^<svg/);
    expect(svg).not.toMatch(/<script|href="http/);
  });

  it('index.html links favicon, manifest and theme-color', () => {
    const html = readFileSync(join(APP_ROOT, 'index.html'), 'utf8');
    expect(html).toMatch(/<link rel="icon"[^>]*href="\/favicon\.svg"/);
    expect(html).toMatch(/<link rel="manifest" href="\/manifest\.webmanifest"/);
    expect(html).toMatch(/<meta name="theme-color" content="#0b0b0d"/);
    expect(html).not.toMatch(/<script\b(?![^>]*\bsrc=)[^>]*>\s*\S/);
  });
});
