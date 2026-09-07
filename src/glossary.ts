export type GlossarySection = 'protected_terms' | 'person_names' | 'thai_corrections';
export type GlossarySections = Record<GlossarySection, Record<string, string>>;

export const GLOSSARY_STORAGE_KEY = 'ai_translate_glossary';

export function emptyGlossary(): GlossarySections {
  return { protected_terms: {}, person_names: {}, thai_corrections: {} };
}

export function loadGlossary(): GlossarySections {
  try {
    const raw = localStorage.getItem(GLOSSARY_STORAGE_KEY);
    if (!raw) return emptyGlossary();
    const parsed = JSON.parse(raw) as Partial<GlossarySections>;
    return { ...emptyGlossary(), ...parsed };
  } catch {
    return emptyGlossary();
  }
}

export function saveGlossary(sections: GlossarySections): void {
  try {
    localStorage.setItem(GLOSSARY_STORAGE_KEY, JSON.stringify(sections));
  } catch {
    // ignore quota errors, matching useProjects.ts's existing pattern
  }
}
