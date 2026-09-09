// Pure glossary data shapes and transforms shared by the client and server.
// The glossary itself is no longer read from localStorage: it is loaded per
// project from Supabase via src/data/glossaryRepo.ts and composed by
// src/hooks/useGlossary.ts. This module only holds the section types and
// the pure functions that turn those sections into recogniser vocabulary,
// model-facing term pairs, and in-place text corrections.

export type GlossarySection = 'protected_terms' | 'person_names' | 'thai_corrections' | 'en_th_corrections';
export type GlossarySections = Record<GlossarySection, Record<string, string>>;

export function emptyGlossary(): GlossarySections {
  return { protected_terms: {}, person_names: {}, thai_corrections: {}, en_th_corrections: {} };
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
    ...Object.values(sections.thai_corrections ?? {}),
    // en_th_corrections runs the other way round: the source side the
    // recogniser hears is the English key, not the Thai value.
    ...Object.keys(sections.en_th_corrections ?? {})
  ];
  const seen = new Set<string>();
  for (const term of terms) {
    const trimmed = term.trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen];
}

export interface GlossaryPair {
  term: string;
  translation: string;
}

// Term/translation pairs the model must honour when translating.
// customVocabulary only affects what the recogniser HEARS — it cannot pin
// how a term is rendered in the target language, which is the whole point
// of the protected-terms and person-names sections. Those are sent as
// structured pairs (never as prompt text: the server builds the
// instruction, so a browser cannot smuggle arbitrary prompts onto the
// billed key).
export function glossaryToPairs(sections: GlossarySections): GlossaryPair[] {
  const pairs: GlossaryPair[] = [];
  const seen = new Set<string>();
  for (const section of [
    sections.protected_terms ?? {},
    sections.person_names ?? {},
    sections.en_th_corrections ?? {}
  ]) {
    for (const [term, translation] of Object.entries(section)) {
      const t = term.trim();
      const v = translation.trim();
      if (!t || !v || seen.has(t)) continue;
      seen.add(t);
      pairs.push({ term: t, translation: v });
    }
  }
  return pairs;
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Rewrites the English terms in `en_th_corrections` into their Thai forms.
//
// The same pairs are also sent to the model (glossaryToPairs), but a model
// hint is a request, not a guarantee: a romanised name it decides to leave
// alone would reach the screen as "Kawin" mid-Thai-sentence. This pass
// makes the substitution certain. Callers must apply it only when the text
// really is the Thai side — see useGeminiLiveCapture.
export function applyEnThCorrections(text: string, sections: GlossarySections): string {
  const entries = Object.entries(sections.en_th_corrections ?? {})
    .map(([term, replacement]) => [term.trim(), replacement.trim()] as const)
    .filter(([term, replacement]) => term && replacement);
  if (entries.length === 0) return text;

  // Longest first, so "Kawin Chai" wins over "Kawin" at the same position —
  // JS alternation takes the first branch that matches, not the longest.
  const byTerm = new Map(entries.map(([term, replacement]) => [term.toLowerCase(), replacement]));
  const alternation = entries
    .map(([term]) => term)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|');

  // A leading separator is matched (and put back) rather than looked behind
  // for, so this needs no lookbehind support. The trailing lookahead is
  // enough on its own to stop "Kawin" matching inside "Kawinsky".
  // One global pass means a replacement's own text is never rescanned.
  const pattern = new RegExp(`(^|[^A-Za-z0-9_])(${alternation})(?![A-Za-z0-9_])`, 'gi');
  return text.replace(pattern, (match, prefix: string, term: string) => {
    const replacement = byTerm.get(term.toLowerCase());
    return replacement === undefined ? match : prefix + replacement;
  });
}
