/** Reading and writing a glossary as a JSON file.
 *
 *  Pure — no repo, no React — so every rule about what a file may contain is
 *  tested without a database.
 *
 *  Two forms are accepted, told apart by the top-level keys:
 *
 *    flat        { "Kawin": "กวิน" }
 *                Says nothing about which section a term belongs to, so it
 *                lands in whichever one the operator has open — the same
 *                rule the paste-from-Excel box already follows.
 *
 *    sectioned   { "en_th_corrections": { "Kawin": "กวิน" }, ... }
 *                Carries a whole glossary, and is what export writes. The
 *                four sections behave differently enough (en_th_corrections
 *                substitutes by regex and is exact; person_names is a hint
 *                the model may ignore) that one flat file cannot restore a
 *                glossary without losing that distinction.
 */

import { emptyGlossary, type GlossarySection, type GlossarySections } from '../glossary';

/** Mirrors server/geminiLiveBridge.ts MAX_TERM_LENGTH. A longer term is
 *  stored intact but truncated before it reaches Gemini, so it would quietly
 *  stop matching — worth telling the operator about, not worth refusing. */
export const MAX_IMPORT_TERM_LENGTH = 100;

const SECTION_KEYS: GlossarySection[] = [
  'protected_terms',
  'person_names',
  'thai_corrections',
  'en_th_corrections'
];

function isSectionKey(key: string): key is GlossarySection {
  return (SECTION_KEYS as string[]).includes(key);
}

// The discriminant is a STRING, not a boolean `ok`. This project's tsconfig
// leaves strictNullChecks off, and under that setting TypeScript does not
// narrow a union on a boolean literal member — `if (r.ok) return;` leaves the
// union intact and every access below it fails to compile. A string
// discriminant narrows either way.
export interface GlossaryImportOk {
  status: 'ok';
  /** Which of the two shapes the file turned out to be. The UI names it so
   *  the operator can see the file was read the way they meant. */
  form: 'flat' | 'sectioned';
  sections: GlossarySections;
  /** Entries that will be written. */
  total: number;
  /** Entries dropped for having a blank term or translation. */
  skipped: number;
  /** Terms Gemini will see truncated (see MAX_IMPORT_TERM_LENGTH). */
  tooLong: string[];
}

export interface GlossaryImportError {
  status: 'error';
  error: string;
}

export type GlossaryImportResult = GlossaryImportOk | GlossaryImportError;

interface Accumulator {
  sections: GlossarySections;
  total: number;
  skipped: number;
  tooLong: string[];
}

/** Adds one pair, or counts it as skipped. Returns nothing — the caller
 *  reads the tallies off the accumulator. */
function addPair(acc: Accumulator, section: GlossarySection, rawTerm: string, rawValue: unknown): void {
  if (typeof rawValue !== 'string') {
    acc.skipped++;
    return;
  }
  const term = rawTerm.trim();
  const translation = rawValue.trim();
  if (!term || !translation) {
    acc.skipped++;
    return;
  }
  if (term.length > MAX_IMPORT_TERM_LENGTH) acc.tooLong.push(term);
  acc.sections[section][term] = translation;
  acc.total++;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parses file text into sections ready to write.
 *
 * `activeSection` is only consulted for the flat form; a sectioned file says
 * where its own terms go and the open tab is irrelevant to it.
 */
export function parseGlossaryFile(text: string, activeSection: GlossarySection): GlossaryImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: 'error', error: 'ไฟล์นี้ไม่ใช่ JSON ที่อ่านได้' };
  }
  if (!isPlainObject(parsed)) {
    return { status: 'error', error: 'ไฟล์ต้องเป็น object ของ JSON ไม่ใช่ array หรือค่าเดี่ยว' };
  }

  const keys = Object.keys(parsed);
  if (keys.length === 0) {
    return { status: 'error', error: 'ไฟล์นี้ไม่มีคำศัพท์อยู่เลย' };
  }

  const acc: Accumulator = { sections: emptyGlossary(), total: 0, skipped: 0, tooLong: [] };

  // A file is sectioned if ANY of its values is an object. Deciding on the
  // values rather than the key names is what lets an unrecognised section
  // name be reported instead of silently swallowing every term beneath it.
  const sectioned = keys.some((key) => isPlainObject(parsed[key]));

  if (sectioned) {
    for (const key of keys) {
      const value = parsed[key];
      if (!isPlainObject(value)) {
        return {
          status: 'error',
          error: `ไฟล์นี้ปนกันระหว่างสองรูปแบบ — "${key}" ไม่ใช่ชื่อหมวด แต่มีหมวดอื่นอยู่ในไฟล์เดียวกัน`
        };
      }
      if (!isSectionKey(key)) {
        return {
          status: 'error',
          error: `ไม่รู้จักหมวด "${key}" — ใช้ได้เฉพาะ ${SECTION_KEYS.join(', ')}`
        };
      }
      for (const [term, translation] of Object.entries(value)) {
        addPair(acc, key, term, translation);
      }
    }
  } else {
    for (const [term, translation] of Object.entries(parsed)) {
      // A number or null here means the file was built by something that did
      // not mean it as a glossary. Refusing beats importing half of it.
      if (translation !== null && typeof translation !== 'string') {
        return { status: 'error', error: `คำแปลของ "${term}" ไม่ใช่ข้อความ` };
      }
      addPair(acc, activeSection, term, translation);
    }
  }

  if (acc.total === 0) {
    return { status: 'error', error: 'ไม่พบคำที่ใช้ได้ในไฟล์นี้ — ทุกแถวมีช่องว่างอยู่ข้างใดข้างหนึ่ง' };
  }

  return {
    status: 'ok',
    form: sectioned ? 'sectioned' : 'flat',
    sections: acc.sections,
    total: acc.total,
    skipped: acc.skipped,
    tooLong: acc.tooLong
  };
}

/** The sectioned form, for export. Empty sections are left out so a file
 *  holding only names is not three-quarters blank braces. */
export function toGlossaryFile(sections: GlossarySections): string {
  const out: Partial<Record<GlossarySection, Record<string, string>>> = {};
  for (const key of SECTION_KEYS) {
    const entries = sections[key] ?? {};
    if (Object.keys(entries).length > 0) out[key] = entries;
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}
