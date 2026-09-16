import { useEffect, useRef } from 'react';
import { AlertTriangle, AppWindow, Lock, MonitorUp, RotateCcw, Square } from 'lucide-react';
import type { ScreenShare } from './useScreenShare';
import type { OutputWindow } from './useOutputWindow';
import { clampBar } from './outputLayout';
import {
  DEFAULT_OUTPUT_PREFS,
  MAX_BAR_WIDTH_PCT,
  MAX_SLIDE_PCT,
  MIN_BAR_WIDTH_PCT,
  MIN_SLIDE_PCT,
  type OutputPrefs
} from '../storage/outputStore';

interface StreamPanelProps {
  share: ScreenShare;
  output: OutputWindow;
  prefs: OutputPrefs;
  onPrefsChange: (prefs: OutputPrefs) => void;
}

function Thumbnail({ stream }: { stream: MediaStream | null }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    video.srcObject = stream;
    if (!stream) return;
    const playing = video.play() as Promise<void> | undefined;
    playing?.catch(() => undefined);
  }, [stream]);
  return <video ref={ref} autoPlay muted playsInline className="w-full aspect-video rounded-lg bg-black object-contain" />;
}

const section = 'space-y-2.5 bg-slate-50 p-3.5 rounded-xl border border-slate-200';
const primaryButton =
  'w-full flex items-center justify-center gap-1.5 py-2.5 px-3 rounded-lg text-xs font-bold bg-[#DE5C8E] hover:bg-[#c94577] text-white transition-all';
const secondaryButton =
  'flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg text-xs font-semibold border border-slate-200 bg-white text-slate-600 hover:text-slate-900 transition-all shrink-0 whitespace-nowrap';
const warning = 'flex gap-2 text-[11px] leading-relaxed text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-2.5';
const layoutButtonSelected =
  'flex items-center justify-center gap-1.5 py-2 px-1 rounded-lg text-[11px] font-bold border transition-all border-[#DE5C8E] ring-2 ring-pink-100 bg-white text-slate-800';
const layoutButtonUnselected =
  'flex items-center justify-center gap-1.5 py-2 px-1 rounded-lg text-[11px] font-bold border transition-all border-slate-200 bg-slate-50 text-slate-500 hover:bg-white';

/** The สตรีม tab: share the projector display, open the window OBS captures,
 *  and place the caption bar. Independent of the translation session. */
