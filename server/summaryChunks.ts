import type { TranscriptLine } from './gemini';

// Chunking is by character count, not line count: captions vary in length by
// an order of magnitude, so "N lines" is not a bound on prompt size and a
// two-hour meeting would still build a prompt no single call can answer.
export const SUMMARY_CHUNK_CHARS = 12000;

function lineChars(line: TranscriptLine): number {
  return line.sourceText.length + line.targetText.length;
}

export function chunkTranscript(lines: TranscriptLine[], budget = SUMMARY_CHUNK_CHARS): TranscriptLine[][] {
  const chunks: TranscriptLine[][] = [];
  let current: TranscriptLine[] = [];
  let used = 0;

  for (const line of lines) {
    const cost = lineChars(line);
    // A line longer than the whole budget becomes its own chunk rather than
    // being split — half a sentence summarises to nonsense.
    if (current.length > 0 && used + cost > budget) {
      chunks.push(current);
      current = [];
      used = 0;
    }
    current.push(line);
    used += cost;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}
