import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  Mic,
  MicOff,
  Languages,
  BookOpen,
  Copy,
  Check,
  Download,
  Trash2,
  Sparkles,
  Zap,
  Activity,
  Edit2,
  Menu,
  ShieldAlert,
  FileText,
  ArrowLeftRight,
  Pause,
  Play,
  ClipboardList,
  RefreshCw,
  AlertTriangle,
  ChevronDown,
  ChevronUp
} from 'lucide-react';
// ProjectPanel.tsx has NO default export — it exports five named components.
import { BillModal, HistoryPanel, ProjectHeaderBar, ProjectPicker, SessionHistoryModal } from '../components/ProjectPanel';
import DictionaryManager from '../components/DictionaryManager';
import { captionsReducer, initialCaptionState, selectCaptions, type Caption } from '../asr/captions';
import { useGeminiLiveCapture, type CaptionResult } from '../asr/audio/useGeminiLiveCapture';
import { useProjects } from '../hooks/useProjects';
import { loadGlossary, saveGlossary, type GlossarySection, type GlossarySections } from '../glossary';
import type { DisplayConfig, Project } from '../types';

const PING_INTERVAL_MS = 3000;
// Bounded wait for the end-of-session summary before giving up and showing
// the "AI summary failed" fallback — keeps ending a session from hanging on
// a stuck Gemini call.
const REPORT_WAIT_TIMEOUT_MS = 20000;

// Only the pair this console supports. Anything else is not a language
// Gemini is instructed to expect.
const LANGS: Record<'th' | 'en', string> = { th: 'ไทย (Thai)', en: 'อังกฤษ (English)' };
const other = (lang: string) => (lang === 'th' ? 'en' : 'th');

interface ReportResult {
  summary: string;
  items: number;
  /** Gemini is still working on it — the session has already ended. */
  pending?: boolean;
}

function formatSrtTime(ms: number): string {
  const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const m = String(Math.floor(ms / 60000) % 60).padStart(2, '0');
  const s = String(Math.floor(ms / 1000) % 60).padStart(2, '0');
  const msPart = String(Math.floor(ms % 1000)).padStart(3, '0');
  return `${h}:${m}:${s},${msPart}`;
}

function textSizeClass(size: DisplayConfig['fontSize']): string {
  switch (size) {
    case 'small':
      return 'text-sm sm:text-base';
    case 'medium':
      return 'text-base sm:text-lg';
    case 'xlarge':
      return 'text-xl sm:text-2xl';
    case 'large':
    default:
      return 'text-lg sm:text-xl';
  }
}

// The live subtitle box is the thing an operator will OBS-crop for
// streaming, so it reads a size tier larger than the history list.
function boxTextSizeClass(size: DisplayConfig['fontSize']): string {
  switch (size) {
    case 'small':
      return 'text-2xl sm:text-3xl';
    case 'medium':
      return 'text-3xl sm:text-4xl';
    case 'xlarge':
      return 'text-5xl sm:text-6xl';
    case 'large':
    default:
      return 'text-4xl sm:text-5xl';
  }
}