export default function StreamPanel({ share, output, prefs, onPrefsChange }: StreamPanelProps) {
  const sharing = share.status === 'sharing';

  const setWidth = (widthPct: number) => {
    const { x, y } = clampBar({ x: prefs.x, y: prefs.y }, { widthPct, heightPct: 0 });
    onPrefsChange({ ...prefs, widthPct, x, y });
  };
  const isLetterbox = prefs.layout === 'letterbox';

  return (
    <div className="space-y-4">
      <div className={section}>
        <div className="text-xs font-bold text-slate-800">1. แชร์หน้าจอสไลด์</div>
        {sharing ? (
          <>
            <Thumbnail stream={share.stream} />
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-[11px] font-semibold text-emerald-700 min-w-0">
                <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
                <span className="truncate">กำลังแชร์: {share.label || 'หน้าจอ'}</span>
              </span>
              <button type="button" onClick={share.stop} className={secondaryButton}>
                <Square className="w-3 h-3" />
                <span>หยุดแชร์</span>
              </button>
            </div>
            <button type="button" onClick={() => void share.start()} className={`${secondaryButton} w-full`}>
              <MonitorUp className="w-3.5 h-3.5" />
              <span>เปลี่ยนจอที่แชร์</span>
            </button>
          </>
        ) : (
          <>
            {share.status === 'ended' && (
              <div className={warning}>
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>แชร์จอหยุดแล้ว — หน้าต่าง Output ยังเปิดอยู่และแสดงพื้นดำกับคำแปล กดแชร์ใหม่เพื่อให้สไลด์กลับมา</span>
              </div>
            )}
            <button type="button" onClick={() => void share.start()} className={primaryButton}>
              <MonitorUp className="w-4 h-4" />
              <span>{share.status === 'ended' ? 'แชร์ใหม่ (เลือกจอที่จะแชร์)' : 'เลือกจอที่จะแชร์'}</span>
            </button>
            <p className="text-[11px] text-slate-500 leading-relaxed">
              เลือก <b>ทั้งหน้าจอ</b> ของจอ projector ที่เปิดสไลด์ — อย่าเลือกจอที่มีหน้านี้อยู่ ภาพจะซ้อนกันไม่รู้จบ
            </p>
          </>
        )}
        {share.error === 'system-denied' && (
          <div className={warning}>
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>
              macOS ยังไม่อนุญาตให้เบราว์เซอร์บันทึกหน้าจอ: เปิด System Settings → Privacy &amp; Security → Screen Recording
              แล้วเปิดสิทธิ์ให้ Chrome/Edge จากนั้น <b>ปิดและเปิดเบราว์เซอร์ใหม่</b>
            </span>
          </div>
        )}
        {share.error === 'unsupported' && (
          <div className={warning}>
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>เบราว์เซอร์นี้แชร์หน้าจอไม่ได้ — ใช้ Google Chrome หรือ Microsoft Edge</span>
          </div>
        )}
        {share.error === 'failed' && (
          <div className={warning}>
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>แชร์หน้าจอไม่สำเร็จ ลองใหม่อีกครั้ง</span>
          </div>
        )}
      </div>

      <div className={section}>
        <div className="text-xs font-bold text-slate-800">2. หน้าต่าง Output (ให้ OBS จับ)</div>
        {output.isOpen ? (
          <button type="button" onClick={output.close} className={`${secondaryButton} w-full`}>
            <AppWindow className="w-3.5 h-3.5" />
            <span>ปิดหน้าต่าง Output</span>
          </button>
        ) : (
          <button type="button" onClick={() => void output.open()} className={primaryButton}>
            <AppWindow className="w-4 h-4" />
            <span>เปิดหน้าต่าง Output</span>
          </button>
        )}
        {output.error === 'blocked' && (
          <div className={warning}>
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>เบราว์เซอร์บล็อกหน้าต่างใหม่ — กดไอคอนที่ช่อง address bar เพื่ออนุญาต popup สำหรับเว็บนี้ แล้วกดเปิดอีกครั้ง</span>
          </div>
        )}
        {output.error === 'failed' && (
          <div className={warning}>
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>เปิดหน้าต่าง Output ไม่สำเร็จ ลองกดอีกครั้ง</span>
          </div>
        )}

        <div>
          <div className="text-[11px] font-bold text-slate-700 mb-1">รูปแบบการวางคำแปล</div>
          <div className="grid grid-cols-2 gap-1.5">
            <button
              type="button"
              onClick={() => onPrefsChange({ ...prefs, layout: 'overlay' })}
              className={isLetterbox ? layoutButtonUnselected : layoutButtonSelected}
            >
              <span>ทับบนสไลด์</span>
            </button>
            <button
              type="button"
              onClick={() => onPrefsChange({ ...prefs, layout: 'letterbox' })}
              className={isLetterbox ? layoutButtonSelected : layoutButtonUnselected}
            >
              <span>แบ่งพื้นที่</span>
            </button>
          </div>
        </div>

        {isLetterbox && (
          <div>
            <label htmlFor="output-slide-size" className="flex justify-between text-[11px] font-bold text-slate-700 mb-1">
              <span>ขนาดสไลด์</span>
              <span className="font-mono text-slate-500">{prefs.slidePct}%</span>
            </label>
            <input
              id="output-slide-size"
              type="range"
              min={MIN_SLIDE_PCT}
              max={MAX_SLIDE_PCT}
              step={5}
              value={prefs.slidePct}
              onChange={(e) => onPrefsChange({ ...prefs, slidePct: Number(e.target.value) })}
              className="w-full accent-[#DE5C8E]"
            />
          </div>
        )}

        <div>
          <label htmlFor="output-bar-width" className="flex justify-between text-[11px] font-bold text-slate-700 mb-1">
            <span>ความกว้างแถบคำแปล</span>
            <span className="font-mono text-slate-500">{prefs.widthPct}%</span>
          </label>
          <input
            id="output-bar-width"
            type="range"
            min={MIN_BAR_WIDTH_PCT}
            max={MAX_BAR_WIDTH_PCT}
            step={5}
            value={prefs.widthPct}
            onChange={(e) => setWidth(Number(e.target.value))}
            className="w-full accent-[#DE5C8E]"
          />
        </div>

        {isLetterbox ? (
          <p className="text-[11px] text-slate-500 leading-relaxed">
            แถบคำแปลจะจัดกึ่งกลางแถบดำด้านล่างให้เอง ลากไม่ได้ในโหมดนี้ — ถ้าแถบต้องการพื้นที่มากกว่าที่เหลือ สไลด์จะหดลงให้เอง
          </p>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2">
              <label className="flex items-center gap-2 text-[11px] font-semibold text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={prefs.locked}
                  onChange={(e) => onPrefsChange({ ...prefs, locked: e.target.checked })}
                  className="accent-[#DE5C8E]"
                />
                <Lock className="w-3 h-3" />
                <span>ล็อกตำแหน่ง</span>
              </label>
              <button
                type="button"
                onClick={() => onPrefsChange({ ...prefs, x: DEFAULT_OUTPUT_PREFS.x, y: DEFAULT_OUTPUT_PREFS.y })}
                className={secondaryButton}
              >
                <RotateCcw className="w-3 h-3" />
                <span>รีเซ็ตตำแหน่ง</span>
              </button>
            </div>
            <p className="text-[11px] text-slate-500 leading-relaxed">
              ลากแถบคำแปลในหน้าต่าง Output เพื่อย้ายตำแหน่ง — ผู้ชมจะเห็นแถบขยับด้วย จัดให้เสร็จก่อนเริ่มถ่ายทอด แล้วกดล็อก
            </p>
          </>
        )}
      </div>

      <details className="bg-white rounded-xl border border-slate-200 p-3.5 text-[11px] text-slate-600 leading-relaxed">
        <summary className="text-xs font-bold text-slate-800 cursor-pointer">วิธีตั้งค่า OBS</summary>
        <ol className="list-decimal pl-4 mt-2 space-y-1.5">
          <li>เพิ่ม Source แบบ <b>Window Capture</b> แล้วเลือกหน้าต่าง "Live Translation — Output" (บน Windows เลือก Capture Method เป็น "Windows 10 (1903 and up)")</li>
          <li>ปิดตัวเลือก <b>Capture Cursor</b> เพื่อไม่ให้เมาส์ขึ้นบน stream</li>
          <li>ถ้าเป็นหน้าต่าง popup ที่มีแถบ address bar ให้ crop ด้านบนออก (คลิกขวา Source → Transform → Edit Transform)</li>
          <li><b>ห้าม minimise หน้าต่าง Output</b> — Chrome จะหยุดวาดภาพ และ OBS จะได้ภาพค้าง ย้ายไปไว้มุมจอหรือให้หน้าต่างอื่นอยู่ข้างๆ แทน</li>
          <li>macOS: ครั้งแรกต้องให้สิทธิ์บันทึกหน้าจอทั้งกับ Chrome/Edge และ OBS ใน System Settings (Privacy &amp; Security) — ทำก่อนวันงาน</li>
          <li>ถ้าเสียงคลิป YouTube ดังผ่านลำโพงห้อง ไมโครโฟนจะได้ยินและแปลด้วย — กด "พัก" session ระหว่างเปิดคลิปถ้าไม่ต้องการ</li>
        </ol>
      </details>
    </div>
  );
}

/** Header status: visible from every tab, so the operator always knows the
 *  broadcast window is live — or that the slides dropped out of it. */
export function StreamStatusChip({ share, output }: { share: ScreenShare; output: OutputWindow }) {
  const ended = share.status === 'ended' && output.isOpen;
  if (share.status !== 'sharing' && !output.isOpen) return null;
  return (
    <div className="flex items-center gap-1 shrink-0">
      {share.status === 'sharing' && (
        <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
          <span>แชร์จอ</span>
        </span>
      )}
      {ended && (
        <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200">
          <AlertTriangle className="w-3 h-3" />
          <span>แชร์จอหยุด</span>
        </span>
      )}
      {output.isOpen && (
        <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-pink-50 text-[#DE5C8E] border border-pink-200">
          <AppWindow className="w-3 h-3" />
          <span>Output</span>
        </span>
      )}
    </div>
  );
}
