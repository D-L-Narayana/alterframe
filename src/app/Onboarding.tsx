import { useId, useRef, useState } from 'react';
import { Button, CameraIcon, FileIcon, WindowHandsIcon } from '@/ui';
import { useCameraDevices, deviceLabel } from './useCameraDevices';

export interface OnboardingProps {
  onUseCamera(deviceId: string | null): void;
  onOpenFile(file: File): void;
  cameraSupported: boolean;
}

export const PRIVACY_LINE = 'Camera frames never leave your device — tracking and drawing run entirely in your browser.';

export function Onboarding({ onUseCamera, onOpenFile, cameraSupported }: OnboardingProps) {
  const { devices, supported } = useCameraDevices(cameraSupported);
  const [deviceId, setDeviceId] = useState<string>('');
  const fileRef = useRef<HTMLInputElement>(null);
  const selectId = useId();
  const canUseCamera = cameraSupported && supported;

  return (
    <section className="af-onboarding" aria-labelledby="af-onboarding-title">
      <div className="af-onboarding__card">
        <div className="af-onboarding__brand"><WindowHandsIcon /> AlterFrame</div>
        <h1 id="af-onboarding-title">Hold a window between your hands and meet your illustrated alter ego.</h1>
        <p>
          Raise both hands in an “L” shape. The space between your index fingers and thumbs becomes a window that
          shows you redrawn live — paper portrait, masked hero or web suit — with tracking-style callouts.
        </p>
        <ol className="af-onboarding__how" aria-label="How it works">
          <li className="af-onboarding__step"><b>01 · Frame</b>Index tips on top, thumbs below. The quad follows your fingertips.</li>
          <li className="af-onboarding__step"><b>02 · Reveal</b>Inside the window your camera is stylised in real time.</li>
          <li className="af-onboarding__step"><b>03 · Switch</b>Bring your palms together, then open, to change persona.</li>
        </ol>
        <p className="af-onboarding__privacy" role="note">
          <span aria-hidden="true">🔒</span>
          <span>{PRIVACY_LINE} No uploads, no analytics.</span>
        </p>
        <div className="af-onboarding__actions">
          <Button variant="primary" icon={<CameraIcon />} onClick={() => onUseCamera(deviceId || null)} disabled={!canUseCamera} autoFocus>
            Use camera
          </Button>
          <Button icon={<FileIcon />} onClick={() => fileRef.current?.click()}>Open a video file</Button>
          <input
            ref={fileRef}
            type="file"
            accept="video/*"
            className="af-visually-hidden"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => {
              const f = e.currentTarget.files?.[0];
              if (f) onOpenFile(f);
              e.currentTarget.value = '';
            }}
          />
        </div>
        {canUseCamera && devices.length > 1 ? (
          <div className="af-onboarding__device af-field">
            <label className="af-field__label" htmlFor={selectId}>Camera</label>
            <select id={selectId} className="af-select" value={deviceId} onChange={(e) => setDeviceId(e.currentTarget.value)}>
              <option value="">Default camera</option>
              {devices.map((d, i) => (
                <option key={d.deviceId || i} value={d.deviceId}>{deviceLabel(d, i)}</option>
              ))}
            </select>
          </div>
        ) : null}
        <p className="af-onboarding__hint">
          {canUseCamera
            ? 'Your browser will ask for camera permission once you click “Use camera”. Works best in good light with both hands in frame.'
            : 'This browser has no camera access — open a local video file to try the effect.'}
        </p>
      </div>
    </section>
  );
}
