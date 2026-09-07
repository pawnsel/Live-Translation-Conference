import type { GlossarySections } from '../src/glossary';

// Injectable so tests never touch the real network or the @google/genai
// module — server.ts wires the real SDK to this shape (see Task 7).
export interface GenerateContentClient {
  generateContent(args: { model: string; contents: unknown; config?: unknown }): Promise<{ text: string }>;
}

export interface TranscribeChunkInput {
  audio: Buffer;
  mimeType: string;
  sourceLang: string;
  targetLang: string;
  glossary: GlossarySections;
  context: string;
}

export interface TranscribeChunkResult {
  sourceText: string;
  targetText: string;
}

export interface TranscriptLine {
  sourceText: string;
  targetText: string;
}

const LANG_NAMES: Record<string, string> = { th: 'Thai', en: 'English' };

const TRANSCRIBE_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    source_text: { type: 'string' },
    target_text: { type: 'string' }
  },
  required: ['source_text', 'target_text']
};

function langName(code: string): string {
  return LANG_NAMES[code] ?? code;
}

function glossaryPromptLines(sections: GlossarySections): string[] {
  const lines: string[] = [];
  const protectedTerms = Object.entries(sections.protected_terms ?? {});
  if (protectedTerms.length > 0) {
    lines.push('Always keep these exact translations for these terms:');
    protectedTerms.forEach(([term, translation]) => lines.push(`- "${term}" -> "${translation}"`));
  }
  const personNames = Object.entries(sections.person_names ?? {});
  if (personNames.length > 0) {
    lines.push('Transliterate these speaker names exactly as given:');
    personNames.forEach(([term, translation]) => lines.push(`- "${term}" -> "${translation}"`));
  }
  const corrections = Object.entries(sections.thai_corrections ?? {});
  if (corrections.length > 0) {
    lines.push('If you hear these commonly mis-heard words, correct them before transcribing:');
    corrections.forEach(([term, correction]) => lines.push(`- "${term}" -> "${correction}"`));
  }
  return lines;
}

function buildTranscribePrompt(input: TranscribeChunkInput): string {
  const lines = [
    `You are transcribing live conference audio spoken in ${langName(input.sourceLang)}.`,
    `Transcribe the audio verbatim in ${langName(input.sourceLang)}, then translate it naturally into ${langName(input.targetLang)}.`,
    'Respond with strict JSON matching the given schema. Do not include any text outside the JSON.'
  ];
  if (input.context.trim()) {
    lines.push(`Previous context, for coherence only — do not repeat it in your output: "${input.context.trim()}"`);
  }
  lines.push(...glossaryPromptLines(input.glossary));
  return lines.join('\n');
}

export async function transcribeChunk(
  client: GenerateContentClient,
  input: TranscribeChunkInput,
  model: string
): Promise<TranscribeChunkResult> {
  const response = await client.generateContent({
    model,
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: input.mimeType, data: input.audio.toString('base64') } },
          { text: buildTranscribePrompt(input) }
        ]
      }
    ],
    config: {
      responseMimeType: 'application/json',
      responseSchema: TRANSCRIBE_RESPONSE_SCHEMA
    }
  });

  let parsed: { source_text?: string; target_text?: string };
  try {
    parsed = JSON.parse(response.text);
  } catch {
    throw new Error('Gemini returned a non-JSON transcription response');
  }
  if (!parsed.source_text || !parsed.target_text) {
    throw new Error('Gemini transcription response is missing source_text or target_text');
  }
  return { sourceText: parsed.source_text, targetText: parsed.target_text };
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
  return response.text.trim();
}
