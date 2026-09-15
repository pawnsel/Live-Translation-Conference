import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import LiveCaptionBox, { type CaptionView } from '../components/LiveCaptionBox';
import type { OutputPrefs } from '../storage/outputStore';
import type { DisplayConfig } from '../types';
import { STAGE_HEIGHT, STAGE_WIDTH, dragBar, fitScale, type BarPosition } from './outputLayout';

interface OutputStageProps {
  /** The shared display; null draws a black slide area. */
  stream: MediaStream | null;
  /** The console's display settings — the bar looks exactly like the console box. */
  config: DisplayConfig;
  caption: CaptionView;
  prefs: OutputPrefs;
  /** Called once per finished drag with the bar's new position. */
  onMove: (position: BarPosition) => void;
}

interface Drag {
  pointerId: number;
  startX: number;
  startY: number;
  origin: BarPosition;
  current: BarPosition;
}

/**
 * The broadcast image: the shared display with the caption bar on top, in a
 * fixed 1920×1080 stage scaled to whatever window holds it. What is drawn
 * here is exactly what OBS captures, so nothing operator-only appears.
 */
export default function OutputStage({ stream, config, caption, prefs, onMove }: OutputStageProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [scale, setScale] = useState(0);
  const [drag, setDrag] = useState<Drag | null>(null);

  // Sized by the window the stage is IN — the Output window, not the console.
  useLayoutEffect(() => {
    const view = rootRef.current?.ownerDocument.defaultView;
    if (!view) return;
    const update = () => setScale(fitScale(view.innerWidth, view.innerHeight));
    update();
    view.addEventListener('resize', update);
    return () => view.removeEventListener('resize', update);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;
    if (!stream) return;
    // Muted, so autoplay is allowed; jsdom returns undefined here.
    const playing = video.play() as Promise<void> | undefined;
    playing?.catch(() => undefined);
  }, [stream]);

  const barSize = () => ({
    widthPct: prefs.widthPct,
    heightPct: ((barRef.current?.offsetHeight ?? 0) / STAGE_HEIGHT) * 100
  });

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (prefs.locked || e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const origin = { x: prefs.x, y: prefs.y };
    setDrag({ pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, origin, current: origin });
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return;
    const current = dragBar(
      drag.origin,
      { dx: e.clientX - drag.startX, dy: e.clientY - drag.startY },
      { width: rect.width, height: rect.height },
      barSize()
    );
    setDrag({ ...drag, current });
  };

  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    setDrag(null);
    if (drag.current.x !== drag.origin.x || drag.current.y !== drag.origin.y) onMove(drag.current);
  };

  const position = drag?.current ?? { x: prefs.x, y: prefs.y };

  return (
    <div ref={rootRef} className="fixed inset-0 flex items-center justify-center overflow-hidden bg-black">
      <div
        ref={stageRef}
        data-testid="output-stage"
        className="relative shrink-0 overflow-hidden bg-black"
        style={{ width: STAGE_WIDTH * scale, height: STAGE_HEIGHT * scale }}
      >
        <div
          className="absolute left-0 top-0 origin-top-left"
          style={{ width: STAGE_WIDTH, height: STAGE_HEIGHT, transform: `scale(${scale})` }}
        >
          <video ref={videoRef} autoPlay muted playsInline className="absolute inset-0 w-full h-full object-contain" />
          <div
            ref={barRef}
            data-testid="output-caption-bar"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            className={`absolute select-none touch-none ${prefs.locked ? '' : 'cursor-move'} ${
              drag ? 'outline-2 outline-offset-8 outline-white/70 rounded-[24px]' : ''
            }`}
            style={{
              left: `${position.x}%`,
              top: `${position.y}%`,
              width: `${prefs.widthPct}%`,
              transform: 'translate(-50%, -100%)'
            }}
          >
            <LiveCaptionBox config={config} view={caption} variant="stage" />
          </div>
        </div>
      </div>
    </div>
  );
}