export default function Admin() {
  const projects = useProjects();

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [micActive, setMicActive] = useState(false);
  const [sourceLang, setSourceLangState] = useState<'th' | 'en'>('th');
  const [targetLang, setTargetLangState] = useState<'th' | 'en'>('en');
  const [paused, setPaused] = useState(false);
  const [glossary, setGlossary] = useState<GlossarySections>(() => loadGlossary());
  const [report, setReport] = useState<ReportResult | null>(null);
  const reportOwnerRef = useRef<string | null>(null);
  const [pingMs, setPingMs] = useState<number | null>(null);

  const [config, setConfig] = useState<DisplayConfig>({ fontSize: 'large', showOriginal: false, showLatency: false });
  const [activeTab, setActiveTab] = useState<'languages' | 'dictionary'>('languages');
  const [mobileSettingsOpen, setMobileSettingsOpen] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showSessionHistory, setShowSessionHistory] = useState(false);
  const [showAllHistory, setShowAllHistory] = useState(false);
  const [finishedProject, setFinishedProject] = useState<Project | null>(null);

  // Captions have no "delete" concept anymore (there is no server to delete
  // them from) — "delete" stays a local-only hide so an operator can tidy
  // the visible history. Hiding removes a caption from the on-screen view
  // and from TXT/SRT export, but it is still included in the AI summary and
  // the permanent project record.
  const [hiddenSeqs, setHiddenSeqs] = useState<Set<number>>(new Set());
  const [editingSeq, setEditingSeq] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [copiedSeq, setCopiedSeq] = useState<number | null>(null);

  const [captionState, dispatchCaption] = useReducer(captionsReducer, initialCaptionState);
  const allCaptions = useMemo(() => selectCaptions(captionState), [captionState]);
  const captions = useMemo(() => allCaptions.filter((c) => !hiddenSeqs.has(c.seq)), [allCaptions, hiddenSeqs]);

  const transcriptScrollRef = useRef<HTMLDivElement>(null);

  // ── Gemini capture result → captions ─────────────────────────────────────
  const handleCaptureResult = useCallback((result: CaptionResult) => {
    dispatchCaption({
      kind: 'add',
      seq: result.seq,
      sourceText: result.sourceText,
      targetText: result.targetText,
      sourceLang: result.sourceLang,
      targetLang: result.targetLang,
      latencyMs: result.latencyMs
    });
  }, []);

  const capture = useGeminiLiveCapture({
    active: micActive,
    paused,
    sourceLang,
    targetLang,
    glossary,
    onResult: handleCaptureResult
  });

  // ── "Ping" — round-trip time of our own server's /api/health, not a
  //    control-socket heartbeat (there is no persistent socket anymore) ─────
  useEffect(() => {
    if (!sessionId || !micActive) {
      setPingMs(null);
      return;
    }
    let cancelled = false;
    const probe = async () => {
      const startedAt = Date.now();
      try {
        const res = await fetch('/api/health', { signal: AbortSignal.timeout(4000) });
        if (!res.ok) throw new Error('unhealthy');
        if (!cancelled) setPingMs(Date.now() - startedAt);
      } catch {
        if (!cancelled) setPingMs(null);
      }
    };
    // Fire one probe immediately — otherwise Ping reads "--" for the first
    // PING_INTERVAL_MS of every session, since setInterval's first callback
    // doesn't fire until the interval has already elapsed once.
    void probe();
    const timer = setInterval(probe, PING_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sessionId, micActive]);

  // ── Session + mic as one combined "Session" toggle, matching the original
  //    single Start/Stop button ─────────────────────────────────────────────
  const [endingSession, setEndingSession] = useState(false);

  const startSessionAndMic = () => {
    if (micActive) return;
    const id = `local_${Date.now()}`;
    setSessionId(id);
    dispatchCaption({ kind: 'reset' });
    setHiddenSeqs(new Set());
    setReport(null);
    // The previous session's summary may still be in flight; it no longer
    // owns this panel.
    reportOwnerRef.current = null;
    projects.attachAsrSession(id, sourceLang, targetLang);
    setMicActive(true);
  };

  // Ending the session flushes whatever audio is still buffered (so the last
  // few words of a sentence aren't lost), then hands the transcript to Gemini
  // for a summary — in the background. The operator gets the console back
  // immediately; the summary lands in the report panel and the session
  // history when it is ready.
  const summarizeInBackground = async (asrSessionId: string, items: { source_text: string; target_text: string }[]) => {
    // The panel belongs to whichever session ended most recently. A summary
    // that resolves after the operator has already started the next session
    // must still be SAVED, but must not pop up over the new session's panel.
    const showIfStillOwner = (result: ReportResult) => {
      if (reportOwnerRef.current === asrSessionId) setReport(result);
    };
    try {
      const res = await fetch('/api/gemini/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
        signal: AbortSignal.timeout(REPORT_WAIT_TIMEOUT_MS)
      });
      const data = (await res.json()) as { summary?: string; items?: number };
      const summary = data.summary ?? '';
      const itemCount = data.items ?? items.length;
      showIfStillOwner({ summary, items: itemCount });
      projects.saveSessionSummary(asrSessionId, summary, itemCount);
    } catch {
      // An AI failure never loses the transcript, it just ships without a
      // summary.
      showIfStillOwner({ summary: '', items: items.length });
      projects.saveSessionSummary(asrSessionId, '', items.length);
    }
  };

  const stopSessionAndMic = async (): Promise<CaptionResult | null> => {
    // Disable the "End Session" button immediately, before the await below —
    // otherwise a second click fires a duplicate flush and summarize.
    setEndingSession(true);
    const flushed = await capture.flush();
    setMicActive(false);
    if (sessionId) {
      const items = allCaptions.map((c) => ({ source_text: c.sourceText, target_text: c.targetText }));
      if (flushed) items.push({ source_text: flushed.sourceText, target_text: flushed.targetText });
      reportOwnerRef.current = sessionId;
      setReport({ summary: '', items: items.length, pending: true });
      projects.markSessionSummarizing(sessionId);
      // Deliberately not awaited — this is what keeps ending a session
      // instant instead of blocking on a call that can take 20 seconds.
      void summarizeInBackground(sessionId, items);
    }
    setEndingSession(false);
    setSessionId(null);
    setPaused(false);
    projects.detachAsrSession();
    return flushed;
  };

  const isSessionActive = !!sessionId && micActive;

  const handleRequestFinishProject = async () => {
    const flushed = await stopSessionAndMic();
    const captionsForProject = flushed
      ? [
          ...allCaptions,
          {
            seq: flushed.seq,
            sourceText: flushed.sourceText,
            targetText: flushed.targetText,
            sourceLang: flushed.sourceLang,
            targetLang: flushed.targetLang,
            ts: Date.now() / 1000,
            latencyMs: flushed.latencyMs,
            isEdited: false
          }
        ]
      : allCaptions;
    const finished = projects.finishProject(captionsForProject);
    dispatchCaption({ kind: 'reset' });
    setHiddenSeqs(new Set());
    if (finished) setFinishedProject(finished);
  };

  const handleSwitchProject = () => {
    if (projects.activeSession) return; // one microphone, one live buffer
    projects.clearSelection();
  };

  // ── Language swap ────────────────────────────────────────────────────────
  const setLanguage = (source: 'th' | 'en') => {
    setSourceLangState(source);
    setTargetLangState(other(source) as 'th' | 'en');
  };

  const handleSwapLanguages = () => setLanguage(targetLang);

  // ── Glossary ──────────────────────────────────────────────────────────────
  const persistGlossary = (next: GlossarySections) => {
    setGlossary(next);
    saveGlossary(next);
  };

  const handleGlossaryAdd = (section: GlossarySection, term: string, equivalent: string) => {
    persistGlossary({ ...glossary, [section]: { ...glossary[section], [term]: equivalent } });
  };

  const handleGlossaryRemove = (section: GlossarySection, term: string) => {
    const next = { ...glossary[section] };
    delete next[term];
    persistGlossary({ ...glossary, [section]: next });
  };

  // ── Caption item actions ─────────────────────────────────────────────────
  const handleCopyItem = (item: Caption) => {
    navigator.clipboard.writeText(`${item.sourceText}\n${item.targetText}`);
    setCopiedSeq(item.seq);
    setTimeout(() => setCopiedSeq(null), 1500);
  };

  const startEditing = (item: Caption) => {
    setEditingSeq(item.seq);
    setEditDraft(item.targetText);
  };

  const saveEdit = () => {
    if (editingSeq === null) return;
    dispatchCaption({ kind: 'edit', seq: editingSeq, targetText: editDraft.trim() });
    setEditingSeq(null);
  };

  const hideItem = (seq: number) => {
    setHiddenSeqs((prev) => new Set(prev).add(seq));
  };

  const clearTranscripts = () => {
    if (window.confirm('ล้างประวัติการแปลทั้งหมด?')) {
      dispatchCaption({ kind: 'reset' });
      setHiddenSeqs(new Set());
    }
  };

  // Auto-scroll the feed as new captions arrive, unless the operator is
  // actively editing one (a scroll jump under an open editor is disorienting).
  useEffect(() => {
    if (editingSeq !== null) return;
    const el = transcriptScrollRef.current;
    if (!el) return;
    const id = setTimeout(() => el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }), 80);
    return () => clearTimeout(id);
  }, [captions.length, editingSeq]);

  // ── Export ───────────────────────────────────────────────────────────────
  const exportTranscript = (type: 'txt' | 'srt') => {
    if (captions.length === 0) return;
    const dateStr = new Date().toISOString().slice(0, 10);
    let content = '';

    if (type === 'txt') {
      content = `=== Live Translation Transcript (${dateStr}) ===\n${sourceLang} -> ${targetLang}\n\n`;
      content += captions
        .map(
          (c, i) =>
            `[${i + 1}] ${new Date(c.ts * 1000).toLocaleTimeString()}${c.isEdited ? ' (edited)' : ''} [${c.latencyMs || '-'}ms]\nOriginal: ${c.sourceText}\nTranslated: ${c.targetText}\n`
        )
        .join('\n');
    } else {
      const startBase = captions[0].ts * 1000;
      content = captions
        .map((c, idx) => {
          const startTime = Math.max(0, c.ts * 1000 - startBase);
          const endTime = startTime + 3500;
          return `${idx + 1}\n${formatSrtTime(startTime)} --> ${formatSrtTime(endTime)}\n${c.targetText}\n`;
        })
        .join('\n');
    }

    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `transcript_${dateStr}.${type}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const isListening = capture.status === 'listening';
  const micPermissionError = capture.status === 'error';

  // The live subtitle box always shows ONE caption at a time — the latest —
  // like a YouTube subtitle, so an operator can crop just this box in OBS
  // for streaming.
  const latestCaption = captions.length > 0 ? captions[captions.length - 1] : null;
  // While a sentence is still being spoken the model is already streaming
  // its translation, so the box shows that in-progress text (faded) and
  // swaps to the committed caption once the sentence closes.
  const hasPartial = !!(capture.partialSource || capture.partialTarget);
  const boxSourceText = capture.partialSource || latestCaption?.sourceText || '';
  const boxTargetText = capture.partialTarget || latestCaption?.targetText || '';
  const isEditingBox = editingSeq !== null && editingSeq === latestCaption?.seq;

  // ── No project selected: the picker is the whole screen, as it always was ──
  if (!projects.currentProject) {
    return (
      <>
        <ProjectPicker
          activeProjects={projects.activeProjects}
          canCreateProject={projects.canCreateProject}
          onSelect={projects.selectProject}
          onCreate={projects.createProject}
          onOpenHistory={() => setShowHistory(true)}
        />
        {showHistory && <HistoryPanel projects={projects.endedProjects} onClose={() => setShowHistory(false)} />}
        {finishedProject && <BillModal project={finishedProject} onClose={() => setFinishedProject(null)} />}
      </>
    );
  }

  return (
    <div className="flex flex-col h-screen w-full bg-slate-100 text-slate-800 font-sans overflow-hidden">
      {showHistory && <HistoryPanel projects={projects.endedProjects} onClose={() => setShowHistory(false)} />}
      {finishedProject && <BillModal project={finishedProject} onClose={() => setFinishedProject(null)} />}
      {showSessionHistory && (
        <SessionHistoryModal
          project={projects.currentProject}
          summarizingIds={projects.summarizingIds}
          onClose={() => setShowSessionHistory(false)}
        />
      )}

      {/* ─────────────────────────────────────────────────────────────
          TOP CONTROL & METRICS BAR
      ────────────────────────────────────────────────────────────── */}
      <header className="h-15 bg-white border-b border-slate-200 px-3 sm:px-6 flex items-center justify-between shrink-0 z-30 shadow-xs">
        <div className="flex items-center gap-2.5">
          <button
            onClick={() => setMobileSettingsOpen(!mobileSettingsOpen)}
            className="lg:hidden p-2 text-slate-600 hover:bg-slate-100 rounded-lg"
            title="เปิดเมนูตั้งค่า"
          >
            <Menu className="w-5 h-5" />
          </button>

          <div className="flex items-center gap-2.5">
            <div className="w-8.5 h-8.5 rounded-lg bg-[#DE5C8E] flex items-center justify-center text-white shadow-xs">
              <Sparkles className="w-4.5 h-4.5" />
            </div>
            <div className="flex flex-col">
              <span className="font-bold text-sm text-slate-900 tracking-tight leading-none">AI Live Translator</span>
              <span className="text-[11px] text-slate-400 font-medium leading-tight mt-0.5">Powered by Google Gemini</span>
            </div>
          </div>

          <div className="hidden sm:flex items-center gap-1.5">
            <ProjectHeaderBar
              project={projects.currentProject}
              activeSession={projects.activeSession}
              onRequestFinish={handleRequestFinishProject}
              onSwitchProject={handleSwitchProject}
              onOpenHistory={() => setShowHistory(true)}
            />
            <button
              type="button"
              onClick={() => setShowSessionHistory(true)}
              className="p-1.5 text-slate-400 hover:text-[#DE5C8E] rounded-full hover:bg-slate-100 transition-all shrink-0"
              title="ดู session และสรุปการประชุมย้อนหลังในโปรเจกต์นี้"
            >
              <ClipboardList className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2 sm:gap-3">
          <div
            className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold transition-all ${
              isSessionActive
                ? 'bg-emerald-50 text-emerald-700 border border-emerald-300 ring-2 ring-emerald-100'
                : 'bg-slate-100 text-slate-500 border border-slate-200'
            }`}
          >
            {isSessionActive ? (
              <>
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                </span>
                <span className="tracking-wider text-[11px] font-bold uppercase whitespace-nowrap">
                  {paused ? 'พักการถอดความ' : 'กำลังแปลสด'}
                </span>
              </>
            ) : (
              <>
                <span className="w-2 h-2 rounded-full bg-slate-400" />
                <span className="text-[11px] whitespace-nowrap">พร้อมใช้งาน</span>
              </>
            )}
          </div>

          {/* Latency lives in the subtitle box (config.showLatency); only
              Ping is unique to this bar. */}
          <div className="hidden md:flex items-center gap-2 bg-slate-100 px-3 py-1.5 rounded-full text-[11px] font-mono border border-slate-200">
            <Activity className={`w-3.5 h-3.5 ${isSessionActive ? 'text-emerald-600' : 'text-slate-400'}`} />
            <span className="text-slate-500">Ping:</span>
            <span className="font-semibold text-slate-800">{pingMs !== null ? `${pingMs}ms` : '--'}</span>
          </div>

          {sessionId && (
            <button
              onClick={() => setPaused((p) => !p)}
              title={paused ? 'เล่นต่อ' : 'พักการถอดความ'}
              className="p-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600"
            >
              {paused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
            </button>
          )}

          <button
            onClick={isSessionActive ? stopSessionAndMic : startSessionAndMic}
            disabled={capture.status === 'starting' || endingSession}
            className={`px-4 py-2 rounded-lg text-xs font-bold flex items-center gap-2 transition-all shadow-xs whitespace-nowrap disabled:opacity-50 ${
              isSessionActive ? 'bg-rose-600 hover:bg-rose-700 text-white animate-pulse' : 'bg-[#DE5C8E] hover:bg-[#c94577] text-white'
            }`}
          >
            {isSessionActive ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
            <span>
              {capture.status === 'starting'
                ? 'กำลังเริ่ม…'
                : endingSession
                ? 'กำลังปิด Session…'
                : isSessionActive
                ? 'จบ Session'
                : 'เริ่ม Session'}
            </span>
          </button>
        </div>
      </header>

      <div className="sm:hidden px-3 py-2 bg-white border-b border-slate-200 shrink-0 overflow-x-auto flex items-center gap-1.5">
        <ProjectHeaderBar
          project={projects.currentProject}
          activeSession={projects.activeSession}
          onRequestFinish={handleRequestFinishProject}
          onSwitchProject={handleSwitchProject}
          onOpenHistory={() => setShowHistory(true)}
        />
        <button
          type="button"
          onClick={() => setShowSessionHistory(true)}
          className="p-1.5 text-slate-400 hover:text-[#DE5C8E] rounded-full hover:bg-slate-100 transition-all shrink-0"
          title="ดู session และสรุปการประชุมย้อนหลังในโปรเจกต์นี้"
        >
          <ClipboardList className="w-4 h-4" />
        </button>
      </div>

      {/* ─────────────────────────────────────────────────────────────
          MAIN WORKSPACE LAYOUT
      ────────────────────────────────────────────────────────────── */}
      <div className="flex-1 flex overflow-hidden relative">
        <aside
          className={`fixed inset-y-15 left-0 z-20 w-84 lg:w-96 bg-white border-r border-slate-200 flex flex-col transition-transform duration-200 lg:static lg:translate-x-0 ${
            mobileSettingsOpen ? 'translate-x-0 shadow-2xl' : '-translate-x-full'
          }`}
        >
          <div className="grid grid-cols-2 p-1.5 bg-slate-50 border-b border-slate-200 text-xs gap-1 shrink-0">
            <button
              onClick={() => setActiveTab('languages')}
              className={`py-2 px-1 rounded-lg font-semibold flex items-center justify-center gap-1.5 transition-all ${
                activeTab === 'languages' ? 'bg-white text-[#DE5C8E] shadow-xs' : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              <Languages className="w-4 h-4" />
              <span className="whitespace-nowrap">ภาษาและการตั้งค่า</span>
            </button>
            <button
              onClick={() => setActiveTab('dictionary')}
              className={`py-2 px-1 rounded-lg font-semibold flex items-center justify-center gap-1.5 transition-all ${
                activeTab === 'dictionary' ? 'bg-white text-[#DE5C8E] shadow-xs' : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              <BookOpen className="w-4 h-4" />
              <span className="whitespace-nowrap">พจนานุกรม</span>
            </button>
          </div>

          <div className="flex-1 p-4 overflow-y-auto space-y-4">
            {activeTab === 'languages' && (
              <div className="space-y-4">
                <div className="space-y-3 bg-slate-50 p-3.5 rounded-xl border border-slate-200">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-800">คู่ภาษาแปลสด (Thai ↔ English)</span>
                    <button
                      type="button"
                      onClick={handleSwapLanguages}
                      className="text-[11px] px-2.5 py-1 bg-white hover:bg-pink-50 text-[#DE5C8E] border border-pink-200 rounded-lg font-bold flex items-center gap-1 shadow-2xs transition-all"
                      title="สลับภาษาผู้พูดและภาษาแปล"
                    >
                      <ArrowLeftRight className="w-3.5 h-3.5" />
                      <span>สลับภาษา</span>
                    </button>
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">ภาษาของผู้พูด (Source Language)</label>
                    <select
                      value={sourceLang}
                      onChange={(e) => setLanguage(e.target.value as 'th' | 'en')}
                      className="w-full p-2.5 text-xs bg-white border border-slate-200 rounded-lg outline-none focus:border-[#DE5C8E] font-semibold text-slate-800"
                    >
                      <option value="th">{LANGS.th}</option>
                      <option value="en">{LANGS.en}</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">ภาษาที่แปลเป็น (Target — อัตโนมัติ)</label>
                    <select
                      value={targetLang}
                      onChange={(e) => setLanguage(other(e.target.value) as 'th' | 'en')}
                      className="w-full p-2.5 text-xs bg-white border border-slate-200 rounded-lg outline-none focus:border-[#DE5C8E] font-semibold text-[#DE5C8E]"
                    >
                      <option value="en">แปลเป็นอังกฤษ (English)</option>
                      <option value="th">แปลเป็นไทย (Thai)</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1.5">ขนาดตัวอักษรข้อความแปล (Font Size)</label>
                  <select
                    value={config.fontSize}
                    onChange={(e) => setConfig((c) => ({ ...c, fontSize: e.target.value as DisplayConfig['fontSize'] }))}
                    className="w-full p-2.5 text-xs bg-slate-50 border border-slate-200 rounded-lg outline-none focus:bg-white focus:border-[#DE5C8E] font-medium"
                  >
                    <option value="small">ขนาดเล็ก (Small)</option>
                    <option value="medium">ขนาดปานกลาง (Medium)</option>
                    <option value="large">ขนาดใหญ่ (Large - แนะนำ)</option>
                    <option value="xlarge">ขนาดใหญ่พิเศษ (Extra Large)</option>
                  </select>
                </div>

                <div className="pt-3 border-t border-slate-200 space-y-2.5">
                  <label className="flex items-center gap-2.5 cursor-pointer text-xs font-medium text-slate-700">
                    <input
                      type="checkbox"
                      checked={config.showOriginal !== false}
                      onChange={(e) => setConfig((c) => ({ ...c, showOriginal: e.target.checked }))}
                      className="rounded text-[#DE5C8E] focus:ring-[#DE5C8E] w-4 h-4"
                    />
                    <span>แสดงประโยคต้นฉบับคู่กับคำแปล</span>
                  </label>
                  <label className="flex items-center gap-2.5 cursor-pointer text-xs font-medium text-slate-700">
                    <input
                      type="checkbox"
                      checked={config.showLatency !== false}
                      onChange={(e) => setConfig((c) => ({ ...c, showLatency: e.target.checked }))}
                      className="rounded text-[#DE5C8E] focus:ring-[#DE5C8E] w-4 h-4"
                    />
                    <span>แสดงความเร็วการตอบสนอง (Latency ms)</span>
                  </label>
                </div>
              </div>
            )}

            {activeTab === 'dictionary' && (
              <DictionaryManager sections={glossary} disabled={false} onAdd={handleGlossaryAdd} onRemove={handleGlossaryRemove} />
            )}
          </div>

          <div className="p-3 border-t border-slate-200 lg:hidden">
            <button
              onClick={() => setMobileSettingsOpen(false)}
              className="w-full py-2 bg-slate-100 text-slate-700 text-xs font-semibold rounded-lg"
            >
              ปิดหน้าต่างตั้งค่า
            </button>
          </div>
        </aside>

        {mobileSettingsOpen && (
          <div onClick={() => setMobileSettingsOpen(false)} className="fixed inset-0 bg-black/30 z-10 lg:hidden" />
        )}

        {/* ─────────────────────────────────────────────────────────────
            MAIN TRANSLATION FEED
        ────────────────────────────────────────────────────────────── */}
        <main className="flex-1 flex flex-col bg-slate-50 min-w-0">
          <div className="px-4 py-2.5 bg-white border-b border-slate-200 flex items-center justify-between gap-3 shrink-0">
            <div className="flex items-center gap-2 ml-auto">
              <button
                onClick={() => exportTranscript('txt')}
                disabled={captions.length === 0}
                className="px-2.5 py-1.5 text-xs text-slate-700 hover:text-slate-900 bg-white hover:bg-slate-50 border border-slate-200 rounded-lg font-semibold transition-all disabled:opacity-40 flex items-center gap-1.5 shadow-2xs"
                title="ส่งออกข้อความ TXT"
              >
                <Download className="w-3.5 h-3.5 text-slate-500" />
                <span>TXT</span>
              </button>
              <button
                onClick={() => exportTranscript('srt')}
                disabled={captions.length === 0}
                className="px-2.5 py-1.5 text-xs text-slate-700 hover:text-slate-900 bg-white hover:bg-slate-50 border border-slate-200 rounded-lg font-semibold transition-all disabled:opacity-40 flex items-center gap-1.5 shadow-2xs"
                title="ส่งออกคำบรรยาย SRT"
              >
                <FileText className="w-3.5 h-3.5 text-slate-500" />
                <span>SRT</span>
              </button>
              <button
                onClick={clearTranscripts}
                disabled={captions.length === 0}
                className="p-1.5 text-slate-400 hover:text-rose-600 rounded-lg hover:bg-rose-50 transition-all disabled:opacity-30 ml-1"
                title="ล้างประวัติข้อความทั้งหมด"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>

          {micPermissionError && (
            <div className="p-3 bg-rose-50 border-b border-rose-200 text-rose-800 text-xs flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <ShieldAlert className="w-4 h-4 text-rose-600 shrink-0" />
                <span className="truncate">{capture.error}</span>
              </div>
              <button
                onClick={() => {
                  setMicActive(false);
                  setTimeout(() => setMicActive(true), 100);
                }}
                className="px-3 py-1 bg-rose-600 text-white rounded-lg text-xs font-semibold flex items-center gap-1 shrink-0"
              >
                <RefreshCw className="w-3 h-3" />
                <span>ลองใหม่อีกครั้ง</span>
              </button>
            </div>
          )}

          {isListening && (
            <div className="px-4 py-2 bg-emerald-50 border-b border-emerald-200 flex items-center justify-between gap-3 text-xs text-emerald-900 transition-all shrink-0">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <div className="flex items-center gap-1.5 shrink-0">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                  </span>
                  <span className="font-bold text-emerald-800 shrink-0">กำลังฟัง:</span>
                </div>
                <div className="flex-1 truncate font-mono text-xs text-emerald-800 font-medium">
                  {capture.partialSource ? (
                    <span>{capture.partialSource}</span>
                  ) : (
                    <span className="text-emerald-600/80 italic">กำลังรอเสียงพูด... (พูดใส่ไมโครโฟนได้ทันที)</span>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ─────────────────────────────────────────────────────────────
              LIVE SUBTITLE — one box, one caption at a time.
          ────────────────────────────────────────────────────────────── */}
          <div className="flex-1 flex flex-col items-center justify-center p-4 sm:p-8 min-h-0">
            <div className="relative w-full max-w-4xl bg-white rounded-2xl border border-slate-200 shadow-sm px-6 py-10 sm:px-12 sm:py-14 text-center">
              {latestCaption && !isEditingBox && !hasPartial && (
                <div className="absolute top-3 right-3 flex items-center gap-1">
                  <button
                    onClick={() => handleCopyItem(latestCaption)}
                    className="p-1.5 text-slate-400 hover:text-slate-700 rounded-md hover:bg-slate-100 transition-all"
                    title="คัดลอกข้อความ"
                  >
                    {copiedSeq === latestCaption.seq ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                  </button>
                  <button
                    onClick={() => startEditing(latestCaption)}
                    className="p-1.5 text-slate-400 hover:text-slate-700 rounded-md hover:bg-slate-100 transition-all"
                    title="แก้ไขคำแปล"
                  >
                    <Edit2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}

              {!latestCaption && !hasPartial ? (
                <div className="flex flex-col items-center gap-3 text-slate-400">
                  <div className="w-14 h-14 rounded-2xl bg-slate-50 border border-slate-200 flex items-center justify-center text-[#DE5C8E]">
                    <Mic className="w-7 h-7" />
                  </div>
                  <div className="max-w-sm">
                    <div className="font-bold text-slate-700 text-sm">พร้อมรับเสียงจากไมโครโฟน</div>
                    <p className="text-xs text-slate-400 leading-relaxed mt-1">
                      กดปุ่ม <strong>&quot;เริ่ม Session&quot;</strong> ด้านบน จากนั้นพูดใส่ไมโครโฟนเพื่อทำการแปลภาษาแบบเรียลไทม์
                    </p>
                  </div>
                </div>
              ) : isEditingBox ? (
                <div className="space-y-3 text-left max-w-2xl mx-auto">
                  <label className="text-xs font-bold text-slate-600 block">คำแปล:</label>
                  <input
                    type="text"
                    autoFocus
                    value={editDraft}
                    onChange={(e) => setEditDraft(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && saveEdit()}
                    className="w-full p-3 text-lg font-bold text-slate-900 text-center border border-slate-300 rounded-lg outline-none focus:border-[#DE5C8E]"
                  />
                  <div className="flex items-center justify-center gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => setEditingSeq(null)}
                      className="px-3.5 py-1.5 text-xs text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg font-medium transition-all"
                    >
                      ยกเลิก
                    </button>
                    <button
                      type="button"
                      onClick={saveEdit}
                      className="px-3.5 py-1.5 text-xs text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg font-semibold flex items-center gap-1.5 shadow-xs transition-all"
                    >
                      <Check className="w-3.5 h-3.5" />
                      <span>บันทึก</span>
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  {config.showOriginal && boxSourceText && (
                    <p className={`text-base sm:text-lg mb-3 ${hasPartial ? 'text-slate-300' : 'text-slate-400'}`}>{boxSourceText}</p>
                  )}
                  <p
                    className={`${boxTextSizeClass(config.fontSize)} font-bold leading-snug tracking-tight transition-colors ${
                      hasPartial ? 'text-slate-400' : 'text-slate-900'
                    }`}
                  >
                    {boxTargetText || <span className="text-slate-300 font-normal text-2xl sm:text-3xl">กำลังแปล…</span>}
                  </p>
                  {config.showLatency && !hasPartial && latestCaption?.latencyMs ? (
                    <span className="mt-3 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-100 font-mono text-[10px] text-slate-500 border border-slate-200">
                      <Zap className="w-3 h-3 text-amber-500" />
                      <span>{latestCaption.latencyMs}ms</span>
                    </span>
                  ) : null}
                </>
              )}
            </div>
          </div>

          {/* ─────────────────────────────────────────────────────────────
              HISTORY — collapsed by default so the subtitle box above stays
              the primary view; full edit/hide/copy tooling lives here.
          ────────────────────────────────────────────────────────────── */}
          {captions.length > 0 && (
            <div className="border-t border-slate-200 bg-white shrink-0">
              <button
                onClick={() => setShowAllHistory((v) => !v)}
                className="w-full flex items-center justify-between px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
              >
                <span>ประวัติทั้งหมด ({captions.length} รายการ)</span>
                {showAllHistory ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </button>
              {showAllHistory && (
                <div ref={transcriptScrollRef} className="max-h-64 overflow-y-auto p-3.5 space-y-3 border-t border-slate-100">
                  {captions.map((item, index) => {
                    // Editing the latest caption happens in the box above, not
                    // duplicated here.
                    const isEditing = editingSeq === item.seq && item.seq !== latestCaption?.seq;
                    const isLatest = index === captions.length - 1;
                    return (
                      <div
                        key={item.seq}
                        className={`p-4 rounded-xl border transition-all shadow-xs ${
                          isEditing
                            ? 'bg-amber-50/90 border-amber-300 ring-2 ring-amber-200'
                            : isLatest
                            ? 'bg-white border-[#DE5C8E]/40 ring-1 ring-[#DE5C8E]/20'
                            : 'bg-white border-slate-200 hover:border-slate-300'
                        }`}
                      >
                        {isEditing ? (
                          <div className="space-y-2.5">
                            {/* Original text has no re-transcription command in
                                this pipeline — it's corrected by re-speaking, not typed. */}
                            <div>
                              <label className="text-xs font-bold text-slate-600 block mb-1">ประโยคต้นฉบับ (แก้ไขไม่ได้):</label>
                              <p className="w-full p-2.5 text-xs bg-slate-100 border border-slate-200 rounded-lg text-slate-500">
                                {item.sourceText}
                              </p>
                            </div>
                            <div>
                              <label className="text-xs font-bold text-slate-600 block mb-1">คำแปล:</label>
                              <input
                                type="text"
                                autoFocus
                                value={editDraft}
                                onChange={(e) => setEditDraft(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && saveEdit()}
                                className="w-full p-2.5 text-xs bg-white border border-slate-300 rounded-lg font-bold text-slate-900 outline-none focus:border-[#DE5C8E]"
                              />
                            </div>
                            <div className="flex items-center justify-end gap-2 pt-1">
                              <button
                                type="button"
                                onClick={() => setEditingSeq(null)}
                                className="px-3.5 py-1.5 text-xs text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg font-medium transition-all"
                              >
                                ยกเลิก
                              </button>
                              <button
                                type="button"
                                onClick={saveEdit}
                                className="px-3.5 py-1.5 text-xs text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg font-semibold flex items-center gap-1.5 shadow-xs transition-all"
                              >
                                <Check className="w-3.5 h-3.5" />
                                <span>บันทึก</span>
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="space-y-1.5">
                            <div className="flex items-center justify-between text-xs text-slate-400">
                              <div className="flex items-center gap-2">
                                <span className="font-mono text-[11px] text-slate-400">{new Date(item.ts * 1000).toLocaleTimeString()}</span>
                                {config.showLatency && item.latencyMs ? (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-100 font-mono text-[10px] text-slate-600 border border-slate-200">
                                    <Zap className="w-3 h-3 text-amber-500" />
                                    <span>{item.latencyMs}ms</span>
                                  </span>
                                ) : null}
                                {item.isEdited && (
                                  <span className="text-[10px] text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded-md font-medium border border-amber-200">
                                    แก้ไขแล้ว
                                  </span>
                                )}
                              </div>
                              <div className="flex items-center gap-1">
                                <button
                                  onClick={() => handleCopyItem(item)}
                                  className="p-1.5 text-slate-400 hover:text-slate-700 rounded-md hover:bg-slate-100 transition-all"
                                  title="คัดลอกข้อความ"
                                >
                                  {copiedSeq === item.seq ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                                </button>
                                <button
                                  onClick={() => startEditing(item)}
                                  className="p-1.5 text-slate-400 hover:text-slate-700 rounded-md hover:bg-slate-100 transition-all"
                                  title="แก้ไขคำแปล"
                                >
                                  <Edit2 className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  onClick={() => hideItem(item.seq)}
                                  className="p-1.5 text-slate-400 hover:text-rose-600 rounded-md hover:bg-rose-50 transition-all"
                                  title="ซ่อนรายการนี้ (ไม่ลบจากเซิร์ฟเวอร์)"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </div>

                            {config.showOriginal && item.sourceText && (
                              <div className="text-xs text-slate-500 font-medium leading-relaxed">{item.sourceText}</div>
                            )}

                            <div className={`${textSizeClass(config.fontSize)} font-bold text-slate-900 leading-snug tracking-tight`}>
                              {item.targetText || <span className="text-slate-400 font-normal">กำลังแปล…</span>}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {report && (
            <div className="p-3.5 bg-white border-t border-slate-200 shrink-0 space-y-1.5 max-h-40 overflow-y-auto">
              <h2 className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                <ClipboardList className="w-3.5 h-3.5 text-[#DE5C8E]" />
                <span>สรุปช่วงการประชุม</span>
              </h2>
              {report.pending ? (
                <p className="text-xs text-slate-500 flex items-center gap-1.5">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#DE5C8E] opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-[#DE5C8E]" />
                  </span>
                  <span>กำลังสรุปผลการประชุม… ({report.items} ข้อความ) — ใช้งานต่อได้เลย ไม่ต้องรอ</span>
                </p>
              ) : report.summary ? (
                <p className="text-xs text-slate-600 whitespace-pre-wrap leading-relaxed">{report.summary}</p>
              ) : (
                // The transcript is preserved even when the summarize call
                // itself fails (quota, network) — say so plainly instead of
                // leaving a blank panel that looks broken.
                <p className="text-xs text-amber-700 flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                  <span>สรุปด้วย AI ไม่สำเร็จ — บันทึกไว้ {report.items} ข้อความ ดูได้ที่ &quot;ประวัติทั้งหมด&quot; ด้านบน</span>
                </p>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
