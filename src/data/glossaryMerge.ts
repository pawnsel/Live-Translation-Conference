/** Folds the glossary lists a project uses into the single GlossarySections
 *  the capture hook and the dictionary UI already understand.
 *
 *  Precedence, lowest to highest: shared lists in the order given, then the
 *  project's own list. The project wins because an operator correcting a
 *  wrong shared term mid-meeting has to see that correction take effect —
 *  a canonical list that cannot be overridden locally is a canonical list
 *  people work around.
 */

import { emptyGlossary, type GlossarySection, type GlossarySections } from '../glossary';

export function mergeGlossary(
  shared: GlossarySections[],
  own: GlossarySections
): GlossarySections {
  const result = emptyGlossary();
  const keys = Object.keys(result) as GlossarySection[];

  for (const source of [...shared, own]) {
    for (const key of keys) {
      // Sections never mix: a person name cannot become a protected term by
      // being merged.
      Object.assign(result[key], source[key] ?? {});
    }
  }

  return result;
}
