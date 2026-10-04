import { DEFAULT_LOOK, type AutoStopSeconds, type CaptureAspect, type DwellAction, type FitMode, type HudTint, type LookSettings, type RuntimeDiagnostics, type SelfTimerSeconds, type SnapshotFormat, type WindowOrdering } from '@/types';
import { useAppStore } from '@/state/store';
import { useSettings } from '@/state/hooks';
import { defaultSettings } from '@/state/persistence';
import { Button, Segmented, Sheet, Slider, Toggle } from '@/ui';
import { Diagnostics } from './Diagnostics';

type TintChoice = 'auto' | HudTint;
type SelfTimerKey = '0' | '3' | '5' | '10';
type AutoStopKey = '0' | '10' | '15' | '30' | '60';
type ResolutionKey = '720' | '480' | '360';

const SELF_TIMER_OPTIONS = [
  { value: '0', label: 'Off' },
  { value: '3', label: '3 s' },
  { value: '5', label: '5 s' },
  { value: '10', label: '10 s' },
] as const satisfies ReadonlyArray<{ value: SelfTimerKey; label: string }>;

const AUTO_STOP_OPTIONS = [
  { value: '0', label: 'Off' },
  { value: '10', label: '10 s' },
  { value: '15', label: '15 s' },
  { value: '30', label: '30 s' },
  { value: '60', label: '60 s' },
] as const satisfies ReadonlyArray<{ value: AutoStopKey; label: string }>;

const RESOLUTION_OPTIONS = [
  { value: '720', label: 'Full' },
  { value: '480', label: '480p' },
  { value: '360', label: '360p' },
] as const satisfies ReadonlyArray<{ value: ResolutionKey; label: string }>;

/** Hold time applied when "Hold still to capture" is switched on while the detector was off (0). */
export const DEFAULT_DWELL_MS = 1500;
const MANAGED_HINT = 'Managed automatically while adaptive quality is on';

/** Snaps any persisted/adaptive value to the nearest rung so the segmented control always shows a choice. */
export function resolutionKey(inferenceMaxHeight: number): ResolutionKey {
  return inferenceMaxHeight >= 600 ? '720' : inferenceMaxHeight >= 420 ? '480' : '360';
}

const times = (v: number) => `×${v.toFixed(2)}`;
const percent = (v: number) => `${Math.round(v * 100)}%`;

export interface SettingsSheetProps {
  open: boolean;
  onClose(): void;
  /** Esc inside the sheet (defaults to onClose); the App routes it through the Esc priority. */
  onEscape?: () => void;
  /** Live diagnostics reader (`handle.getDiagnostics?.()`); polled at 2 Hz while the sheet is open. */
  getDiagnostics?: () => RuntimeDiagnostics | null;
}

