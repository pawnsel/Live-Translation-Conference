/** Which microphone this device records with.
 *
 *  Local rather than in Postgres, and deliberately so: a device id means
 *  nothing on another machine. The console signed in on the meeting-room PC
 *  and the one on a laptop each keep their own.
 */

import { readSetting, writeSetting } from './safeStorage';

export const MIC_DEVICE_KEY = 'ai_translate_mic_device';

export function loadMicDeviceId(): string | null {
  return readSetting(MIC_DEVICE_KEY);
}

export function saveMicDeviceId(deviceId: string | null): void {
  writeSetting(MIC_DEVICE_KEY, deviceId);
}
