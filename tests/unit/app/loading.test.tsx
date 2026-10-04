/**
 * Loading progress + tracker failure recovery (SSR semantics, no DOM).
 * Contract names come from the v0.2 shared UI contract: progressbar "Loading tracking models",
 * alert "Tracking models could not be loaded" with "Retry tracking" / "Continue without tracking".
 */
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Stage, TrackerProgress } from '@/app/Stage';
import { TrackerFailureCard } from '@/app/TrackerFailureCard';

const buttons = (html: string) => html.match(/<button[^>]*>/g) ?? [];

describe('TrackerProgress', () => {
  it('is a determinate progressbar named "Loading tracking models" with a 0..100 value', () => {
    const html = renderToStaticMarkup(<TrackerProgress progress={0.42} />);
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-label="Loading tracking models"');
    expect(html).toContain('aria-valuemin="0"');
    expect(html).toContain('aria-valuemax="100"');
    expect(html).toContain('aria-valuenow="42"');
    // The visual bar follows the value.
    expect(html).toContain('width:42%');
  });

  it('clamps and rounds the progress fraction', () => {
    expect(renderToStaticMarkup(<TrackerProgress progress={-0.5} />)).toContain('aria-valuenow="0"');
    expect(renderToStaticMarkup(<TrackerProgress progress={1.7} />)).toContain('aria-valuenow="100"');
    expect(renderToStaticMarkup(<TrackerProgress progress={0.999} />)).toContain('aria-valuenow="100"');
    expect(renderToStaticMarkup(<TrackerProgress progress={Number.NaN} />)).toContain('aria-valuenow="0"');
  });

  it('Stage shows the progressbar only while loading', () => {
    const loading = renderToStaticMarkup(<Stage loading />);
    expect(loading).toContain('<canvas id="stage"');
    expect(loading).toContain('role="progressbar"');
    expect(loading).toContain('Loading tracking models');
    const ready = renderToStaticMarkup(<Stage loading={false} />);
    expect(ready).toContain('<canvas id="stage"');
    expect(ready).not.toContain('role="progressbar"');
  });
});

describe('TrackerFailureCard', () => {
  it('is an alert naming the failure and offering both recovery actions', () => {
    const onRetry = vi.fn();
    const onContinue = vi.fn();
    const html = renderToStaticMarkup(<TrackerFailureCard message="404 hand_landmarker.task" onRetry={onRetry} onContinue={onContinue} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain('Tracking models could not be loaded');
    expect(html).toContain('404 hand_landmarker.task');
    expect(html).toContain('Retry tracking');
    expect(html).toContain('Continue without tracking');
    expect(buttons(html).length).toBe(2);
  });

  it('falls back to a generic message when none is known', () => {
    const html = renderToStaticMarkup(<TrackerFailureCard message="" onRetry={() => {}} onContinue={() => {}} />);
    expect(html).toContain('Tracking models could not be loaded');
    expect(html).toMatch(/check your connection|try again/i);
  });
});
