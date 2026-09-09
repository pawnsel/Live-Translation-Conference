import { describe, expect, it } from 'vitest';
import { RECONNECT_BASE_DELAY_MS, RECONNECT_MAX_DELAY_MS, reconnectDelayMs } from './reconnectPolicy';

describe('reconnectDelayMs', () => {
  it('waits the base delay after the first failure', () => {
    expect(reconnectDelayMs(1)).toBe(RECONNECT_BASE_DELAY_MS);
  });

  it('doubles with each consecutive failure', () => {
    expect(reconnectDelayMs(2)).toBe(1600);
    expect(reconnectDelayMs(3)).toBe(3200);
    expect(reconnectDelayMs(4)).toBe(6400);
  });

  it('stops growing at the ceiling', () => {
    expect(reconnectDelayMs(5)).toBe(RECONNECT_MAX_DELAY_MS);
    expect(reconnectDelayMs(50)).toBe(RECONNECT_MAX_DELAY_MS);
  });

  it('never returns less than the base delay, whatever it is handed', () => {
    expect(reconnectDelayMs(0)).toBe(RECONNECT_BASE_DELAY_MS);
    expect(reconnectDelayMs(-3)).toBe(RECONNECT_BASE_DELAY_MS);
  });
});
