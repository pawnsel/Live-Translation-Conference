/** Choosing which microphone the session listens to.
 *
 *  Pure functions only — no navigator, no React — so the rules that decide
 *  what the operator sees and what reaches getUserMedia can be tested
 *  without a browser. The hook that actually enumerates devices is
 *  useAudioInputDevices.ts.
 *
 *  Two facts about MediaDevices shape everything here:
 *
 *   1. Labels are blank until the page has been granted microphone
 *      permission at least once, so the list must stay usable without them.
 *   2. Chrome reports one physical microphone up to three times: under its
 *      own id, as "default", and as "communications".
 */

export interface AudioInputDevice {
  deviceId: string;
  label: string;
}

/** The synthetic entry meaning "follow whatever the OS has set". Kept in the
 *  list on purpose: in a meeting room the operator often wants exactly that. */
export const DEFAULT_DEVICE_ID = 'default';

/** Chrome's second synthetic alias. Unlike `default` it adds nothing an
 *  operator would ask for, and it duplicates a microphone already listed
 *  under its real id. */
const COMMUNICATIONS_DEVICE_ID = 'communications';

export function toAudioInputs(devices: MediaDeviceInfo[]): AudioInputDevice[] {
  return devices
    .filter(
      (device) =>
        device.kind === 'audioinput' &&
        device.deviceId !== '' &&
        device.deviceId !== COMMUNICATIONS_DEVICE_ID
    )
    .map((device) => ({ deviceId: device.deviceId, label: device.label }));
}

/** What to show in the picker. Never empty: a blank label would render a row
 *  the operator cannot tell apart from the next one. */
export function deviceLabel(device: AudioInputDevice, index: number): string {
  if (device.label) return device.label;
  if (device.deviceId === DEFAULT_DEVICE_ID) return 'ไมโครโฟนค่าเริ่มต้นของระบบ';
  return `ไมโครโฟน ${index + 1}`;
}

/**
 * The id to hand getUserMedia, given what the operator picked and what the
 * machine currently has.
 *
 * `undefined` means "let the browser choose". That matters because the
 * capture hook passes a present id as `deviceId: { exact: ... }`, which
 * throws OverconstrainedError rather than falling back — so an id for a
 * device that has since been unplugged must not reach it.
 *
 * An empty device list is not evidence that the selection is gone: devices
 * cannot be enumerated at all until microphone permission has been granted,
 * so a remembered id is trusted until there is a list to check it against.
 */
export function resolveDeviceId(
  selected: string | null,
  devices: AudioInputDevice[]
): string | undefined {
  if (!selected) return undefined;
  if (devices.length === 0) return selected;
  return devices.some((device) => device.deviceId === selected) ? selected : undefined;
}
