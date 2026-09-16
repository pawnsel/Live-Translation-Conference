import { Zap } from 'lucide-react';
import SubtitleText from './SubtitleText';
import type { CaptionRow } from '../asr/captionStack';
import type { DisplayConfig } from '../types';
import { captionSizing, captionThemeClasses, type CaptionVariant } from './captionStyle';
import { useCaptionStackAnimation } from './useCaptionStackAnimation';

/** Everything the box shows, computed once by the console and handed to
 *  every copy of the box — the console's and the Output stage's. */
export interface CaptionView {
  /** Live source text, else the latest caption's. */
  sourceText: string;
  /** Live translation, else the latest caption's. */
  targetText: string;
  /** A sentence is still being spoken. */
  hasPartial: boolean;
  /** Rolling-stack rows, oldest first (used when `showPrevious`). */
  rows: CaptionRow[];
  latencyMs: number | null;
  /** Nothing has been said yet this session. */
  isIdle: boolean;
}

interface LiveCaptionBoxProps {
  config: DisplayConfig;
  view: CaptionView;
  /** 'console' shows operator-only extras (placeholder, latency, idle hint);
   *  'stage' shows only what belongs on a broadcast. */
  variant: CaptionVariant;
}

const PENDING_TEXT = 'กำลังแปล…';

/**
 * The live subtitle. Two-line mode pages the way broadcast subtitles do: a
 * caption that outgrows the block restarts from the word that no longer
 * fitted. Rolling mode instead keeps one line per sentence, newest on the
 * bottom line and older ones fading upwards out of the block. Either way the
 * box holds ONE fixed height for a given display setting: nothing that
 * happens while someone speaks may resize it.
 */
export default function LiveCaptionBox({ config, view, variant }: LiveCaptionBoxProps) {
  const theme = captionThemeClasses(config.captionTheme);
  const size = captionSizing(variant, config.fontSize);
  const onConsole = variant === 'console';
  const rowRef = useCaptionStackAnimation(view.rows);
  const pending = (text: string) => (onConsole ? text || PENDING_TEXT : text);

  return (
    <div
      className={`relative w-full ${size.radius} border shadow-sm ${size.padding} text-left overflow-hidden transition-colors ${theme.box}`}
    >
      {/* Every slot below is ALWAYS mounted and every one of them is locked
          to its own line count, so the box is exactly as tall as the display
          settings demand and not one pixel more. The idle hint sits on top
          of the content instead of replacing it, because a box that resized
          under a speaker would shove the whole page around mid-sentence. */}
      {config.showOriginal && (
        <SubtitleText
          text={view.sourceText}
          maxLines={1}
          className={`${size.source} ${size.sourceGap} ${view.hasPartial ? theme.sourcePartial : theme.sourceSettled}`}
        />
      )}
      {config.showPrevious ? (
        <div className="relative overflow-hidden">
          {/* Keyed by utterance, so a line that climbs is the SAME node in a
              new place — which is what lets the animation measure the move
              instead of guessing it. The fade belongs to the slot, not to the
              sentence: a line dims by climbing, the way a lyric does. */}
          {view.rows.map((row, index) => {
            const isLive = index === view.rows.length - 1;
            const text = isLive ? pending(row.text) : row.text;
            return (
              <div
                key={row.key}
                ref={rowRef(row.key)}
                // One line tall, in CSS, from the very first paint:
                // leading-snug is a 1.375 line-height, so 1.375em of this
                // element's own font size IS one line.
                className={`${size.text} leading-snug overflow-hidden`}
                style={{
                  height: '1.375em',
                  opacity: 1 - (view.rows.length - 1 - index) * 0.35,
                  transition: 'opacity 220ms ease-out'
                }}
              >
                <SubtitleText
                  text={text}
                  maxLines={1}
                  reserveLines={false}
                  // The live line follows the speaker (newest words win); a
                  // finished one is read from its start.
                  overflow={isLive ? 'page' : 'clip'}
                  className={`${size.text} leading-snug tracking-tight ${
                    isLive && !row.text ? `font-normal ${theme.pendingText}` : `font-bold ${theme.finalText}`
                  }`}
                />
              </div>
            );
          })}
        </div>
      ) : (
        <SubtitleText
          text={pending(view.targetText)}
          maxLines={2}
          className={`${size.text} leading-snug tracking-tight ${
            view.targetText ? `font-bold ${theme.finalText}` : `font-normal ${theme.pendingText}`
          }`}
        />
      )}
      {/* The last MEASURED latency, kept on screen between sentences. */}
      {onConsole && config.showLatency && (
        <span
          className={`mt-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-mono text-[10px] border ${
            view.latencyMs ? '' : 'invisible'
          } ${theme.latencyBadge}`}
        >
          <Zap className="w-3 h-3 text-amber-500" />
          <span>{view.latencyMs ?? 0}ms</span>
        </span>
      )}

      {onConsole && view.isIdle && (
        <div
          className={`absolute inset-0 rounded-2xl flex flex-col items-center justify-center text-center px-6 ${theme.idleOverlay}`}
        >
          <div className={`font-bold text-sm ${theme.idleTitle}`}>พร้อมรับเสียงจากไมโครโฟน</div>
          <p className="text-xs leading-relaxed mt-1">
            กดปุ่มไมโครโฟนวงกลมกลางจอ จากนั้นพูดใส่ไมโครโฟนเพื่อทำการแปลภาษาแบบเรียลไทม์
          </p>
        </div>
      )}
    </div>
  );
}
