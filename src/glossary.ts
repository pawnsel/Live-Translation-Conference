export type GlossarySection = 'protected_terms' | 'person_names' | 'thai_corrections';
export type GlossarySections = Record<GlossarySection, Record<string, string>>;

export const GLOSSARY_STORAGE_KEY = 'ai_translate_glossary';

export function emptyGlossary(): GlossarySections {
  return { protected_terms: {}, person_names: {}, thai_corrections: {} };
}

// A plain object (not array/null) whose own values are all strings — the
// only shape glossaryPromptLines (server/gemini.ts) can safely turn into
// prompt lines via Object.entries.
function isValidSection(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((v) => typeof v === 'string');
}

export function loadGlossary(): GlossarySections {
  try {
    const raw = localStorage.getItem(GLOSSARY_STORAGE_KEY);
    if (!raw) return emptyGlossary();
    const parsed = JSON.parse(raw) as Partial<Record<GlossarySection, unknown>>;
    const empty = emptyGlossary();
    const result = emptyGlossary();
    // Corrupted storage, a manual edit, or an old format can deserialize a
    // section into a string/array/etc — validate each section independently
    // so junk there falls back to empty instead of producing garbage prompt
    // lines sent to Gemini.
    (Object.keys(empty) as GlossarySection[]).forEach((key) => {
      const value = parsed[key];
      result[key] = isValidSection(value) ? value : empty[key];
    });
    return result;
  } catch {
    return emptyGlossary();
  }
}

// Terms to bias the live API's speech recogniser toward
// (AudioTranscriptionConfig.customVocabulary). Only the SOURCE-language
// side of each entry is useful here: the recogniser is listening to Thai,
// so it needs the Thai term, not its translation. For thai_corrections
// that means the value (the corrected form), since the key is the
// mis-hearing we want to stop getting.
export function glossaryToVocabulary(sections: GlossarySections): string[] {
  const terms = [
    ...Object.keys(sections.protected_terms ?? {}),
    ...Object.keys(sections.person_names ?? {}),
    ...Object.values(sections.thai_corrections ?? {})
  ];
  const seen = new Set<string>();
  for (const term of terms) {
    const trimmed = term.trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen];
}

export function saveGlossary(sections: GlossarySections): void {
  try {
    localStorage.setItem(GLOSSARY_STORAGE_KEY, JSON.stringify(sections));
  } catch {
    // ignore quota errors, matching useProjects.ts's existing pattern
  }
}
