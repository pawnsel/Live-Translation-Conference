import type { SessionSnapshot } from '../asr/sessions';

export interface SessionBarProps {
  session: SessionSnapshot | null;
  candidates: SessionSnapshot[];
  connecting: boolean;
  micActive: boolean;
  micStatus: string;
  backpressure: boolean;
  droppedFrames: number;
  onAdopt: (id: string) => void;
  onCreate: () => void;
  onEnd: () => void;
  onToggleMic: () => void;
}

function Health({ label, value }: { label: string; value: boolean | null }) {
  // null is "does not apply" — a local session has no remote source, and the
  // DUAL_ASR helper is absent when the feature is off. Painting either as
  // dead would cry wolf on a healthy event.
  if (value === null) return null;
  return (
    <span className={`text-xs px-2 py-0.5 rounded ${value ? 'bg-emerald-900 text-emerald-300' : 'bg-red-900 text-red-300'}`}>
      {label}: {value ? 'ปกติ' : 'ขัดข้อง'}
    </span>
  );
}

export default function SessionBar(props: SessionBarProps) {
  const { session, candidates, connecting, micActive, micStatus, backpressure, droppedFrames } = props;

  if (!session && candidates.length > 1) {
    return (
      <div className="flex flex-col gap-2 p-3 bg-slate-800 rounded">
        <p className="text-sm">มีหลายเซสชันกำลังทำงานอยู่ เลือกเซสชันที่ต้องการควบคุม:</p>
        {candidates.map((c) => (
          <button key={c.id} onClick={() => props.onAdopt(c.id)} className="text-left px-3 py-2 bg-slate-700 rounded text-sm">
            {c.id} — {c.source_lang} → {c.target_lang} · {c.clients} จอ
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3 p-3 bg-slate-800 rounded">
      <span className="text-sm font-mono">{session ? session.id : connecting ? 'กำลังเชื่อมต่อ…' : 'ยังไม่มีเซสชัน'}</span>

      {session && (
        <>
          <Health label="ASR" value={session.recognizer_alive} />
          <Health label="ตัวช่วยไทย" value={session.helper_alive} />
          <Health label="เสียงเข้า" value={session.audio_alive} />
        </>
      )}

      <div className="flex-1" />

      {!session && (
        <button onClick={props.onCreate} className="px-3 py-1.5 rounded bg-pink-600 text-white text-sm">
          สร้างเซสชันใหม่
        </button>
      )}

      {session && (
        <>
          <button
            onClick={props.onToggleMic}
            className={`px-3 py-1.5 rounded text-sm ${micActive ? 'bg-red-600' : 'bg-pink-600'} text-white`}
          >
            {micActive ? 'หยุดส่งเสียง' : 'เริ่มส่งเสียง'}
          </button>
          <button onClick={props.onEnd} className="px-3 py-1.5 rounded bg-slate-600 text-sm">
            จบเซสชัน
          </button>
        </>
      )}

      {micStatus && <span className="w-full text-xs text-slate-400">{micStatus}</span>}
      {backpressure && (
        <span className="w-full text-xs text-amber-300">
          เซิร์ฟเวอร์รับเสียงไม่ทัน กำลังตัดเฟรมทิ้ง ({droppedFrames} เฟรม)
        </span>
      )}
    </div>
  );
}
