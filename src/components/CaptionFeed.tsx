import { useState } from 'react';
import type { Caption } from '../asr/captions';
import type { DisplayConfig } from '../types';

export interface CaptionFeedProps {
  captions: Caption[];
  interim: string | null;
  config: DisplayConfig;
  onEdit: (seq: number, targetText: string) => void;
}

const FONT_SIZES: Record<string, string> = {
  small: 'text-base',
  medium: 'text-xl',
  large: 'text-2xl',
  xlarge: 'text-4xl',
};

export default function CaptionFeed({ captions, interim, config, onEdit }: CaptionFeedProps) {
  const [editingSeq, setEditingSeq] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const sizeClass = FONT_SIZES[config.fontSize ?? 'large'];

  return (
    <div className="flex flex-col gap-3">
      {captions.map((caption) => (
        <div key={caption.seq} className="border-b border-slate-800 pb-2">
          {config.showOriginal !== false && <p className="text-slate-400 text-sm">{caption.sourceText}</p>}

          {editingSeq === caption.seq ? (
            <div className="flex gap-2">
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    onEdit(caption.seq, draft);
                    setEditingSeq(null);
                  }
                  if (e.key === 'Escape') setEditingSeq(null);
                }}
                className="flex-1 bg-slate-800 rounded px-2 py-1"
              />
              <button
                onClick={() => {
                  onEdit(caption.seq, draft);
                  setEditingSeq(null);
                }}
                className="px-3 rounded bg-pink-600 text-white text-sm"
              >
                บันทึก
              </button>
            </div>
          ) : (
            <p className={`${sizeClass} leading-snug`} style={{ fontFamily: config.fontFamily }}>
              {/* A final arrives with an empty translation and the target
                  follows. Showing a placeholder rather than waiting is why
                  source captions appear at ASR latency. */}
              {caption.targetText || <span className="text-slate-600 text-base">กำลังแปล…</span>}
              {caption.isEdited && <span className="ml-2 text-xs text-amber-400">แก้ไขแล้ว</span>}
            </p>
          )}

          <div className="flex gap-3 text-xs text-slate-500 mt-1">
            {config.showLatency !== false && <span>{caption.latencyMs} ms</span>}
            <button
              onClick={() => {
                setEditingSeq(caption.seq);
                setDraft(caption.targetText);
              }}
              className="hover:text-slate-300"
            >
              แก้ไข
            </button>
          </div>
        </div>
      ))}

      {interim && <p className="text-slate-500 italic">{interim}</p>}
    </div>
  );
}
