// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import OutputStage from './OutputStage';
import type { CaptionView } from '../components/LiveCaptionBox';
import { DEFAULT_OUTPUT_PREFS } from '../storage/outputStore';
import { letterboxBarBottomPct, letterboxSlideHeightPct } from './outputLayout';

// jsdom has no PointerEvent; a MouseEvent carrying a pointerId is enough here.
beforeAll(() => {
  if (!('PointerEvent' in window)) {
    class PointerEventPolyfill extends MouseEvent {
      pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 0;
      }
    }
    Object.defineProperty(window, 'PointerEvent', { value: PointerEventPolyfill, configurable: true });
  }
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const caption: CaptionView = {
  sourceText: '',
  targetText: 'Welcome to the conference.',
  hasPartial: false,
  rows: [],
  latencyMs: 900,
  isIdle: false
};

function renderStage(prefs = DEFAULT_OUTPUT_PREFS, onMove = vi.fn()) {
  render(<OutputStage stream={null} config={{ fontSize: 'large', captionTheme: 'translucent', showLatency: true }} caption={caption} prefs={prefs} onMove={onMove} />);
  return { bar: screen.getByTestId('output-caption-bar'), stage: screen.getByTestId('output-stage'), onMove };
}

describe('OutputStage', () => {
  it('places the bar by its bottom-centre at the saved position and width', () => {
    const { bar } = renderStage({ ...DEFAULT_OUTPUT_PREFS, x: 40, y: 90, widthPct: 70, locked: false });
    expect(bar.style.left).toBe('40%');
    expect(bar.style.top).toBe('90%');
    expect(bar.style.width).toBe('70%');
    expect(bar.style.transform).toBe('translate(-50%, -100%)');
  });

  it('shows the caption but none of the operator-only extras', () => {
    render(
      <OutputStage
        stream={null}
        config={{ fontSize: 'large', captionTheme: 'translucent', showLatency: true }}
        // isIdle: true is what actually exercises the idle-hint assertion
        // below — with isIdle: false (as this fixture read before), that
        // assertion passed whether or not the stage variant suppresses the
        // hint at all.
        caption={{ ...caption, isIdle: true }}
        prefs={DEFAULT_OUTPUT_PREFS}
        onMove={vi.fn()}
      />
    );
    expect(screen.getByText('Welcome to the conference.')).toBeTruthy();
    expect(screen.queryByText(/ms$/)).toBeNull();
    expect(screen.queryByText('พร้อมรับเสียงจากไมโครโฟน')).toBeNull();
  });

  it('reports where a drag left the bar', () => {
    const { bar, stage, onMove } = renderStage();
    vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue({ width: 960, height: 540, left: 0, top: 0, right: 960, bottom: 540, x: 0, y: 0, toJSON: () => ({}) });

    fireEvent.pointerDown(bar, { pointerId: 1, button: 0, clientX: 480, clientY: 500 });
    fireEvent.pointerMove(bar, { pointerId: 1, clientX: 480, clientY: 446 }); // up 54px = 10%
    fireEvent.pointerUp(bar, { pointerId: 1, clientX: 480, clientY: 446 });

    expect(onMove).toHaveBeenCalledWith({ x: 50, y: 86 });
  });

  it('ignores drags while locked', () => {
    const { bar, stage, onMove } = renderStage({ ...DEFAULT_OUTPUT_PREFS, locked: true });
    vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue({ width: 960, height: 540, left: 0, top: 0, right: 960, bottom: 540, x: 0, y: 0, toJSON: () => ({}) });

    fireEvent.pointerDown(bar, { pointerId: 1, button: 0, clientX: 480, clientY: 500 });
    fireEvent.pointerMove(bar, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(bar, { pointerId: 1, clientX: 100, clientY: 100 });

    expect(onMove).not.toHaveBeenCalled();
  });

  it('does not report a click that did not move the bar', () => {
    const { bar, onMove } = renderStage();
    fireEvent.pointerDown(bar, { pointerId: 1, button: 0, clientX: 480, clientY: 500 });
    fireEvent.pointerUp(bar, { pointerId: 1, clientX: 480, clientY: 500 });
    expect(onMove).not.toHaveBeenCalled();
  });

  describe('letterbox layout', () => {
    it('positions the video and the bar from the pure geometry helpers', () => {
      // Stand in for jsdom's real (always-zero) layout: 162px of a 1080px
      // stage is 15%.
      vi.spyOn(window.HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(162);
      const prefs = { ...DEFAULT_OUTPUT_PREFS, layout: 'letterbox' as const, slidePct: 80 };
      render(
        <OutputStage
          stream={null}
          config={{ fontSize: 'large', captionTheme: 'translucent', showLatency: true }}
          caption={caption}
          prefs={prefs}
          onMove={vi.fn()}
        />
      );
      const video = document.querySelector('video') as HTMLVideoElement;
      const bar = screen.getByTestId('output-caption-bar');

      const slideH = letterboxSlideHeightPct(prefs.slidePct, 15);
      expect(video.style.left).toBe('0px');
      expect(video.style.top).toBe('0px');
      expect(video.style.width).toBe('100%');
      expect(video.style.height).toBe(`${slideH}%`);

      expect(bar.style.left).toBe('50%');
      expect(bar.style.top).toBe(`${letterboxBarBottomPct(slideH, 15)}%`);
      expect(bar.style.width).toBe(`${prefs.widthPct}%`);
      expect(bar.style.transform).toBe('translate(-50%, -100%)');
    });

    it('never drags: no pointer handlers fire onMove and no drag styling is applied', () => {
      const onMove = vi.fn();
      const prefs = { ...DEFAULT_OUTPUT_PREFS, layout: 'letterbox' as const };
      render(
        <OutputStage
          stream={null}
          config={{ fontSize: 'large', captionTheme: 'translucent', showLatency: true }}
          caption={caption}
          prefs={prefs}
          onMove={onMove}
        />
      );
      const bar = screen.getByTestId('output-caption-bar');

      fireEvent.pointerDown(bar, { pointerId: 1, button: 0, clientX: 480, clientY: 500 });
      fireEvent.pointerMove(bar, { pointerId: 1, clientX: 100, clientY: 100 });
      fireEvent.pointerUp(bar, { pointerId: 1, clientX: 100, clientY: 100 });

      expect(onMove).not.toHaveBeenCalled();
      expect(bar.className).not.toContain('cursor-move');
      expect(bar.className).not.toContain('outline');
    });
  });

  describe('captionHidden', () => {
    const renderHidden = (prefs = DEFAULT_OUTPUT_PREFS) =>
      render(
        <OutputStage
          stream={null}
          config={{ fontSize: 'large', captionTheme: 'translucent', showLatency: true }}
          caption={caption}
          prefs={prefs}
          onMove={vi.fn()}
          captionHidden
        />
      );

    it('takes the bar off the stage entirely', () => {
      renderHidden();
      expect(screen.queryByTestId('output-caption-bar')).toBeNull();
      expect(screen.queryByText(/Welcome to the conference/)).toBeNull();
    });

    it('gives the whole stage back to the slide in letterbox', () => {
      vi.spyOn(window.HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(162);
      renderHidden({ ...DEFAULT_OUTPUT_PREFS, layout: 'letterbox', slidePct: 80 });
      const video = document.querySelector('video') as HTMLVideoElement;
      expect(video.style.height).toBe('100%');
    });

    it('brings the bar back where it was when unhidden', () => {
      const prefs = { ...DEFAULT_OUTPUT_PREFS, x: 40, y: 90, widthPct: 70 };
      const { rerender } = renderHidden(prefs);
      expect(screen.queryByTestId('output-caption-bar')).toBeNull();
      rerender(
        <OutputStage
          stream={null}
          config={{ fontSize: 'large', captionTheme: 'translucent', showLatency: true }}
          caption={caption}
          prefs={prefs}
          onMove={vi.fn()}
          captionHidden={false}
        />
      );
      const bar = screen.getByTestId('output-caption-bar');
      expect(bar.style.left).toBe('40%');
      expect(bar.style.top).toBe('90%');
    });
  });

  describe('full-screen control', () => {
    const renderWithControl = (over: { isFullscreen?: boolean; onToggleFullscreen?: () => void } = {}) => {
      const onToggleFullscreen = over.onToggleFullscreen ?? vi.fn();
      render(
        <OutputStage
          stream={null}
          config={{ fontSize: 'large', captionTheme: 'translucent', showLatency: true }}
          caption={caption}
          prefs={DEFAULT_OUTPUT_PREFS}
          onMove={vi.fn()}
          isFullscreen={over.isFullscreen ?? false}
          onToggleFullscreen={onToggleFullscreen}
        />
      );
      return { onToggleFullscreen };
    };

    it('asks the window it lives in to go full screen', () => {
      const { onToggleFullscreen } = renderWithControl();
      fireEvent.click(screen.getByRole('button', { name: 'เต็มจอ' }));
      expect(onToggleFullscreen).toHaveBeenCalledTimes(1);
    });

    it('offers the way back out once the window fills the display', () => {
      renderWithControl({ isFullscreen: true });
      expect(screen.getByRole('button', { name: 'ออกจากเต็มจอ' })).toBeTruthy();
    });

    it('stays put while the window is not full screen, so the operator can find it', () => {
      vi.useFakeTimers();
      try {
        renderWithControl();
        act(() => vi.advanceTimersByTime(10_000));
        expect(screen.queryByRole('button', { name: 'เต็มจอ' })).toBeTruthy();
      } finally {
        vi.useRealTimers();
      }
    });

    // Full screen means the window is on the projector: an operator-only
    // button parked in the corner is a button the audience is looking at.
    it('takes itself and the mouse cursor off the projector once the mouse settles', () => {
      vi.useFakeTimers();
      try {
        renderWithControl({ isFullscreen: true });
        expect(screen.queryByRole('button', { name: 'ออกจากเต็มจอ' })).toBeTruthy();

        act(() => vi.advanceTimersByTime(2000));

        expect(screen.queryByRole('button', { name: 'ออกจากเต็มจอ' })).toBeNull();
        expect(screen.getByTestId('output-root').style.cursor).toBe('none');
      } finally {
        vi.useRealTimers();
      }
    });

    it('comes back when the mouse moves over the window again', () => {
      vi.useFakeTimers();
      try {
        renderWithControl({ isFullscreen: true });
        act(() => vi.advanceTimersByTime(2000));

        act(() => {
          fireEvent.pointerMove(document, { clientX: 10, clientY: 10 });
        });

        expect(screen.queryByRole('button', { name: 'ออกจากเต็มจอ' })).toBeTruthy();
        expect(screen.getByTestId('output-root').style.cursor).not.toBe('none');
      } finally {
        vi.useRealTimers();
      }
    });

    it('draws no control at all where the window cannot go full screen', () => {
      render(
        <OutputStage
          stream={null}
          config={{ fontSize: 'large', captionTheme: 'translucent', showLatency: true }}
          caption={caption}
          prefs={DEFAULT_OUTPUT_PREFS}
          onMove={vi.fn()}
        />
      );
      expect(screen.queryByRole('button')).toBeNull();
    });
  });
});
