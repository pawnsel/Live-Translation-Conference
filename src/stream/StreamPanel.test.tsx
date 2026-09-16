// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import StreamPanel, { StreamStatusChip } from './StreamPanel';
import type { ScreenShare } from './useScreenShare';
import type { OutputWindow } from './useOutputWindow';
import { DEFAULT_OUTPUT_PREFS } from '../storage/outputStore';

afterEach(cleanup);

const share = (over: Partial<ScreenShare> = {}): ScreenShare => ({
  stream: null, status: 'idle', error: null, label: '', start: vi.fn(), stop: vi.fn(), ...over
});
const output = (over: Partial<OutputWindow> = {}): OutputWindow => ({
  container: null, kind: null, isOpen: false, error: null, open: vi.fn(), close: vi.fn(), ...over
});

describe('StreamPanel', () => {
  it('starts a share from the picker button', () => {
    const s = share();
    render(<StreamPanel share={s} output={output()} prefs={DEFAULT_OUTPUT_PREFS} onPrefsChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /เลือกจอที่จะแชร์/ }));
    expect(s.start).toHaveBeenCalled();
  });

  it('shows what is shared and lets the operator stop it', () => {
    const s = share({ status: 'sharing', label: 'Screen 2' });
    render(<StreamPanel share={s} output={output()} prefs={DEFAULT_OUTPUT_PREFS} onPrefsChange={vi.fn()} />);
    expect(screen.getByText(/Screen 2/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'หยุดแชร์' }));
    expect(s.stop).toHaveBeenCalled();
  });

  it('says the share stopped and offers to share again', () => {
    render(<StreamPanel share={share({ status: 'ended' })} output={output()} prefs={DEFAULT_OUTPUT_PREFS} onPrefsChange={vi.fn()} />);
    expect(screen.getByText(/แชร์จอหยุดแล้ว/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /แชร์ใหม่/ })).toBeTruthy();
  });

  it('explains the macOS Screen Recording permission', () => {
    render(<StreamPanel share={share({ status: 'error', error: 'system-denied' })} output={output()} prefs={DEFAULT_OUTPUT_PREFS} onPrefsChange={vi.fn()} />);
    expect(screen.getByText(/Screen Recording/)).toBeTruthy();
  });

  it('opens and closes the Output window', () => {
    const closed = output();
    const { rerender } = render(<StreamPanel share={share()} output={closed} prefs={DEFAULT_OUTPUT_PREFS} onPrefsChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /เปิดหน้าต่าง Output/ }));
    expect(closed.open).toHaveBeenCalled();

    const open = output({ isOpen: true, kind: 'pip' });
    rerender(<StreamPanel share={share()} output={open} prefs={DEFAULT_OUTPUT_PREFS} onPrefsChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /ปิดหน้าต่าง Output/ }));
    expect(open.close).toHaveBeenCalled();
  });

  it('tells the operator to allow popups when blocked', () => {
    render(<StreamPanel share={share()} output={output({ error: 'blocked' })} prefs={DEFAULT_OUTPUT_PREFS} onPrefsChange={vi.fn()} />);
    expect(screen.getByText(/อนุญาต popup/)).toBeTruthy();
  });

  it('changes width, keeping the bar on the stage', () => {
    const onPrefsChange = vi.fn();
    render(<StreamPanel share={share()} output={output()} prefs={{ ...DEFAULT_OUTPUT_PREFS, x: 30, widthPct: 50 }} onPrefsChange={onPrefsChange} />);
    fireEvent.change(screen.getByLabelText(/ความกว้างแถบคำแปล/), { target: { value: '90' } });
    expect(onPrefsChange).toHaveBeenCalledWith({ ...DEFAULT_OUTPUT_PREFS, x: 45, widthPct: 90 });
  });

  it('locks and resets the position', () => {
    const onPrefsChange = vi.fn();
    const prefs = { ...DEFAULT_OUTPUT_PREFS, x: 20, y: 50, widthPct: 40, locked: false };
    render(<StreamPanel share={share()} output={output()} prefs={prefs} onPrefsChange={onPrefsChange} />);
    fireEvent.click(screen.getByLabelText(/ล็อกตำแหน่ง/));
    expect(onPrefsChange).toHaveBeenLastCalledWith({ ...prefs, locked: true });
    fireEvent.click(screen.getByRole('button', { name: /รีเซ็ตตำแหน่ง/ }));
    expect(onPrefsChange).toHaveBeenLastCalledWith({ ...prefs, x: DEFAULT_OUTPUT_PREFS.x, y: DEFAULT_OUTPUT_PREFS.y });
  });
});

describe('StreamStatusChip', () => {
  it('renders nothing when idle', () => {
    const { container } = render(<StreamStatusChip share={share()} output={output()} />);
    expect(container.textContent).toBe('');
  });

  it('shows sharing and Output state', () => {
    render(<StreamStatusChip share={share({ status: 'sharing' })} output={output({ isOpen: true })} />);
    expect(screen.getByText('แชร์จอ')).toBeTruthy();
    expect(screen.getByText('Output')).toBeTruthy();
  });

  it('flags a share that stopped while Output is still open', () => {
    render(<StreamStatusChip share={share({ status: 'ended' })} output={output({ isOpen: true })} />);
    expect(screen.getByText('แชร์จอหยุด')).toBeTruthy();
  });
});
