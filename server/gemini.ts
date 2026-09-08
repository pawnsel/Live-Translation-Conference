import { chunkTranscript } from './summaryChunks';

// Injectable so tests never touch the real network or the @google/genai
// module — server.ts wires the real SDK to this shape (see Task 7).
export interface GenerateContentClient {
  // The real @google/genai SDK types GenerateContentResponse.text as
  // `string | undefined` (e.g. a safety-blocked or otherwise empty
  // response) — match that here instead of letting non-strict TypeScript
  // paper over the possibility of `undefined` at the call sites below.
  generateContent(args: { model: string; contents: unknown; config?: unknown }): Promise<{ text: string | undefined }>;
}


export interface TranscriptLine {
  sourceText: string;
  targetText: string;
}

// Map calls run in parallel, but not unboundedly: four keeps a twelve-chunk
// job's wall-clock reasonable without stampeding the API's rate limits.
export const SUMMARY_MAP_CONCURRENCY = 4;
export const SUMMARY_CALL_TIMEOUT_MS = 20000;

const GAP_MARKER = '[สรุปช่วงนี้ไม่สำเร็จ — บทสนทนายังถูกเก็บไว้ครบ]';

function renderLines(lines: TranscriptLine[], offset: number): string {
  return lines.map((line, i) => `[${offset + i + 1}] ${line.sourceText} => ${line.targetText}`).join('\n');
}

async function callWithTimeout(
  client: GenerateContentClient,
  model: string,
  prompt: string,
  timeoutMs: number
): Promise<string> {
  const response = await Promise.race([
    client.generateContent({ model, contents: [{ role: 'user', parts: [{ text: prompt }] }] }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('generateContent timed out')), timeoutMs))
  ]);
  if (!response.text) {
    throw new Error('Gemini returned an empty response (possibly safety-blocked)');
  }
  return response.text.trim();
}

/** Runs `task` over `items`, at most `limit` at a time, results in input order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await task(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function summarizeTranscript(
  client: GenerateContentClient,
  transcript: TranscriptLine[],
  model: string,
  opts: { concurrency?: number; callTimeoutMs?: number } = {}
): Promise<string> {
  const concurrency = opts.concurrency ?? SUMMARY_MAP_CONCURRENCY;
  const callTimeoutMs = opts.callTimeoutMs ?? SUMMARY_CALL_TIMEOUT_MS;
  const chunks = chunkTranscript(transcript);

  // A transcript that fits in one prompt keeps the old single-call shape —
  // a summary of one summary reads worse than the summary itself.
  if (chunks.length <= 1) {
    const prompt = [
      'Summarize the following conference transcript into a concise set of key points, in the language the transcript is mostly in.',
      'Transcript:',
      renderLines(transcript, 0)
    ].join('\n');
    return callWithTimeout(client, model, prompt, callTimeoutMs);
  }

  const offsets: number[] = [];
  let running = 0;
  for (const chunk of chunks) {
    offsets.push(running);
    running += chunk.length;
  }

  let anySucceeded = false;
  const partials = await mapWithConcurrency(chunks, concurrency, async (chunk, index) => {
    const prompt = [
      `Summarize part ${index + 1} of ${chunks.length} of a conference transcript into terse bullet points,`,
      'in the language the transcript is mostly in. Do not add a preamble.',
      'Transcript:',
      renderLines(chunk, offsets[index])
    ].join('\n');
    try {
      const text = await callWithTimeout(client, model, prompt, callTimeoutMs);
      anySucceeded = true;
      return text;
    } catch {
      // One bad chunk must not cost the operator the other eleven — the gap
      // is named so the summary does not silently misrepresent the meeting.
      return GAP_MARKER;
    }
  });

  if (!anySucceeded) {
    throw new Error('every transcript chunk failed to summarize');
  }

  const reducePrompt = [
    'The following are partial summaries of consecutive parts of one conference transcript, in order.',
    'Merge them into a single concise set of key points, in the language they are mostly in.',
    'Keep any line that reports a failed part as its own note.',
    '',
    partials.join('\n\n')
  ].join('\n');
  return callWithTimeout(client, model, reducePrompt, callTimeoutMs);
}
