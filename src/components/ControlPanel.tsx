import type { WelcomePayload } from '../asr/protocol';

export interface ControlPanelProps {
  /** Server state, never local. Null until session.welcome arrives. */
  state: WelcomePayload | null;
  disabled: boolean;
  onSetLanguages: (source: string, target: string) => void;
  onSetPaused: (paused: boolean) => void;
  onSetGate: (minWords: number, minIntervalMs: number) => void;
  onReport: (start: boolean) => void;
}

export default function ControlPanel({ state, disabled, onSetLanguages, onSetPaused, onSetGate, onReport }: ControlPanelProps) {
  if (!state) return <p className="text-sm text-slate-500">รอสถานะจากเซิร์ฟเวอร์…</p>;

  const swap = () => onSetLanguages(state.target_lang, state.source_lang);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-xs text-slate-400 mb-1">ทิศทางการแปล</p>
        <div className="flex items-center gap-2">
          <span className="px-3 py-1.5 bg-slate-800 rounded text-sm">{state.source_lang}</span>
          <span>→</span>
          <span className="px-3 py-1.5 bg-slate-800 rounded text-sm">{state.target_lang}</span>
          <button onClick={swap} disabled={disabled || !state.asr_switchable} className="px-3 py-1.5 rounded bg-slate-700 text-sm disabled:opacity-40">
            ⇅ สลับภาษา
          </button>
        </div>
        {state.asr_switchable && (
          // Retargeting Speech-to-Text restarts the recognition stream.
          <p className="text-xs text-slate-500 mt-1">การสลับภาษาต้นทางจะรีสตาร์ทการฟังเสียงราว 1 วินาที</p>
        )}
      </div>

      <button
        onClick={() => onSetPaused(!state.paused)}
        disabled={disabled}
        className={`self-start px-3 py-1.5 rounded text-sm ${state.paused ? 'bg-emerald-600' : 'bg-slate-700'} disabled:opacity-40`}
      >
        {state.paused ? 'เล่นต่อ' : 'พักการถอดความ'}
      </button>

      <div>
        <p className="text-xs text-slate-400 mb-1">
          จังหวะแปลระหว่างพูด — อย่างน้อย {state.gate.min_words} คำ ทุก {state.gate.min_interval_ms} ms
        </p>
        <div className="flex gap-2">
          <button onClick={() => onSetGate(2, 250)} disabled={disabled} className="px-3 py-1.5 rounded bg-slate-700 text-sm disabled:opacity-40">
            ⚡ ไว
          </button>
          <button onClick={() => onSetGate(3, 400)} disabled={disabled} className="px-3 py-1.5 rounded bg-slate-700 text-sm disabled:opacity-40">
            ⚖️ มาตรฐาน
          </button>
          <button onClick={() => onSetGate(5, 700)} disabled={disabled} className="px-3 py-1.5 rounded bg-slate-700 text-sm disabled:opacity-40">
            🧘 ผ่อนคลาย
          </button>
        </div>
      </div>

      <button
        onClick={() => onReport(!state.report.active)}
        disabled={disabled}
        className="self-start px-3 py-1.5 rounded bg-slate-700 text-sm disabled:opacity-40"
      >
        {state.report.active ? `หยุดบันทึกช่วง (${state.report.count} รายการ)` : 'เริ่มบันทึกช่วงเพื่อสรุป'}
      </button>
    </div>
  );
}
