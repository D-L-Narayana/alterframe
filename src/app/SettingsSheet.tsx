import type { CaptureAspect, HudTint, WindowOrdering } from '@/types';
import { useAppStore } from '@/state/store';
import { useSettings } from '@/state/hooks';
import { useUiStore } from '@/state/uiStore';
import { defaultSettings } from '@/state/persistence';
import { Button, Segmented, Sheet, Slider, Toggle } from '@/ui';

type TintChoice = 'auto' | HudTint;

export function SettingsSheet({ open, onClose }: { open: boolean; onClose(): void }) {
  const settings = useSettings();
  const scene = useAppStore((s) => s.scene);
  const setSettings = useAppStore((s) => s.setSettings);
  const setScene = useAppStore((s) => s.setScene);
  const captureAspect = useUiStore((s) => s.captureAspect);
  const setCaptureAspect = useUiStore((s) => s.setCaptureAspect);

  const tint: TintChoice = settings.hudTintAuto ? 'auto' : scene.hudTint;
  const setTint = (t: TintChoice) => {
    if (t === 'auto') setSettings({ hudTintAuto: true });
    else {
      setSettings({ hudTintAuto: false });
      setScene({ hudTint: t });
    }
  };

  const reset = () => {
    const d = defaultSettings();
    setSettings({ ...d, reducedMotion: settings.reducedMotion });
    setCaptureAspect('source');
  };

  return (
    <Sheet
      open={open}
      title="Settings"
      onClose={onClose}
      footer={<Button variant="ghost" size="sm" onClick={reset}>Reset to defaults</Button>}
    >
      <section className="af-group" aria-labelledby="af-set-interaction">
        <h3 id="af-set-interaction" className="af-group__title">Window & gestures</h3>
        <div className="af-field">
          <span className="af-field__label" id="af-set-ordering">Corner ordering</span>
          <Segmented<WindowOrdering>
            label="Corner ordering"
            block
            value={settings.interaction.ordering}
            onChange={(ordering) => setSettings({ interaction: { ...settings.interaction, ordering } })}
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
          onChange={(gestureCycleEnabled) => setSettings({ interaction: { ...settings.interaction, gestureCycleEnabled } })}
        />
        <Slider
          label="Hold before fade"
          min={0}
          max={1000}
          step={50}
          value={settings.interaction.holdMs}
          format={(v) => `${v} ms`}
          onChange={(holdMs) => setSettings({ interaction: { ...settings.interaction, holdMs } })}
          hint="How long the window stays after a hand is lost"
        />
        <Slider
          label="Gesture arm time"
          min={200}
          max={1500}
          step={50}
          value={settings.interaction.togetherArmMs}
          format={(v) => `${v} ms`}
          onChange={(togetherArmMs) => setSettings({ interaction: { ...settings.interaction, togetherArmMs } })}
        />
      </section>

      <section className="af-group" aria-labelledby="af-set-quality">
        <h3 id="af-set-quality" className="af-group__title">Quality</h3>
        <Slider
          label="Render scale"
          min={0.5}
          max={1}
          step={0.05}
          value={settings.quality.renderScale}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(renderScale) => setSettings({ quality: { ...settings.quality, renderScale } })}
          disabled={settings.adaptiveQuality}
          hint={settings.adaptiveQuality ? 'Managed automatically while adaptive quality is on' : undefined}
        />
        <Toggle
          label="Adaptive quality"
          hint="Lower resolution/segmentation rate when fps drops, restore when it recovers"
          checked={settings.adaptiveQuality}
          onChange={(adaptiveQuality) => setSettings({ adaptiveQuality })}
        />
        <Slider
          label="Segmentation every N frames"
          min={1}
          max={4}
          step={1}
          value={settings.quality.segmentationStride}
          onChange={(segmentationStride) => setSettings({ quality: { ...settings.quality, segmentationStride } })}
          disabled={settings.adaptiveQuality}
        />
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
        <Toggle label="Show fps" hint="Frames per second badge (F)" checked={settings.showFps} onChange={(showFps) => setSettings({ showFps })} />
        <Toggle
          label="Reduce motion"
          hint="Disables the thin-window glitch, blinking and UI animation"
          checked={settings.reducedMotion}
          onChange={(reducedMotion) => setSettings({ reducedMotion })}
        />
        <Toggle label="Debug landmarks" hint="Draw hand/face tracking points" checked={settings.debugLandmarks} onChange={(debugLandmarks) => setSettings({ debugLandmarks })} />
      </section>

      <section className="af-group" aria-labelledby="af-set-capture">
        <h3 id="af-set-capture" className="af-group__title">Capture</h3>
        <div className="af-field">
          <span className="af-field__label">Aspect for recordings & snapshots</span>
          <Segmented<CaptureAspect>
            label="Capture aspect"
            block
            value={captureAspect}
            onChange={setCaptureAspect}
            options={[
              { value: 'source', label: 'Source' },
              { value: '16:9', label: '16:9' },
              { value: '9:16', label: '9:16' },
              { value: '1:1', label: '1:1' },
            ]}
          />
        </div>
      </section>
    </Sheet>
  );
}
