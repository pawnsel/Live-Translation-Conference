import type { TranscriptItem } from '../types';

/** Captions closer together than this belong to the same run of speech.
 *  A longer gap is the speaker pausing, which is where a reader expects a
 *  paragraph break. */
export const PARAGRAPH_GAP_SECONDS = 10;

/** Even an unbroken monologue has to break somewhere — a paragraph this
 *  long is already past the point of being easy to read. */
export const PARAGRAPH_MAX_ITEMS = 8;

export interface HistoryParagraph {
  /** The seq of the first caption in the paragraph — stable across renders,
   *  which an index is not once earlier captions are hidden. */
  key: number;
  startTs: number;
  items: TranscriptItem[];
}

/** Folds a caption list into paragraphs of continuous speech, so history
 *  reads as prose instead of one row per utterance. Captions are expected
 *  in the order they were spoken. */
export function groupCaptionsIntoParagraphs(captions: TranscriptItem[]): HistoryParagraph[] {
  const paragraphs: HistoryParagraph[] = [];
  for (const item of captions) {
    const current = paragraphs[paragraphs.length - 1];
    const continues =
      current !== undefined &&
      current.items.length < PARAGRAPH_MAX_ITEMS &&
      item.ts - current.items[current.items.length - 1].ts <= PARAGRAPH_GAP_SECONDS;
    if (continues) {
      current.items.push(item);
    } else {
      paragraphs.push({ key: item.seq, startTs: item.ts, items: [item] });
    }
  }
  return paragraphs;
}
