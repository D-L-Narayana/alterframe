import { useCallback, useEffect, useState } from 'react';

function hasEnumerate(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.enumerateDevices === 'function';
}

async function listVideoInputs(): Promise<MediaDeviceInfo[]> {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'videoinput');
  } catch {
    return [];
  }
}

/** Lists video inputs; labels are empty until permission is granted, so we synthesise "Camera N". */
export function useCameraDevices(enabled = true) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  // Capability detection is synchronous and constant for the page lifetime.
  const [supported] = useState(hasEnumerate);

  const refresh = useCallback(async () => {
    if (!supported) return;
    setDevices(await listVideoInputs());
  }, [supported]);

  useEffect(() => {
    if (!enabled || !supported) return;
    let cancelled = false;
    // Subscribe to the external device list: initial async read + devicechange updates.
    const onChange = () => {
      void listVideoInputs().then((list) => {
        if (!cancelled) setDevices(list);
      });
    };
    onChange();
    const md = navigator.mediaDevices;
    const canListen = typeof md.addEventListener === 'function';
    if (canListen) md.addEventListener('devicechange', onChange);
    return () => {
      cancelled = true;
      if (canListen) md.removeEventListener('devicechange', onChange);
    };
  }, [enabled, supported]);

  return { devices, supported, refresh };
}

export function deviceLabel(d: MediaDeviceInfo, index: number): string {
  return d.label || `Camera ${index + 1}`;
}
