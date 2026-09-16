import { useLayoutEffect, useRef, useState } from 'react';
import type { CaptionRow } from '../asr/captionStack';
import { readSetting } from '../storage/safeStorage';

/**
 * The rolling-stack slide.
 *
 * The slide is measured, not predicted. Each row is keyed by its utterance,
 * so React MOVES the same node up the stack, and the animation is simply
 * "you were there, you are here now, cover the difference". Nothing about
 * the caption pipeline can talk it into a shift that did not happen, or out
 * of one that did — which is what every earlier attempt at this got wrong.
 *
 * Returns the ref factory each row must use: `ref={rowRef(row.key)}`.
 */
export function useCaptionStackAnimation(rows: CaptionRow[]) {
  const rowNodesRef = useRef(new Map<string, HTMLDivElement>());
  const rowTopsRef = useRef(new Map<string, number>());
  // The animation currently playing for each row, if any — so a shift that
  // lands before the previous one finishes can be handled deliberately
  // instead of by accident.
  const rowAnimsRef = useRef(new Map<string, Animation>());
  const [captionDebug] = useState(() => readSetting('captionStackDebug') === '1');

  // The translateY a row is rendering RIGHT NOW, mid-animation or not.
  // getComputedStyle reports the live interpolated value regardless of how
  // many keyframes are involved, so this is the one place both 2D and 3D
  // transform matrices need reading (a translate3d keyframe on some engines
  // computes to matrix3d instead of matrix). Read through the node's own
  // window: in the Output window the console's is the wrong one.
  const currentTranslateY = (node: HTMLElement): number => {
    try {
      const view = node.ownerDocument.defaultView;
      const transform = view?.getComputedStyle(node).transform;
      if (!transform || transform === 'none' || typeof DOMMatrixReadOnly === 'undefined') return 0;
      return new DOMMatrixReadOnly(transform).m42;
    } catch {
      return 0;
    }
  };

  useLayoutEffect(() => {
    const previousTops = rowTopsRef.current;
    const nextTops = new Map<string, number>();
    rowNodesRef.current.forEach((node, key) => nextTops.set(key, node.offsetTop));
    rowTopsRef.current = nextTops;
    if (previousTops.size === 0) return; // first paint: the stack arrived, it did not move

    const moves: string[] = [];
    nextTops.forEach((top, key) => {
      const node = rowNodesRef.current.get(key);
      if (!node || typeof node.animate !== 'function') return;
      // A row that was already on screen slides from where it was; a row that
      // is new to the stack rides in from just under the bottom edge.
      const from = previousTops.get(key) ?? top + node.offsetHeight;
      let delta = from - top;

      // Rapid, back-to-back sentences close faster than one 220ms slide can
      // finish, so the next shift for this row lands while its animation from
      // the PREVIOUS shift is still running. `node.animate()` again here
      // would start a second animation on the same property — WAAPI has the
      // newer one replace the older wholesale, so the row would cut straight
      // from wherever it visually was to this shift's theoretical start point,
      // an instant jump that reads as a skip. Reading the live transform
      // before cancelling makes the new animation continue from exactly where
      // the eye last saw the row, no matter how many shifts have piled up.
      const running = rowAnimsRef.current.get(key);
      if (running?.playState === 'running') {
        delta = currentTranslateY(node);
        running.cancel();
      }
      if (delta === 0) return;

      moves.push(`${key}: ${from}→${top}`);
      const anim = node.animate(
        [{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }],
        { duration: 220, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }
      );
      rowAnimsRef.current.set(key, anim);
      anim.addEventListener('finish', () => {
        if (rowAnimsRef.current.get(key) === anim) rowAnimsRef.current.delete(key);
      });
    });

    // Switched on with `localStorage.captionStackDebug = '1'` (then reload).
    // The stack has now been rebuilt several times off reports of it "not
    // sliding sometimes", and guessing has cost more than measuring would
    // have: this prints what the rows actually were, and what actually moved.
    if (captionDebug) {
      // eslint-disable-next-line no-console
      console.debug(
        '[caption-stack]',
        rows.map((row) => `${row.key}:${JSON.stringify(row.text.slice(0, 24))}`).join(' | '),
        moves.length > 0 ? `moved ${moves.join(', ')}` : 'no movement'
      );
    }
  }, [rows, captionDebug]);

  // A fresh callback per render, exactly as the inline ref in Admin.tsx was —
  // this extraction does not change when React attaches and detaches rows.
  return (key: string) => (node: HTMLDivElement | null) => {
    const nodes = rowNodesRef.current;
    if (node) {
      nodes.set(key, node);
    } else {
      nodes.delete(key);
      // The row is gone for good once it falls off the top of the stack —
      // nothing will ever animate it again, so its Animation handle would
      // otherwise just sit in the map for the rest of the session.
      rowAnimsRef.current.get(key)?.cancel();
      rowAnimsRef.current.delete(key);
    }
  };
}
