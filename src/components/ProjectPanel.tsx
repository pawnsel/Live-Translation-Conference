import React, { useEffect, useState } from 'react';
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
  AlarmClock
} from 'lucide-react';
import { Project, ProjectBill, ProjectSession } from '../types';
import { MAX_ACTIVE_PROJECTS, projectDaysLeft } from '../hooks/useProjects';

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function billFileContent(project: Project, bill: ProjectBill): string {
  const lines = [
    `=== Project Bill: ${project.name} ===`,
    `Created: ${new Date(project.createdAt).toLocaleString()}`,
    `Finished: ${project.endedAt ? new Date(project.endedAt).toLocaleString() : '-'}${
      project.autoFinished ? ' (auto-finished at the 7-day deadline)' : ''
    }`,
    '',
    `Sessions: ${bill.sessionCount}`,
    `Total duration: ${formatDuration(bill.durationMs)}`,
    `Words translated: ${bill.wordCount}`,
    `Estimated cost: $${bill.estimatedCost.toFixed(2)} (placeholder rate, not final billing)`,
    '',
    '--- Session breakdown ---'
  ];
  project.sessions.forEach((s, i) => {
    const duration = s.endedAt ? formatDuration(s.endedAt - s.startedAt) : '-';
    lines.push(`[${i + 1}] ${s.sourceLang} -> ${s.targetLang} · ${duration}`);
  });
  return lines.join('\n');
}

function downloadBill(project: Project) {
  if (!project.bill) return;
  const content = billFileContent(project, project.bill);
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `bill_${project.name.replace(/\s+/g, '_')}_${new Date(project.createdAt).toISOString().slice(0, 10)}.txt`;
  a.click();
  URL.revokeObjectURL(url);
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
            <div className="font-bold text-[#DE5C8E] text-base">${bill.estimatedCost.toFixed(2)}</div>
          </div>
        </div>
        <p className="text-[11px] text-slate-400">
          ยอดประมาณการจากอัตราชั่วคราว ยังไม่ใช่ระบบเรียกเก็บเงินจริง
        </p>

        <div className="flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-semibold"
          >
            ปิด
          </button>
          <button
            onClick={() => downloadBill(project)}
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
                      onClick={() => downloadBill(p)}
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
                    {p.bill && <> · ${p.bill.estimatedCost.toFixed(2)}</>}
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
