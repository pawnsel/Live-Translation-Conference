import { describe, expect, it } from 'vitest';
import { deviceLabel, resolveDeviceId, toAudioInputs } from './audioDevices';

function info(over: Partial<MediaDeviceInfo>): MediaDeviceInfo {
  return {
    deviceId: 'x',
    kind: 'audioinput',
    label: '',
    groupId: 'g',
    toJSON: () => ({}),
    ...over
  } as MediaDeviceInfo;
}

describe('toAudioInputs', () => {
  it('keeps only microphones', () => {
    const list = toAudioInputs([
      info({ deviceId: 'mic', kind: 'audioinput', label: 'Yeti' }),
      info({ deviceId: 'cam', kind: 'videoinput', label: 'FaceTime' }),
      info({ deviceId: 'spk', kind: 'audiooutput', label: 'Speakers' })
    ]);
    expect(list.map((d) => d.deviceId)).toEqual(['mic']);
  });

  // Chrome reports the same physical microphone twice — once under its own
  // id and once as the synthetic "communications" entry. Showing both makes
  // the operator pick between two identical-looking names.
  it('drops the communications alias but keeps default', () => {
    const list = toAudioInputs([
      info({ deviceId: 'default', label: 'Default - Yeti' }),
      info({ deviceId: 'communications', label: 'Communications - Yeti' }),
      info({ deviceId: 'abc123', label: 'Yeti' })
    ]);
    expect(list.map((d) => d.deviceId)).toEqual(['default', 'abc123']);
  });

  // A device with no id is unusable as a constraint — getUserMedia would be
  // asked for `{ exact: '' }` and throw.
  it('drops entries with no id', () => {
    expect(toAudioInputs([info({ deviceId: '', label: 'Ghost' })])).toEqual([]);
  });
});

describe('deviceLabel', () => {
  // Before the operator grants microphone permission the browser hands back
  // devices with blank labels. A row reading "" is unpickable.
  it('numbers a microphone whose label is still hidden', () => {
    expect(deviceLabel({ deviceId: 'abc', label: '' }, 2)).toBe('ไมโครโฟน 3');
  });

  it('names the system default entry plainly', () => {
    expect(deviceLabel({ deviceId: 'default', label: '' }, 0)).toBe('ไมโครโฟนค่าเริ่มต้นของระบบ');
  });

  it('uses the real label once permission has been granted', () => {
    expect(deviceLabel({ deviceId: 'abc', label: 'Blue Yeti' }, 0)).toBe('Blue Yeti');
  });
});

describe('resolveDeviceId', () => {
  const devices = [
    { deviceId: 'default', label: '' },
    { deviceId: 'abc', label: 'Yeti' }
  ];

  it('keeps a selection the machine still has', () => {
    expect(resolveDeviceId('abc', devices)).toBe('abc');
  });

  // The real reason this function exists: an interpreter unplugs the USB
  // interface between meetings. Passing a vanished id to getUserMedia as
  // `{ exact: ... }` throws OverconstrainedError and the session never
  // starts; undefined means "whatever the browser considers default".
  it('falls back to the browser default when the device is gone', () => {
    expect(resolveDeviceId('unplugged', devices)).toBeUndefined();
  });

  it('treats no selection as the browser default', () => {
    expect(resolveDeviceId(null, devices)).toBeUndefined();
  });

  // Devices are only enumerable after permission is granted, so on first
  // load the list is empty while a remembered id is perfectly good.
  it('trusts a remembered id while the list is still empty', () => {
    expect(resolveDeviceId('abc', [])).toBe('abc');
  });
});
