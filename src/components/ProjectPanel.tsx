import React, { useEffect, useState } from 'react';
import { jsPDF } from 'jspdf';
import {
  FolderPlus,
  FlagTriangleRight,
  History,
  Download,
  X,
  Clock,
  Layers,
  ArrowRight,
  Repeat,
  AlarmClock,
  ClipboardList,
  Sparkles,
  AlertTriangle,
  CircleDollarSign
} from 'lucide-react';
import { Project, ProjectBill, ProjectSession } from '../types';
import { MAX_ACTIVE_PROJECTS, projectDaysLeft } from '../hooks/useProjects';
import type { LiveProjectCost } from '../hooks/useLiveProjectCost';
import { USD_TO_THB_RATE, usdToThb } from '../billing/currency';

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

const PDF_MARGIN_X = 48;
const PDF_INK = '#0f172a';
const PDF_MUTED = '#64748b';
const PDF_LINE = '#e2e8f0';
const PDF_ACCENT = '#DE5C8E';

/** The embedded Thai-capable face, registered on the document by
 *  `downloadBill` before any text is drawn. jsPDF's built-in helvetica is
 *  Latin-1 only and turns Thai — including most project names — into
 *  mojibake, so every setFont call below names this instead. */
export const PDF_FONT = 'Sarabun';

/** Renders the bill as a one-page PDF laid out like an ordinary purchase
 *  receipt — line items, a subtotal, a service fee, then a boxed total —
 *  rather than the plain key/value TXT file this replaces.
 *
 *  The caller must have registered PDF_FONT on `doc` already (see
 *  `downloadBill`); this function only lays text out. */
