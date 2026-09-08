
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


export async function summarizeTranscript(
  client: GenerateContentClient,
  transcript: TranscriptLine[],
  model: string
): Promise<string> {
  const lines = transcript.map((line, i) => `[${i + 1}] ${line.sourceText} => ${line.targetText}`);
  const prompt = [
    'Summarize the following conference transcript into a concise set of key points, in the language the transcript is mostly in.',
    'Transcript:',
    ...lines
  ].join('\n');

  const response = await client.generateContent({
    model,
    contents: [{ role: 'user', parts: [{ text: prompt }] }]
  });
  if (!response.text) {
    throw new Error('Gemini returned an empty summary response (possibly safety-blocked)');
  }
  return response.text.trim();
}
