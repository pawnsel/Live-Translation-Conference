import { useState } from 'react';
import type { GlossarySections } from '../asr/protocol';
import type { GlossarySection } from '../asr/commands';

const SECTIONS: Array<{ key: GlossarySection; label: string; hint: string }> = [
  { key: 'thai_corrections', label: 'แก้คำไทยที่ฟังผิด', hint: 'ไทย → ไทย เช่น ยาพารา → ยาพาราเซตามอล' },
  { key: 'protected_terms', label: 'ศัพท์เฉพาะที่ต้องคงคำแปล', hint: 'ไทย → อังกฤษ เช่น ความดันโลหิตสูง → hypertension' },
  { key: 'person_names', label: 'ชื่อบุคคล', hint: 'ไทย → อังกฤษ เช่น นพ. สมชาย → Dr. Somchai' },
];

export interface DictionaryManagerProps {
  sections: GlossarySections | null;
  onAdd: (section: GlossarySection, abbr: string, full: string) => void;
  onRemove: (section: GlossarySection, abbr: string) => void;
  onReload: () => void;
  disabled: boolean;
}

export default function DictionaryManager({ sections, onAdd, onRemove, onReload, disabled }: DictionaryManagerProps) {
  const [active, setActive] = useState<GlossarySection>('protected_terms');
  const [abbr, setAbbr] = useState('');
  const [full, setFull] = useState('');

  const entries = Object.entries(sections?.[active] ?? {});

  const submit = () => {
    if (!abbr.trim() || !full.trim()) return;
    onAdd(active, abbr.trim(), full.trim());
    setAbbr('');
    setFull('');
  };

  return (
    <div className="flex flex-col gap-3">
      {/* The glossary is process-wide on the backend: one file shared by every
          live session. A console that implied otherwise would let one operator
          silently change another venue's event. */}
      <p className="text-xs text-amber-300 bg-amber-950/40 border border-amber-800 rounded p-2">
        ⚠️ พจนานุกรมนี้ใช้ร่วมกันทุกเซสชันบนเซิร์ฟเวอร์ การแก้ไขจะมีผลกับทุกงานที่กำลังถ่ายทอดอยู่
      </p>

      <div className="flex gap-2">
        {SECTIONS.map((s) => (
          <button
            key={s.key}
            onClick={() => setActive(s.key)}
            className={`px-3 py-1.5 rounded text-sm ${active === s.key ? 'bg-pink-600 text-white' : 'bg-slate-700 text-slate-200'}`}
          >
            {s.label}
          </button>
        ))}
      </div>

      <p className="text-xs text-slate-400">{SECTIONS.find((s) => s.key === active)?.hint}</p>

      <div className="flex gap-2">
        <input
          value={abbr}
          onChange={(e) => setAbbr(e.target.value)}
          placeholder="คำที่ได้ยิน"
          disabled={disabled}
          className="flex-1 bg-slate-800 rounded px-2 py-1.5 text-sm"
        />
        <input
          value={full}
          onChange={(e) => setFull(e.target.value)}
          placeholder="คำที่ต้องการ"
          disabled={disabled}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          className="flex-1 bg-slate-800 rounded px-2 py-1.5 text-sm"
        />
        <button onClick={submit} disabled={disabled} className="px-3 py-1.5 rounded bg-pink-600 text-white text-sm disabled:opacity-40">
          เพิ่ม
        </button>
      </div>

      <div className="max-h-64 overflow-y-auto flex flex-col gap-1">
        {entries.length === 0 && <p className="text-sm text-slate-500">ยังไม่มีคำในหมวดนี้</p>}
        {entries.map(([key, value]) => (
          <div key={key} className="flex items-center gap-2 bg-slate-800/60 rounded px-2 py-1 text-sm">
            <span className="flex-1 truncate">{key}</span>
            <span className="text-slate-400">→</span>
            <span className="flex-1 truncate">{value}</span>
            <button onClick={() => onRemove(active, key)} disabled={disabled} className="text-slate-400 hover:text-red-400 disabled:opacity-40">
              ✕
            </button>
          </div>
        ))}
      </div>

      <button onClick={onReload} disabled={disabled} className="self-start text-xs text-slate-400 hover:text-slate-200 disabled:opacity-40">
        โหลดพจนานุกรมใหม่จากไฟล์บนเซิร์ฟเวอร์
      </button>
    </div>
  );
}
