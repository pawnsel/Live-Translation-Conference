export interface Caption {
  seq: number;
  sourceText: string;
  targetText: string;
  sourceLang: string;
  targetLang: string;
  ts: number;
  latencyMs: number;
  isEdited: boolean;
}

interface StoredCaption {
  sourceText: string;
  targetText: string;
  sourceLang: string;
  targetLang: string;
  ts: number;
  latencyMs: number;
}

export interface CaptionState {
  items: Record<number, StoredCaption>;
  edits: Record<number, string>;
}

export const initialCaptionState: CaptionState = { items: {}, edits: {} };

export type CaptionAction =
  | { kind: 'add'; seq: number; sourceText: string; targetText: string; sourceLang: string; targetLang: string; latencyMs: number }
  | { kind: 'edit'; seq: number; targetText: string }
  | { kind: 'reset' };

export function captionsReducer(state: CaptionState, action: CaptionAction): CaptionState {
  if (action.kind === 'reset') return initialCaptionState;

  if (action.kind === 'edit') {
    return { ...state, edits: { ...state.edits, [action.seq]: action.targetText } };
  }

  return {
    ...state,
    items: {
      ...state.items,
      [action.seq]: {
        sourceText: action.sourceText,
        targetText: action.targetText,
        sourceLang: action.sourceLang,
        targetLang: action.targetLang,
        ts: Date.now() / 1000,
        latencyMs: action.latencyMs
      }
    }
  };
}

export function selectCaptions(state: CaptionState): Caption[] {
  return Object.keys(state.items)
    .map(Number)
    .sort((a, b) => a - b)
    .map((seq) => {
      const item = state.items[seq];
      const edit = state.edits[seq];
      return {
        seq,
        sourceText: item.sourceText,
        // An operator edit outranks whatever Gemini returned — the
        // alternative, losing a correction the operator just typed, is what
        // makes people stop trusting the edit button.
        targetText: edit ?? item.targetText,
        sourceLang: item.sourceLang,
        targetLang: item.targetLang,
        ts: item.ts,
        latencyMs: item.latencyMs,
        isEdited: edit !== undefined
      };
    });
}
