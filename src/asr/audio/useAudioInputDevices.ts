/** The list of microphones this machine currently offers.
 *
 *  Kept apart from useGeminiLiveCapture: enumerating devices is a browser
 *  query with no bearing on an open session, and mixing it into the capture
 *  hook would put it inside an effect that tears the audio pipeline down.
 *
 *  All the decision rules live in audioDevices.ts, which is pure and tested.
 *  This file is only the browser plumbing around them.
 */

import { useCallback, useEffect, useState } from 'react';
import { toAudioInputs, type AudioInputDevice } from './audioDevices';

export function useAudioInputDevices(): {
  devices: AudioInputDevice[];
  refresh: () => Promise<void>;
} {
  const [devices, setDevices] = useState<AudioInputDevice[]>([]);

  const refresh = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      setDevices(toAudioInputs(await navigator.mediaDevices.enumerateDevices()));
    } catch {
      // Enumeration is a convenience: without it the picker shows nothing
      // and the session still records on the browser's default microphone.
      setDevices([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Fires when an interface is plugged in or pulled out — the case this
    // whole feature exists for, since a meeting room swaps microphones
    // between sessions.
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.addEventListener) return;
    const onChange = () => void refresh();
    mediaDevices.addEventListener('devicechange', onChange);
    return () => mediaDevices.removeEventListener('devicechange', onChange);
  }, [refresh]);

  return { devices, refresh };
}
