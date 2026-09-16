// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import StreamPanel, { StreamStatusChip } from './StreamPanel';
import type { ScreenShare } from './useScreenShare';
import type { OutputWindow } from './useOutputWindow';
import { DEFAULT_OUTPUT_PREFS } from '../storage/outputStore';
import type { OutputPrefs } from '../storage/outputStore';

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

  it('switches to letterbox layout from the layout picker', () => {
    const onPrefsChange = vi.fn();
    render(<StreamPanel share={share()} output={output()} prefs={DEFAULT_OUTPUT_PREFS} onPrefsChange={onPrefsChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'แบ่งพื้นที่' }));
    expect(onPrefsChange).toHaveBeenCalledWith({ ...DEFAULT_OUTPUT_PREFS, layout: 'letterbox' });
  });

  it('switches back to overlay layout from the layout picker', () => {
    const onPrefsChange = vi.fn();
    const prefs: OutputPrefs = { ...DEFAULT_OUTPUT_PREFS, layout: 'letterbox' };
    render(<StreamPanel share={share()} output={output()} prefs={prefs} onPrefsChange={onPrefsChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'ทับบนสไลด์' }));
    expect(onPrefsChange).toHaveBeenCalledWith({ ...prefs, layout: 'overlay' });
  });

  it('changes the slide size in letterbox layout', () => {
    const onPrefsChange = vi.fn();
    const prefs: OutputPrefs = { ...DEFAULT_OUTPUT_PREFS, layout: 'letterbox', slidePct: 80 };
    render(<StreamPanel share={share()} output={output()} prefs={prefs} onPrefsChange={onPrefsChange} />);
    fireEvent.change(screen.getByLabelText(/ขนาดสไลด์/), { target: { value: '90' } });
    expect(onPrefsChange).toHaveBeenCalledWith({ ...prefs, slidePct: 90 });
  });

  it('hides lock/reset/drag hint and shows the slide slider in letterbox', () => {
    const prefs: OutputPrefs = { ...DEFAULT_OUTPUT_PREFS, layout: 'letterbox' };
    render(<StreamPanel share={share()} output={output()} prefs={prefs} onPrefsChange={vi.fn()} />);
    expect(screen.queryByLabelText(/ล็อกตำแหน่ง/)).toBeNull();
    expect(screen.queryByRole('button', { name: /รีเซ็ตตำแหน่ง/ })).toBeNull();
    expect(screen.queryByText(/ลากแถบคำแปล/)).toBeNull();
    expect(screen.getByLabelText(/ขนาดสไลด์/)).toBeTruthy();
    expect(screen.getByText(/จัดกึ่งกลาง/)).toBeTruthy();
  });

  it('shows lock/reset/drag hint and no slide slider in overlay', () => {
    render(<StreamPanel share={share()} output={output()} prefs={DEFAULT_OUTPUT_PREFS} onPrefsChange={vi.fn()} />);
    expect(screen.getByLabelText(/ล็อกตำแหน่ง/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /รีเซ็ตตำแหน่ง/ })).toBeTruthy();
    expect(screen.getByText(/ลากแถบคำแปล/)).toBeTruthy();
    expect(screen.queryByLabelText(/ขนาดสไลด์/)).toBeNull();
  });

  it('toggles the temporary caption hide without touching the saved prefs', () => {
    const onCaptionHiddenChange = vi.fn();
    const onPrefsChange = vi.fn();
    render(
      <StreamPanel
        share={share()}
        output={output()}
        prefs={DEFAULT_OUTPUT_PREFS}
        onPrefsChange={onPrefsChange}
        captionHidden={false}
        onCaptionHiddenChange={onCaptionHiddenChange}
      />
    );
    fireEvent.click(screen.getByLabelText(/ซ่อนคำแปลชั่วคราว/));
    expect(onCaptionHiddenChange).toHaveBeenCalledWith(true);
    expect(onPrefsChange).not.toHaveBeenCalled();
  });

  it('offers the hide toggle in letterbox too, and reminds the operator while it is on', () => {
    const prefs: OutputPrefs = { ...DEFAULT_OUTPUT_PREFS, layout: 'letterbox' };
    render(
      <StreamPanel
        share={share()}
        output={output()}
        prefs={prefs}
        onPrefsChange={vi.fn()}
        captionHidden
        onCaptionHiddenChange={vi.fn()}
      />
    );
    expect(screen.getByLabelText(/ซ่อนคำแปลชั่วคราว/)).toBeTruthy();
    expect(screen.getByText(/อย่าลืมเอาเครื่องหมายถูกออก/)).toBeTruthy();
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

  it('warns from every tab while the caption is hidden', () => {
    render(<StreamStatusChip share={share()} output={output({ isOpen: true })} captionHidden />);
    expect(screen.getByText('ซ่อนคำแปล')).toBeTruthy();
  });

  it('says nothing about hiding when the caption is showing', () => {
    render(<StreamStatusChip share={share()} output={output({ isOpen: true })} />);
    expect(screen.queryByText('ซ่อนคำแปล')).toBeNull();
  });
});
