import type { AnyFrame, CaptionPayload, TargetPayload } from './protocol';

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

interface FinalEntry {
  sourceText: string;
  sourceLang: string;
  targetLang: string;
  ts: number;
  latencyMs: number;
}

interface TargetEntry {
  targetText: string;
  targetLang: string;
  latencyMs: number;
  rev: number;
}

interface InterimEntry {
  seq: number;
  sourceText: string;
}

export interface CaptionState {
  finals: Record<number, FinalEntry>;
  // Kept separate from `finals` so a target_update that overtakes its own
  // caption.final is held rather than dropped. Merging them would make
  // correctness depend on arrival order, which the protocol does not promise.
  targets: Record<number, TargetEntry>;
  edits: Record<number, string>;
  interim: InterimEntry | null;
}

export const initialCaptionState: CaptionState = {
  finals: {},
  targets: {},
  edits: {},
  interim: null,
};

export type CaptionAction =
  | { kind: 'frame'; frame: AnyFrame }
  | { kind: 'edit'; seq: number; targetText: string }
  | { kind: 'reset' };

function applyTarget(state: CaptionState, seq: number, data: TargetPayload): CaptionState {
  const existing = state.targets[seq];
  // The rule from protocol-v1.md: seq says WHICH caption, rev orders the
  // frames within it. A strict `>` also drops exact duplicates, which a
  // reconnect can deliver.
  if (existing && data.rev <= existing.rev) return state;
  return {
    ...state,
    targets: {
      ...state.targets,
      [seq]: {
        targetText: data.target_text,
        targetLang: data.target_lang,
        latencyMs: data.latency_ms,
        rev: data.rev,
      },
    },
  };
}

export function captionsReducer(state: CaptionState, action: CaptionAction): CaptionState {
  if (action.kind === 'reset') return initialCaptionState;

  if (action.kind === 'edit') {
    return { ...state, edits: { ...state.edits, [action.seq]: action.targetText } };
  }

  const frame = action.frame;
  const seq = typeof frame.seq === 'number' ? frame.seq : null;

  switch (frame.type) {
    case 'caption.partial': {
      if (seq === null) return state;
      const data = frame.data as CaptionPayload;
      return { ...state, interim: { seq, sourceText: data.source_text } };
    }

    case 'caption.final': {
      if (seq === null) return state;
      const data = frame.data as CaptionPayload;
      return {
        ...state,
        finals: {
          ...state.finals,
          [seq]: {
            sourceText: data.source_text,
            sourceLang: data.source_lang,
            targetLang: data.target_lang,
            ts: frame.ts,
            latencyMs: data.latency_ms,
          },
        },
        interim: state.interim?.seq === seq ? null : state.interim,
      };
    }

    case 'caption.target_partial':
    case 'caption.target_update': {
      if (seq === null) return state;
      return applyTarget(state, seq, frame.data as TargetPayload);
    }

    // Every other frame type, known or unknown, belongs to someone else.
    // Ignoring unknown types is required by the protocol.
    default:
      return state;
  }
}

export function selectCaptions(state: CaptionState): Caption[] {
  return Object.keys(state.finals)
    .map(Number)
    .sort((a, b) => a - b)
    .map((seq) => {
      const final = state.finals[seq];
      const target = state.targets[seq];
      const edit = state.edits[seq];
      return {
        seq,
        sourceText: final.sourceText,
        // An operator edit outranks anything the server sends afterwards.
        // The alternative — letting a late target overwrite a correction the
        // operator just typed — is the behaviour that makes people stop
        // trusting the edit button.
        targetText: edit ?? target?.targetText ?? '',
        sourceLang: final.sourceLang,
        targetLang: target?.targetLang ?? final.targetLang,
        ts: final.ts,
        latencyMs: target?.latencyMs ?? final.latencyMs,
        isEdited: edit !== undefined,
      };
    });
}
