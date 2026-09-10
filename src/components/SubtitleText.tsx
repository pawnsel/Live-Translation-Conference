import { useLayoutEffect, useRef, useState } from 'react';
import { fitSubtitlePage, isContinuation } from '../asr/subtitleLines';

interface SubtitleTextProps {
  /** The whole caption accumulated so far — paging is handled here. */
  text: string;
  /** Hard ceiling on visible lines; the block restarts instead of growing. */
  maxLines?: number;
  /** Typography for the caption, applied to both the visible and measured copy. */
  className?: string;
  /**
   * Locks the block to exactly `maxLines` tall — one line of text and a full
   * block occupy the same space, so the caption box never resizes while
   * someone is speaking.
   */
  reserveLines?: boolean;
  /**
   * How text that does not fit is handled.
   *
   * 'page' (the default) is subtitle behaviour: the block shows the LAST page
   * that fits, so a caption still being spoken always shows its newest words.
   *
   * 'clip' shows the text from its start and cuts the overflow with an
   * ellipsis. A finished sentence needs this — paging it would show only the
   * remainder after the last page break, which for the wrong sentence length
   * is a two-character stub that reads as a line gone missing.
   */
  overflow?: 'page' | 'clip';
}

/**
 * A caption that behaves like a real subtitle: it fills at most `maxLines`
 * lines and then starts a fresh block from the word that no longer fitted,
 * rather than scrolling or growing without bound.
 *
 * The line count can only come from the DOM, so the text is laid out once in
 * an invisible twin of the visible paragraph (identical classes, identical
 * width) and the paging decision itself is made by `fitSubtitlePage`.
 */
export default function SubtitleText({
  text,
  maxLines = 2,
  className = '',
  reserveLines = true,
  overflow = 'page'
}: SubtitleTextProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLParagraphElement>(null);
  const startRef = useRef(0);
  const prevTextRef = useRef('');
  const [visible, setVisible] = useState('');
  const [lineHeight, setLineHeight] = useState(0);
  const [width, setWidth] = useState(0);

  // A narrower box fits fewer words per line, so the block has to be paged
  // again on resize — otherwise a rotated phone shows three or four lines.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const el = measureRef.current;
    if (!el) {
      setVisible(text);
      return;
    }

    // One line of THIS paragraph, at THIS width and font size. The reserved
    // height comes from the fractional rect — `scrollHeight` rounds down, and
    // three roundings of a 41.25px line would clip the last line.
    el.textContent = 'A';
    const oneLine = el.scrollHeight || 0;
    setLineHeight(el.getBoundingClientRect().height || oneLine);

    // Clipped text is never paged — CSS does the cutting, and the reserved
    // height above is all this measurement was needed for.
    if (overflow === 'clip') {
      el.textContent = '';
      prevTextRef.current = text;
      startRef.current = 0;
      setVisible(text);
      return;
    }

    const measure = (value: string) => {
      if (!value) return 0;
      if (!oneLine) return 1;
      el.textContent = value;
      return Math.max(1, Math.round(el.scrollHeight / oneLine));
    };

    // Fragments of the same utterance only ever get appended; anything else
    // is a new caption, which always opens a new block.
    const start = fitSubtitlePage(text, isContinuation(prevTextRef.current, text) ? startRef.current : 0, maxLines, measure);
    el.textContent = '';

    prevTextRef.current = text;
    startRef.current = start;
    setVisible(text.slice(start));
  }, [text, maxLines, width, overflow]);

  return (
    <div
      ref={wrapRef}
      className="relative w-full"
      style={
        reserveLines && lineHeight
          ? { height: lineHeight * maxLines, overflow: 'hidden' }
          : undefined
      }
    >
      <p className={`${className} ${overflow === 'clip' ? 'truncate' : 'break-words'}`}>{visible}</p>
      <p ref={measureRef} aria-hidden className={`${className} break-words absolute inset-x-0 top-0 invisible pointer-events-none`} />
    </div>
  );
}