function billToPdf(doc: jsPDF, project: Project, bill: ProjectBill): jsPDF {
  const pageWidth = doc.internal.pageSize.getWidth();
  const rightX = pageWidth - PDF_MARGIN_X;
  let y = 60;

  // ── Header ────────────────────────────────────────────────────────────
  doc.setFont(PDF_FONT, 'bold');
  doc.setFontSize(18);
  doc.setTextColor(PDF_ACCENT);
  doc.text('Live Translation', PDF_MARGIN_X, y);

  doc.setFont(PDF_FONT, 'normal');
  doc.setFontSize(10);
  doc.setTextColor(PDF_MUTED);
  doc.text('ใบสรุปค่าใช้จ่าย / BILL', rightX, y, { align: 'right' });

  y += 16;
  doc.setFontSize(9);
  doc.text(`Bill No. ${project.id.slice(0, 8).toUpperCase()}`, rightX, y, { align: 'right' });
  y += 14;
  doc.text(`Issued ${new Date().toLocaleString()}`, rightX, y, { align: 'right' });

  y += 18;
  doc.setDrawColor(PDF_LINE);
  doc.line(PDF_MARGIN_X, y, rightX, y);
  y += 26;

  // ── Project meta, two columns ────────────────────────────────────────
  const metaRow = (label: string, value: string, x: number) => {
    doc.setFontSize(8);
    doc.setTextColor(PDF_MUTED);
    doc.text(label.toUpperCase(), x, y);
    doc.setFontSize(11);
    doc.setTextColor(PDF_INK);
    doc.setFont(PDF_FONT, 'bold');
    doc.text(value, x, y + 14);
    doc.setFont(PDF_FONT, 'normal');
  };
  const colWidth = (rightX - PDF_MARGIN_X) / 2;
  metaRow('Project', project.name, PDF_MARGIN_X);
  metaRow(
    'Finished',
    project.endedAt
      ? new Date(project.endedAt).toLocaleString() + (project.autoFinished ? ' (auto)' : '')
      : '-',
    PDF_MARGIN_X + colWidth
  );
  y += 34;
  metaRow('Sessions', String(bill.sessionCount), PDF_MARGIN_X);
  metaRow('Duration', formatDuration(bill.durationMs), PDF_MARGIN_X + colWidth);
  y += 34;
  metaRow('Words translated', String(bill.wordCount), PDF_MARGIN_X);

  y += 30;
  doc.setDrawColor(PDF_LINE);
  doc.line(PDF_MARGIN_X, y, rightX, y);
  y += 20;

  // ── Line items ────────────────────────────────────────────────────────
  doc.setFontSize(9);
  doc.setTextColor(PDF_MUTED);
  doc.setFont(PDF_FONT, 'bold');
  doc.text('DESCRIPTION', PDF_MARGIN_X, y);
  doc.text('AMOUNT (THB)', rightX, y, { align: 'right' });
  y += 10;
  doc.setDrawColor(PDF_LINE);
  doc.line(PDF_MARGIN_X, y, rightX, y);
  y += 20;

  doc.setFont(PDF_FONT, 'normal');
  doc.setFontSize(10);
  const lineItem = (label: string, amount: number) => {
    doc.setTextColor(PDF_INK);
    doc.text(label, PDF_MARGIN_X, y);
    doc.text(`฿${usdToThb(amount)}`, rightX, y, { align: 'right' });
    y += 20;
  };

  let subtotal = 0;
  if (bill.costBreakdown) {
    const b = bill.costBreakdown;
    lineItem(`Live audio (${b.liveMinutes.toFixed(1)} min)`, b.liveAudioCost);
    lineItem('Translation text', b.liveTextCost);
    lineItem(`Meeting summaries (${b.summaryRuns} run${b.summaryRuns === 1 ? '' : 's'})`, b.summaryCost);
    subtotal = b.liveAudioCost + b.liveTextCost + b.summaryCost;
  } else {
    lineItem('Estimated usage cost', bill.estimatedCost - (bill.serviceFee ?? 0));
    subtotal = bill.estimatedCost - (bill.serviceFee ?? 0);
  }

  y += 4;
  doc.setDrawColor(PDF_LINE);
  doc.line(PDF_MARGIN_X, y, rightX, y);
  y += 20;

  doc.setTextColor(PDF_MUTED);
  doc.text('Subtotal', PDF_MARGIN_X, y);
  doc.setTextColor(PDF_INK);
  doc.text(`฿${usdToThb(subtotal)}`, rightX, y, { align: 'right' });
  y += 20;

  doc.setTextColor(PDF_MUTED);
  doc.text('Service fee', PDF_MARGIN_X, y);
  doc.setTextColor(PDF_INK);
  doc.text(`฿${usdToThb(bill.serviceFee ?? 0)}`, rightX, y, { align: 'right' });
  y += 28;

  // ── Total, boxed ──────────────────────────────────────────────────────
  doc.setFillColor('#fdf2f8');
  doc.setDrawColor('#fbcfe8');
  doc.roundedRect(PDF_MARGIN_X, y - 18, rightX - PDF_MARGIN_X, 34, 6, 6, 'FD');
  doc.setFont(PDF_FONT, 'bold');
  doc.setFontSize(12);
  doc.setTextColor(PDF_ACCENT);
  doc.text('TOTAL (upper bound)', PDF_MARGIN_X + 14, y + 3);
  doc.setFontSize(14);
  doc.text(`฿${usdToThb(bill.estimatedCost)}`, rightX - 14, y + 3, { align: 'right' });
  y += 44;

  // ── Session breakdown ────────────────────────────────────────────────
  doc.setFont(PDF_FONT, 'bold');
  doc.setFontSize(9);
  doc.setTextColor(PDF_MUTED);
  doc.text('SESSIONS', PDF_MARGIN_X, y);
  y += 14;
  doc.setDrawColor(PDF_LINE);
  doc.line(PDF_MARGIN_X, y, rightX, y);
  y += 16;

  doc.setFont(PDF_FONT, 'normal');
  doc.setFontSize(9);
  doc.setTextColor(PDF_INK);
  // A project runs for up to seven days and can hold far more sessions than
  // fit below the total box. Without a break they were simply drawn past the
  // bottom edge and lost, taking the footer with them.
  const pageHeight = doc.internal.pageSize.getHeight();
  const bottomLimit = pageHeight - 72;
  project.sessions.forEach((s, i) => {
    if (y > bottomLimit) {
      doc.addPage();
      y = 60;
      doc.setFont(PDF_FONT, 'bold');
      doc.setFontSize(9);
      doc.setTextColor(PDF_MUTED);
      doc.text('SESSIONS (continued)', PDF_MARGIN_X, y);
      y += 14;
      doc.setDrawColor(PDF_LINE);
      doc.line(PDF_MARGIN_X, y, rightX, y);
      y += 16;
      doc.setFont(PDF_FONT, 'normal');
      doc.setTextColor(PDF_INK);
    }
    const duration = s.endedAt ? formatDuration(s.endedAt - s.startedAt) : '-';
    doc.text(`#${i + 1}  ${s.sourceLang} → ${s.targetLang}`, PDF_MARGIN_X, y);
    doc.text(duration, rightX, y, { align: 'right' });
    y += 16;
  });

  // ── Footer ────────────────────────────────────────────────────────────
  y += 16;
  if (y > bottomLimit) {
    doc.addPage();
    y = 60;
  }
  doc.setFontSize(8);
  doc.setTextColor(PDF_MUTED);
  const disclaimer =
    'Estimated from published Gemini API rates, billed pessimistically (full session duration counted as audio). ' +
    'Actual spend will not exceed this figure. This is not an official payment invoice. ' +
    `Converted to THB at an approximate rate of 1 USD ~ ${USD_TO_THB_RATE} THB.`;
  const wrapped = doc.splitTextToSize(disclaimer, rightX - PDF_MARGIN_X);
  doc.text(wrapped, PDF_MARGIN_X, y);

  return doc;
}