export function SettingsSheet({ open, onClose, onEscape, getDiagnostics }: SettingsSheetProps) {
  const settings = useSettings();
  const scene = useAppStore((s) => s.scene);
  const setSettings = useAppStore((s) => s.setSettings);
  const setScene = useAppStore((s) => s.setScene);

  const tint: TintChoice = settings.hudTintAuto ? 'auto' : scene.hudTint;
  const setTint = (t: TintChoice) => {
    if (t === 'auto') setSettings({ hudTintAuto: true });
    else {
      setSettings({ hudTintAuto: false });
      setScene({ hudTint: t });
    }
  };

  const setLook = (partial: Partial<LookSettings>) => setSettings({ look: { ...settings.look, ...partial } });
  const setCapture = (partial: Partial<typeof settings.capture>) => setSettings({ capture: { ...settings.capture, ...partial } });
  const setQuality = (partial: Partial<typeof settings.quality>) => setSettings({ quality: { ...settings.quality, ...partial } });
  const setInteraction = (partial: Partial<typeof settings.interaction>) => setSettings({ interaction: { ...settings.interaction, ...partial } });

  /** The detector is disabled at dwellMs 0: switching the action on gives it a sensible hold time; Off disables it again. */
  const setDwellAction = (dwellAction: DwellAction) => {
    const dwellMs = dwellAction === 'off' ? 0 : settings.interaction.dwellMs > 0 ? settings.interaction.dwellMs : DEFAULT_DWELL_MS;
    setSettings({ capture: { ...settings.capture, dwellAction }, interaction: { ...settings.interaction, dwellMs } });
  };
  const dwellOff = settings.capture.dwellAction === 'off';
  const holdTime = settings.interaction.dwellMs > 0 ? settings.interaction.dwellMs : DEFAULT_DWELL_MS;

  const reset = () => {
    const d = defaultSettings();
    setSettings({ ...d, reducedMotion: settings.reducedMotion });
  };

  const managed = settings.adaptiveQuality;

  return (
    <Sheet
      open={open}
      title="Settings"
      onClose={onClose}
      {...(onEscape ? { onEscape } : {})}
      footer={<Button variant="ghost" size="sm" onClick={reset}>Reset to defaults</Button>}
    >
      <section className="af-group" aria-labelledby="af-set-interaction">
        <h3 id="af-set-interaction" className="af-group__title">Window &amp; gestures</h3>
        <div className="af-field">
          <span className="af-field__label" id="af-set-ordering">Corner ordering</span>
          <Segmented<WindowOrdering>
            label="Corner ordering"
            block
            value={settings.interaction.ordering}
            onChange={(ordering) => setInteraction({ ordering })}
            options={[
              { value: 'convex', label: 'Convex' },
              { value: 'faithful', label: 'Faithful (bow-tie)' },
            ]}
          />
          <span className="af-field__hint">Faithful keeps the self-intersecting quad seen in the original when hands sit at different heights.</span>
        </div>
        <Toggle
          label="Hands-together cycles persona"
          hint="Palms together ≥ hold time, then open the window"
          checked={settings.interaction.gestureCycleEnabled}
          onChange={(gestureCycleEnabled) => setInteraction({ gestureCycleEnabled })}
        />
        <Slider
          label="Hold before fade"
          min={0}
          max={1000}
          step={50}
          value={settings.interaction.holdMs}
          format={(v) => `${v} ms`}
          onChange={(holdMs) => setInteraction({ holdMs })}
          hint="How long the window stays after a hand is lost"
        />
        <Slider
          label="Gesture arm time"
          min={200}
          max={1500}
          step={50}
          value={settings.interaction.togetherArmMs}
          format={(v) => `${v} ms`}
          onChange={(togetherArmMs) => setInteraction({ togetherArmMs })}
        />
        <Slider
          label="Corner smoothing"
          min={0}
          max={0.9}
          step={0.05}
          value={settings.interaction.cornerSpring}
          format={(v) => (v === 0 ? 'Off' : v.toFixed(2))}
          onChange={(cornerSpring) => setInteraction({ cornerSpring })}
          hint="Off: corners sit exactly on your fingertips. Higher values let them trail softly."
        />
        <div className="af-field">
          <span className="af-field__label">Hold still to capture</span>
          <Segmented<DwellAction>
            label="Hold still to capture"
            block
            value={settings.capture.dwellAction}
            onChange={setDwellAction}
            options={[
              { value: 'off', label: 'Off' },
              { value: 'snapshot', label: 'Snapshot' },
              { value: 'record', label: 'Record' },
            ]}
          />
          <span className="af-field__hint">Hold the window still for the hold time to take a snapshot or start a recording hands-free.</span>
        </div>
        <Slider
          label="Hold time"
          min={500}
          max={3000}
          step={100}
          value={holdTime}
          format={(v) => `${v} ms`}
          onChange={(dwellMs) => setInteraction({ dwellMs })}
          disabled={dwellOff}
          hint={dwellOff ? 'Turn on Hold still to capture to adjust' : 'How long both hands must stay still'}
        />
      </section>

      <section className="af-group" aria-labelledby="af-set-quality">
        <h3 id="af-set-quality" className="af-group__title">Quality</h3>
        <Toggle
          label="Adaptive quality"
          hint="Lower resolution / tracking rate when fps drops, restore when it recovers"
          checked={settings.adaptiveQuality}
          onChange={(adaptiveQuality) => setSettings({ adaptiveQuality })}
        />
        <Slider
          label="Render scale"
          min={0.5}
          max={1}
          step={0.05}
          value={settings.quality.renderScale}
          format={percent}
          onChange={(renderScale) => setQuality({ renderScale })}
          disabled={managed}
          hint={managed ? MANAGED_HINT : undefined}
        />
        <Slider
          label="Segmentation every N frames"
          min={1}
          max={4}
          step={1}
          value={settings.quality.segmentationStride}
          onChange={(segmentationStride) => setQuality({ segmentationStride })}
          disabled={managed}
          hint={managed ? MANAGED_HINT : undefined}
        />
        <div className="af-field">
          <span className="af-field__label">Tracking resolution</span>
          <Segmented<ResolutionKey>
            label="Tracking resolution"
            block
            value={resolutionKey(settings.quality.inferenceMaxHeight)}
            onChange={(key) => setQuality({ inferenceMaxHeight: Number(key) })}
            disabled={managed}
            describedBy="af-set-resolution-hint"
            options={RESOLUTION_OPTIONS}
          />
          <span className="af-field__hint" id="af-set-resolution-hint">
            {managed ? MANAGED_HINT : 'Frames taller than this are downscaled before tracking (cheaper, slightly less precise).'}
          </span>
        </div>
        <Slider
          label="Face every N frames"
          min={1}
          max={4}
          step={1}
          value={settings.quality.faceStride}
          onChange={(faceStride) => setQuality({ faceStride })}
          disabled={managed}
          hint={managed ? MANAGED_HINT : undefined}
        />
      </section>

      <section className="af-group" aria-labelledby="af-set-look">
        <h3 id="af-set-look" className="af-group__title">Look</h3>
        <Slider label="Ink thickness" min={0.25} max={3} step={0.05} value={settings.look.inkWidth} format={times} onChange={(inkWidth) => setLook({ inkWidth })} />
        <Slider label="Ink threshold" min={0.25} max={3} step={0.05} value={settings.look.inkThreshold} format={times} onChange={(inkThreshold) => setLook({ inkThreshold })} hint="Higher: fewer, bolder lines" />
        <Slider label="Halftone" min={0} max={2} step={0.05} value={settings.look.halftone} format={times} onChange={(halftone) => setLook({ halftone })} />
        <Slider label="Saturation" min={0} max={2} step={0.05} value={settings.look.saturation} format={times} onChange={(saturation) => setLook({ saturation })} />
        <Slider label="Colour bands" min={3} max={8} step={1} value={settings.look.bands} onChange={(bands) => setLook({ bands })} />
        <Slider label="Grain" min={0} max={3} step={0.05} value={settings.look.grain} format={times} onChange={(grain) => setLook({ grain })} />
        <Slider label="Overlay strength" min={0} max={1} step={0.05} value={settings.look.overlayStrength} format={percent} onChange={(overlayStrength) => setLook({ overlayStrength })} hint="Mask, suit and accent opacity" />
        <Button variant="ghost" onClick={() => setSettings({ look: { ...DEFAULT_LOOK } })}>Reset look</Button>
      </section>

      <section className="af-group" aria-labelledby="af-set-hud">
        <h3 id="af-set-hud" className="af-group__title">HUD</h3>
        <Toggle label="Show callouts" checked={settings.hudEnabled} onChange={(hudEnabled) => setSettings({ hudEnabled })} />
        <div className="af-field">
          <span className="af-field__label">Callout colour</span>
          <Segmented<TintChoice>
            label="Callout colour"
            block
            value={tint}
            onChange={setTint}
            options={[
              { value: 'auto', label: 'Auto' },
              { value: 'white', label: 'White' },
              { value: 'red', label: 'Red' },
            ]}
          />
          <span className="af-field__hint">Auto: white on live, red on comic — as in the original.</span>
        </div>
      </section>

      <section className="af-group" aria-labelledby="af-set-display">
        <h3 id="af-set-display" className="af-group__title">Display</h3>
        <Toggle label="Mirror" hint="Selfie view (M)" checked={settings.mirrored} onChange={(mirrored) => setSettings({ mirrored })} />
        <div className="af-field">
          <span className="af-field__label">Display fit</span>
          <Segmented<FitMode>
            label="Display fit"
            block
            value={settings.fitMode}
            onChange={(fitMode) => setSettings({ fitMode })}
            options={[
              { value: 'cover', label: 'Fill' },
              { value: 'contain', label: 'Fit' },
            ]}
          />
          <span className="af-field__hint">Fill crops to the screen (as before). Fit shows the whole frame with black bars.</span>
        </div>
        <Toggle label="Show fps" hint="Frames per second badge (F)" checked={settings.showFps} onChange={(showFps) => setSettings({ showFps })} />
        <Toggle
          label="Reduce motion"
          hint="Disables the thin-window glitch, blinking and UI animation"
          checked={settings.reducedMotion}
          onChange={(reducedMotion) => setSettings({ reducedMotion })}
        />
        <Toggle
          label="Thin-slit glitch"
          hint="Static inside a very thin window — never under reduced motion"
          checked={settings.thinStripGlitch}
          onChange={(thinStripGlitch) => setSettings({ thinStripGlitch })}
        />
        <Toggle label="Debug landmarks" hint="Draw hand/face tracking points" checked={settings.debugLandmarks} onChange={(debugLandmarks) => setSettings({ debugLandmarks })} />
      </section>

      <section className="af-group" aria-labelledby="af-set-capture">
        <h3 id="af-set-capture" className="af-group__title">Capture</h3>
        <div className="af-field">
          <span className="af-field__label">Aspect for recordings &amp; snapshots</span>
          <Segmented<CaptureAspect>
            label="Capture aspect"
            block
            value={settings.capture.aspect}
            onChange={(aspect) => setCapture({ aspect })}
            options={[
              { value: 'source', label: 'Source' },
              { value: '16:9', label: '16:9' },
              { value: '9:16', label: '9:16' },
              { value: '1:1', label: '1:1' },
            ]}
          />
        </div>
        <div className="af-field">
          <span className="af-field__label">Self-timer</span>
          <Segmented<SelfTimerKey>
            label="Self-timer"
            block
            value={String(settings.capture.selfTimer) as SelfTimerKey}
            onChange={(key) => setCapture({ selfTimer: Number(key) as SelfTimerSeconds })}
            options={SELF_TIMER_OPTIONS}
          />
          <span className="af-field__hint">Counts down before a recording or snapshot (R, S); T always records with a timer.</span>
        </div>
        <div className="af-field">
          <span className="af-field__label">Auto-stop</span>
          <Segmented<AutoStopKey>
            label="Auto-stop"
            block
            value={String(settings.capture.autoStop) as AutoStopKey}
            onChange={(key) => setCapture({ autoStop: Number(key) as AutoStopSeconds })}
            options={AUTO_STOP_OPTIONS}
          />
          <span className="af-field__hint">Ends a recording automatically and saves it.</span>
        </div>
        <div className="af-field">
          <span className="af-field__label">Snapshot format</span>
          <Segmented<SnapshotFormat>
            label="Snapshot format"
            block
            value={settings.capture.snapshotFormat}
            onChange={(snapshotFormat) => setCapture({ snapshotFormat })}
            options={[
              { value: 'png', label: 'PNG' },
              { value: 'jpeg', label: 'JPEG' },
              { value: 'webp', label: 'WebP' },
            ]}
          />
        </div>
      </section>

      <section className="af-group" aria-labelledby="af-set-diagnostics">
        <h3 id="af-set-diagnostics" className="af-group__title">Diagnostics</h3>
        <Diagnostics {...(getDiagnostics ? { getDiagnostics } : {})} />
      </section>
    </Sheet>
  );
}