async function downloadBill(project: Project) {
  if (!project.bill) return;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });

  // Imported here, not at module scope: the two base64 faces are ~115 KB, and
  // nothing but this one click needs them. Awaiting a dynamic import inside a
  // click handler is safe — jsPDF's own save() is what opens the download, and
  // it is called below, not by the browser's gesture handling.
  const { SARABUN_REGULAR_BASE64, SARABUN_BOLD_BASE64 } = await import('./billPdfFont');
  doc.addFileToVFS('Sarabun-Regular.ttf', SARABUN_REGULAR_BASE64);
  doc.addFont('Sarabun-Regular.ttf', PDF_FONT, 'normal');
  doc.addFileToVFS('Sarabun-Bold.ttf', SARABUN_BOLD_BASE64);
  doc.addFont('Sarabun-Bold.ttf', PDF_FONT, 'bold');

  billToPdf(doc, project, project.bill);
  const filename = `bill_${project.name.replace(/\s+/g, '_')}_${new Date(project.createdAt)
    .toISOString()
    .slice(0, 10)}.pdf`;
  doc.save(filename);
}

// Countdown toward the 7-day deadline, amber in the last two days.
function DeadlineBadge({ project, className = '' }: { project: Project; className?: string }) {
  const daysLeft = projectDaysLeft(project);
  const tone =
    daysLeft <= 1
      ? 'bg-rose-50 text-rose-700 border-rose-200'
      : daysLeft <= 2
      ? 'bg-amber-50 text-amber-700 border-amber-200'
      : 'bg-slate-100 text-slate-500 border-slate-200';

  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-semibold whitespace-nowrap ${tone} ${className}`}
      title="โปรเจกต์จะถูกปิดและสรุปยอดอัตโนมัติเมื่อครบ 7 วัน"
    >
      <AlarmClock className="w-3 h-3" />
      <span>เหลือ {daysLeft} วัน</span>
    </span>
  );
}

// ── Landing screen: pick a project to work on, or start a new one ───────────
export function ProjectPicker({
  activeProjects,
  canCreateProject,
  onSelect,
  onCreate,
  onOpenHistory
}: {
  activeProjects: Project[];
  canCreateProject: boolean;
  onSelect: (id: string) => void;
  onCreate: (name: string) => void;
  onOpenHistory: () => void;
}) {
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(activeProjects.length === 0);

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-slate-100 p-6 font-sans">
      <div className="w-full max-w-md bg-white border border-slate-200 rounded-2xl shadow-xs p-6 space-y-5">
        <div className="text-center space-y-1">
          <div className="w-12 h-12 rounded-xl bg-[#DE5C8E] flex items-center justify-center text-white mx-auto mb-3">
            <Layers className="w-6 h-6" />
          </div>
          <h1 className="font-bold text-slate-900">เลือกโปรเจกต์</h1>
          <p className="text-xs text-slate-500">
            เปิดโปรเจกต์ที่ยังไม่จบได้สูงสุด {MAX_ACTIVE_PROJECTS} โปรเจกต์ · แต่ละโปรเจกต์ต้องจบภายใน 7 วัน
          </p>
        </div>

        {/* Active projects */}
        {activeProjects.length > 0 && (
          <div className="space-y-2">
            {activeProjects.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => onSelect(p.id)}
                className="w-full p-3 bg-slate-50 hover:bg-pink-50 border border-slate-200 hover:border-pink-200 rounded-xl flex items-center justify-between gap-3 text-left transition-all group"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="font-semibold text-xs text-slate-800 truncate">{p.name}</div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] text-slate-400">
                      {p.sessions.length} session{p.sessions.length === 1 ? '' : 's'}
                    </span>
                    <DeadlineBadge project={p} />
                  </div>
                </div>
                <ArrowRight className="w-4 h-4 text-slate-300 group-hover:text-[#DE5C8E] shrink-0 transition-colors" />
              </button>
            ))}
          </div>
        )}

        {/* Create a new project */}
        {creating ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim() && canCreateProject) {
                onCreate(name.trim());
                setName('');
              }
            }}
            className="space-y-2.5 pt-1"
          >
            <input
              type="text"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="เช่น การประชุมประจำปี 2026"
              className="w-full p-3 text-sm bg-slate-50 border border-slate-200 rounded-lg outline-none focus:bg-white focus:border-[#DE5C8E]"
            />
            <div className="flex gap-2">
              {activeProjects.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setCreating(false);
                    setName('');
                  }}
                  className="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-sm font-semibold transition-all"
                >
                  ยกเลิก
                </button>
              )}
              <button
                type="submit"
                disabled={!name.trim()}
                className="flex-1 py-2.5 bg-[#DE5C8E] hover:bg-[#c94577] text-white rounded-lg text-sm font-bold transition-all disabled:opacity-40 flex items-center justify-center gap-2"
              >
                <FolderPlus className="w-4 h-4" />
                <span>สร้างโปรเจกต์</span>
              </button>
            </div>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => canCreateProject && setCreating(true)}
            disabled={!canCreateProject}
            className="w-full py-2.5 bg-[#DE5C8E] hover:bg-[#c94577] text-white rounded-lg text-sm font-bold transition-all disabled:opacity-40 flex items-center justify-center gap-2"
            title={canCreateProject ? undefined : 'ครบจำนวนโปรเจกต์ที่เปิดพร้อมกันได้แล้ว'}
          >
            <FolderPlus className="w-4 h-4" />
            <span>สร้างโปรเจกต์ใหม่</span>
          </button>
        )}

        <div className="flex items-center justify-between text-[11px] text-slate-400 pt-1 border-t border-slate-100">
          <span className={canCreateProject ? '' : 'text-rose-500 font-semibold'}>
            {canCreateProject
              ? `เปิดอยู่ ${activeProjects.length}/${MAX_ACTIVE_PROJECTS} โปรเจกต์`
              : `ครบ ${MAX_ACTIVE_PROJECTS} โปรเจกต์แล้ว — จบโปรเจกต์เดิมก่อนจึงจะสร้างใหม่ได้`}
          </span>
          <button
            type="button"
            onClick={onOpenHistory}
            className="flex items-center gap-1 text-slate-400 hover:text-[#DE5C8E] font-semibold transition-colors shrink-0 ml-2"
          >
            <History className="w-3.5 h-3.5" />
            <span>ประวัติ</span>
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Project + session status bar (shown in the header while a project is open) ──
export function ProjectHeaderBar({
  project,
  activeSession,
  onRequestFinish,
  onSwitchProject,
  onOpenHistory
}: {
  project: Project;
  activeSession?: ProjectSession;
  onRequestFinish: () => void;
  onSwitchProject: () => void;
  onOpenHistory: () => void;
}) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    setArmed(false);
  }, [project.id]);

  const handleFinishClick = () => {
    if (!armed) {
      setArmed(true);
      setTimeout(() => setArmed(false), 4000);
      return;
    }
    setArmed(false);
    onRequestFinish();
  };

  return (
    <div className="flex items-center gap-2 bg-slate-100 pl-3 pr-1.5 py-1 rounded-full border border-slate-200">
      <Layers className="w-3.5 h-3.5 text-[#DE5C8E] shrink-0" />
      <span className="text-xs font-bold text-slate-800 truncate max-w-32" title={project.name}>
        {project.name}
      </span>
      <span className="text-[11px] text-slate-400 font-mono shrink-0">
        {project.sessions.length} session{project.sessions.length === 1 ? '' : 's'}
      </span>
      <DeadlineBadge project={project} />
      <button
        type="button"
        onClick={onSwitchProject}
        disabled={Boolean(activeSession)}
        className="p-1 text-slate-400 hover:text-slate-700 rounded-full hover:bg-white transition-all disabled:opacity-30 disabled:hover:bg-transparent"
        title={activeSession ? 'จบ Session ก่อนจึงจะสลับโปรเจกต์ได้' : 'สลับโปรเจกต์'}
      >
        <Repeat className="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        onClick={onOpenHistory}
        className="p-1 text-slate-400 hover:text-slate-700 rounded-full hover:bg-white transition-all"
        title="ประวัติโปรเจกต์"
      >
        <History className="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        onClick={handleFinishClick}
        className={`px-2.5 py-1 rounded-full text-[11px] font-bold flex items-center gap-1 transition-all whitespace-nowrap ${
          armed
            ? 'bg-rose-600 hover:bg-rose-700 text-white'
            : 'bg-white hover:bg-rose-50 text-rose-600 border border-rose-200'
        }`}
        title={activeSession ? 'สิ้นสุด Session ปัจจุบันโดยอัตโนมัติแล้วปิดโปรเจกต์' : 'ปิดโปรเจกต์และสรุปยอด'}
      >
        <FlagTriangleRight className="w-3.5 h-3.5" />
        <span>{armed ? 'ยืนยันจบโปรเจกต์' : 'จบโปรเจกต์'}</span>
      </button>
    </div>
  );
}

// ── Running cost of the open project, shown in the header ──────────────────
//    The same arithmetic the closing bill uses, applied to what has been
//    recorded so far — so an operator can watch the number they will be
//    charged instead of finding it out at "จบโปรเจกต์".
export function LiveCostBadge({
  cost,
  isRecording = false,
  className = ''
}: {
  cost: LiveProjectCost;
  isRecording?: boolean;
  className?: string;
}) {
  // "≤" rather than "~": the figure is built to sit at or above the real
  // Gemini bill, and saying so is the whole point of showing it mid-meeting.
  return (
    <span
      className={`inline-flex items-center gap-1.5 pl-2 pr-2.5 py-1 rounded-full border text-[11px] font-bold whitespace-nowrap shrink-0 transition-colors ${
        isRecording
          ? 'bg-pink-50 border-pink-200 text-[#DE5C8E]'
          : 'bg-slate-100 border-slate-200 text-slate-600'
      } ${className}`}
      title={[
        'ประมาณการค่าใช้จ่าย Gemini ของโปรเจกต์นี้ — คิดแบบเผื่อไว้ ค่าจริงจะไม่เกินตัวเลขนี้',
        `เสียง ${cost.liveMinutes.toFixed(1)} นาที: ฿${usdToThb(cost.liveAudioCost)}`,
        `ข้อความคำแปล: ฿${usdToThb(cost.liveTextCost)}`,
        `สรุปการประชุม ${cost.summaryRuns} ครั้ง: ฿${usdToThb(cost.summaryCost)}`,
        isRecording ? 'อัปเดตทุก ๆ ไม่กี่วินาทีระหว่างบันทึก' : ''
      ]
        .filter(Boolean)
        .join('\n')}
      aria-label={`ค่าใช้จ่ายประมาณการ ไม่เกิน ${usdToThb(cost.displayCost)} บาท`}
    >
      {isRecording ? (
        <span className="relative flex h-2 w-2 shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#DE5C8E] opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-[#DE5C8E]" />
        </span>
      ) : (
        <span>Estimated cost</span>
      )}
      <span>: ฿{usdToThb(cost.displayCost)}</span>
    </span>
  );
}

// ── Bill summary modal, shown right after a project is finished ─────────────
export function BillModal({ project, onClose }: { project: Project; onClose: () => void }) {
  if (!project.bill) return null;
  const { bill } = project;

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-lg p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-bold text-slate-900 text-sm">สรุปยอดโปรเจกต์: {project.name}</h2>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-600 rounded-md hover:bg-slate-100">
            <X className="w-4 h-4" />
          </button>
        </div>

        {project.autoFinished && (
          <div className="p-2.5 bg-amber-50 border border-amber-200 rounded-lg text-[11px] text-amber-800">
            โปรเจกต์นี้ถูกปิดอัตโนมัติเนื่องจากครบกำหนด 7 วัน
          </div>
        )}

        <div className="grid grid-cols-2 gap-2.5 text-xs">
          <div className="p-3 bg-slate-50 rounded-lg border border-slate-200">
            <div className="text-slate-400">Sessions</div>
            <div className="font-bold text-slate-900 text-base">{bill.sessionCount}</div>
          </div>
          <div className="p-3 bg-slate-50 rounded-lg border border-slate-200">
            <div className="text-slate-400 flex items-center gap-1">
              <Clock className="w-3 h-3" /> Duration
            </div>
            <div className="font-bold text-slate-900 text-base">{formatDuration(bill.durationMs)}</div>
          </div>
          <div className="p-3 bg-slate-50 rounded-lg border border-slate-200">
            <div className="text-slate-400">Words translated</div>
            <div className="font-bold text-slate-900 text-base">{bill.wordCount}</div>
          </div>
          <div className="p-3 bg-pink-50 rounded-lg border border-pink-200">
            <div className="text-[#DE5C8E]">Estimated cost</div>
            <div className="font-bold text-[#DE5C8E] text-base">≤ ฿{usdToThb(bill.estimatedCost)}</div>
          </div>
        </div>

        {bill.costBreakdown && (
          <div className="space-y-1 text-[11px] text-slate-500">
            <div className="flex justify-between gap-2">
              <span>เสียง Live ({bill.costBreakdown.liveMinutes.toFixed(1)} นาที)</span>
              <span className="font-mono">฿{usdToThb(bill.costBreakdown.liveAudioCost)}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span>ข้อความคำแปล</span>
              <span className="font-mono">฿{usdToThb(bill.costBreakdown.liveTextCost)}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span>สรุปการประชุม ({bill.costBreakdown.summaryRuns} ครั้ง)</span>
              <span className="font-mono">฿{usdToThb(bill.costBreakdown.summaryCost)}</span>
            </div>
            <div className="flex justify-between gap-2 pt-1 border-t border-slate-100">
              <span>ค่าบริการ (Service fee)</span>
              <span className="font-mono">฿{usdToThb(bill.serviceFee ?? 0)}</span>
            </div>
          </div>
        )}

        <p className="text-[11px] text-slate-400">
          ประมาณการจากอัตราค่าบริการ Gemini API แบบเผื่อไว้ (คิดเสียงเต็มช่วงเวลาที่บันทึก) — ค่าใช้จ่ายจริงจะไม่เกินยอดนี้
          และยังไม่ใช่ระบบเรียกเก็บเงิน (แปลงเป็นบาทโดยประมาณที่ 1 USD ≈ {USD_TO_THB_RATE} THB)
        </p>

        <div className="flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-semibold"
          >
            ปิด
          </button>
          <button
            onClick={() => void downloadBill(project)}
            className="flex-1 py-2 bg-[#DE5C8E] hover:bg-[#c94577] text-white rounded-lg text-xs font-bold flex items-center justify-center gap-1.5"
          >
            <Download className="w-3.5 h-3.5" />
            <span>ดาวน์โหลดบิล</span>
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Slide-over listing past (ended) projects, each re-downloadable ──────────
export function HistoryPanel({ projects, onClose }: { projects: Project[]; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div onClick={onClose} className="absolute inset-0 bg-black/30" />
      <div className="relative w-full max-w-sm bg-white h-full shadow-2xl flex flex-col font-sans">
        <div className="p-4 border-b border-slate-200 flex items-center justify-between shrink-0">
          <h2 className="font-bold text-slate-900 text-sm flex items-center gap-2">
            <History className="w-4 h-4 text-[#DE5C8E]" />
            <span>ประวัติโปรเจกต์</span>
          </h2>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-600 rounded-md hover:bg-slate-100">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-2.5">
          {projects.length === 0 ? (
            <div className="text-center text-slate-400 text-xs py-8">ยังไม่มีโปรเจกต์ที่จบแล้ว</div>
          ) : (
            projects.map((p) => (
              <div key={p.id} className="p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-xs text-slate-800 truncate">{p.name}</span>
                  {p.bill && (
                    <button
                      onClick={() => void downloadBill(p)}
                      className="p-1.5 text-slate-400 hover:text-[#DE5C8E] rounded-lg hover:bg-white transition-all shrink-0"
                      title="ดาวน์โหลดบิล"
                    >
                      <Download className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
                <div className="text-[11px] text-slate-400 flex items-center gap-1.5 flex-wrap">
                  <span>
                    {new Date(p.createdAt).toLocaleDateString()} · {p.bill?.sessionCount ?? p.sessions.length} sessions
                    {p.bill && <> · ฿{usdToThb(p.bill.estimatedCost)}</>}
                  </span>
                  {p.autoFinished && (
                    <span className="px-1.5 py-0.5 rounded-md bg-amber-50 text-amber-700 border border-amber-200 font-semibold">
                      หมดอายุอัตโนมัติ
                    </span>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/** Sessions newest first — the one just finished is what an operator looks
 *  for. Exported so the summary popup can label a session the same way the
 *  list does ("Session #3"). */
export function orderedSessions(project: Project): ProjectSession[] {
  return [...project.sessions].sort((a, b) => b.startedAt - a.startedAt);
}

export function sessionNumber(project: Project, session: ProjectSession): number {
  const sessions = orderedSessions(project);
  return sessions.length - sessions.findIndex((s) => s.id === session.id);
}

// ── Slide-over listing every ASR session recorded under one project ────────
//    Summarising is on demand: nothing is sent to the AI when a session ends,
//    the operator asks for it here, whenever they want it. No P2 database
//    exists yet — this reads straight off the same localStorage record
//    everything else in `Project` already lives in.
export function SessionHistoryModal({
  project,
  summarizingIds,
  onSummarize,
  onViewSummary,
  onClose
}: {
  project: Project;
  // ASR session ids whose summary is being generated right now
  // (see useProjects.markSessionSummarizing).
  summarizingIds: Set<string>;
  onSummarize: (session: ProjectSession) => void;
  onViewSummary: (session: ProjectSession) => void;
  onClose: () => void;
}) {
  const sessions = orderedSessions(project);

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div onClick={onClose} className="absolute inset-0 bg-black/30" />
      <div className="relative w-full max-w-md bg-white h-full shadow-2xl flex flex-col font-sans">
        <div className="p-4 border-b border-slate-200 flex items-center justify-between shrink-0">
          <h2 className="font-bold text-slate-900 text-sm flex items-center gap-2">
            <ClipboardList className="w-4 h-4 text-[#DE5C8E]" />
            <span>Session ในโปรเจกต์นี้</span>
          </h2>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-600 rounded-md hover:bg-slate-100">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-2.5">
          {sessions.length === 0 ? (
            <div className="text-center text-slate-400 text-xs py-8">ยังไม่มี session ในโปรเจกต์นี้</div>
          ) : (
            sessions.map((s, index) => {
              const isLive = !s.endedAt;
              const duration = s.endedAt ? formatDuration(s.endedAt - s.startedAt) : null;
              const isSummarizing = summarizingIds.has(s.asrSessionId);
              const hasSummary = Boolean(s.summary);
              // `summary === undefined` means nobody has asked for a summary;
              // `summary === ""` means the AI call itself failed.
              const summaryAttempted = s.summary !== undefined;
              // From the denormalised column, not the captions: the history
              // list holds counts only, so a project with fifty meetings
              // still opens in one query.
              const itemCount = s.itemCount;

              return (
                <div key={s.id} className="border border-slate-200 rounded-xl p-3 bg-slate-50 space-y-2">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="font-semibold text-xs text-slate-800">Session #{sessions.length - index}</span>
                    {isLive && (
                      <span className="px-1.5 py-0.5 rounded-md bg-emerald-50 text-emerald-700 border border-emerald-200 text-[10px] font-bold">
                        กำลังดำเนินการ
                      </span>
                    )}
                    {isSummarizing ? (
                      <span className="px-1.5 py-0.5 rounded-md text-[10px] font-semibold border bg-pink-50 text-[#DE5C8E] border-pink-200">
                        กำลังสรุป…
                      </span>
                    ) : (
                      summaryAttempted && (
                        <span
                          className={`px-1.5 py-0.5 rounded-md text-[10px] font-semibold border ${
                            hasSummary
                              ? 'bg-slate-100 text-slate-600 border-slate-200'
                              : 'bg-amber-50 text-amber-700 border-amber-200'
                          }`}
                        >
                          {hasSummary ? 'มีสรุปแล้ว' : 'สรุป AI ไม่สำเร็จ'}
                        </span>
                      )
                    )}
                  </div>

                  <div className="text-[11px] text-slate-400">
                    {new Date(s.startedAt).toLocaleString()}
                    {duration && <> · {duration}</>} · {s.sourceLang} → {s.targetLang}
                    {itemCount > 0 && <> · {itemCount} ข้อความ</>}
                  </div>

                  <div className="flex items-center gap-2">
                    {summaryAttempted && !isSummarizing && (
                      <button
                        type="button"
                        onClick={() => onViewSummary(s)}
                        className="px-2.5 py-1.5 text-[11px] font-bold rounded-lg bg-white hover:bg-slate-100 text-slate-700 border border-slate-200 flex items-center gap-1.5 transition-all"
                      >
                        <ClipboardList className="w-3.5 h-3.5 text-slate-400" />
                        <span>ดูสรุป</span>
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => onSummarize(s)}
                      disabled={isSummarizing || isLive || itemCount === 0}
                      className="px-2.5 py-1.5 text-[11px] font-bold rounded-lg bg-[#DE5C8E] hover:bg-[#c94577] text-white flex items-center gap-1.5 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                      title={
                        isLive
                          ? 'จบ session นี้ก่อนจึงจะสรุปได้'
                          : itemCount === 0
                          ? 'session นี้ไม่มีข้อความให้สรุป'
                          : 'ส่งบทสนทนาของ session นี้ให้ AI สรุป'
                      }
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                      <span>{isSummarizing ? 'กำลังสรุป…' : summaryAttempted ? 'สรุปใหม่' : 'สรุปการประชุม'}</span>
                    </button>
                  </div>

                  {isLive && <p className="text-[11px] text-slate-400">จบ session นี้ก่อน จึงจะขอสรุปการประชุมได้</p>}
                  {!isLive && itemCount === 0 && (
                    <p className="text-[11px] text-slate-400">ไม่มีข้อความถูกบันทึกไว้ใน session นี้</p>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

// ── The meeting summary itself, as a popup ─────────────────────────────────
//    Reads its session out of the live project record, so a summary that
//    lands while this is open fills itself in.
export function SessionSummaryModal({
  project,
  session,
  isSummarizing,
  summarizingSince,
  onSummarize,
  onClose,
  onOpen
}: {
  project: Project;
  session: ProjectSession;
  isSummarizing: boolean;
  summarizingSince?: number | null;
  onSummarize: (session: ProjectSession) => void;
  onClose: () => void;
  /** Called once when the popup mounts, so the captions this session holds
   *  can be fetched — the history list carries counts only. */
  onOpen: (session: ProjectSession) => void;
}) {
  const hasSummary = Boolean(session.summary);
  const summaryAttempted = session.summary !== undefined;
  // reportItemCount is what was SENT to the summariser and can differ from
  // what the session holds now, so it only wins once a summary exists.
  const itemCount = session.summary !== undefined
    ? session.reportItemCount ?? session.itemCount
    : session.itemCount;

  useEffect(() => {
    onOpen(session);
    // Only on mount, and only for this session: re-running on every render
    // would refetch the transcript continuously.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  // A one-to-two minute wait with a static spinner reads as a hang. No
  // progress protocol exists — elapsed time is the honest thing to show.
  const [elapsedSec, setElapsedSec] = useState(0);
  useEffect(() => {
    if (!isSummarizing || !summarizingSince) return;
    const tick = () => setElapsedSec(Math.floor((Date.now() - summarizingSince) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [isSummarizing, summarizingSince]);

  const download = () => {
    if (!session.summary) return;
    const content = [
      `=== สรุปการประชุม: ${project.name} ===`,
      `Session: ${new Date(session.startedAt).toLocaleString()}`,
      `${session.sourceLang} -> ${session.targetLang} · ${itemCount} ข้อความ`,
      '',
      session.summary
    ].join('\n');
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `summary_${project.name.replace(/\s+/g, '_')}_${new Date(session.startedAt).toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-[60] flex items-center justify-center p-4 font-sans">
      <div className="w-full max-w-lg max-h-[85vh] bg-white rounded-2xl shadow-lg flex flex-col">
        <div className="p-4 border-b border-slate-200 flex items-start justify-between gap-3 shrink-0">
          <div className="min-w-0">
            <h2 className="font-bold text-slate-900 text-sm flex items-center gap-2">
              <ClipboardList className="w-4 h-4 text-[#DE5C8E] shrink-0" />
              <span className="truncate">สรุปการประชุม — Session #{sessionNumber(project, session)}</span>
            </h2>
            <p className="text-[11px] text-slate-400 mt-1">
              {project.name} · {new Date(session.startedAt).toLocaleString()}
              {itemCount > 0 && <> · {itemCount} ข้อความ</>}
            </p>
          </div>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-600 rounded-md hover:bg-slate-100 shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {isSummarizing ? (
            <p className="text-xs text-slate-500 flex items-center gap-2">
              <span className="relative flex h-2 w-2 shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#DE5C8E] opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-[#DE5C8E]" />
              </span>
              <span>
                กำลังสรุปผลการประชุมด้วย AI… ({elapsedSec} วินาที) — การประชุมยาวอาจใช้เวลาถึง 2-3 นาที
                หน้าต่างนี้จะแสดงผลเมื่อเสร็จ
              </span>
            </p>
          ) : !summaryAttempted ? (
            <p className="text-xs text-slate-400 leading-relaxed">
              ยังไม่ได้สรุป session นี้ — กด &quot;สรุปการประชุม&quot; ด้านล่างเพื่อให้ AI สรุปจาก {itemCount} ข้อความที่บันทึกไว้
            </p>
          ) : hasSummary ? (
            <p className="text-xs text-slate-700 whitespace-pre-wrap leading-relaxed">{session.summary}</p>
          ) : (
            <p className="text-xs text-amber-700 flex items-start gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>
                สรุปด้วย AI ไม่สำเร็จ — บทสนทนายังถูกเก็บไว้ครบ{itemCount > 0 && <> {itemCount} ข้อความ</>} กด
                &quot;สรุปใหม่&quot; เพื่อลองอีกครั้งได้
              </span>
            </p>
          )}
        </div>

        <div className="p-4 border-t border-slate-200 flex gap-2 shrink-0">
          <button
            onClick={onClose}
            className="flex-1 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-semibold"
          >
            ปิด
          </button>
          {hasSummary && !isSummarizing && (
            <button
              onClick={download}
              className="px-3 py-2 bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 rounded-lg text-xs font-semibold flex items-center gap-1.5"
            >
              <Download className="w-3.5 h-3.5 text-slate-400" />
              <span>ดาวน์โหลด</span>
            </button>
          )}
          <button
            onClick={() => onSummarize(session)}
            disabled={isSummarizing || !session.endedAt || itemCount === 0}
            className="px-3 py-2 bg-[#DE5C8E] hover:bg-[#c94577] text-white rounded-lg text-xs font-bold flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>{isSummarizing ? 'กำลังสรุป…' : summaryAttempted ? 'สรุปใหม่' : 'สรุปการประชุม'}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
