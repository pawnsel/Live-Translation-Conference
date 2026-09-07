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
  X,
  Radio,
  Menu,
  ShieldAlert,
  Cpu,
  FileText,
  ArrowLeftRight,
  Timer,
  Pause,
  Play,
  ClipboardList,
  RefreshCw,
  AlertTriangle
} from 'lucide-react';
// ProjectPanel.tsx has NO default export — it exports four named components.
import { BillModal, HistoryPanel, ProjectHeaderBar, ProjectPicker } from '../components/ProjectPanel';
import DictionaryManager from '../components/DictionaryManager';
import { captionsReducer, initialCaptionState, selectCaptions, type Caption } from '../asr/captions';
import { useAsrSocket } from '../asr/useAsrSocket';
import { useAudioCapture } from '../asr/audio/useAudioCapture';
import { createOperatorTokenSource, mintSourceToken } from '../asr/tokens';
import { chooseSession, createSession, deleteSession, getSession, listSessions, type SessionSnapshot } from '../asr/sessions';
import * as cmd from '../asr/commands';
import type { GlossarySection } from '../asr/commands';
import type { AnyFrame, GlossarySections, ReportDonePayload } from '../asr/protocol';
import { useProjects } from '../hooks/useProjects';
import type { DisplayConfig, Project } from '../types';

const BACKEND_URL = import.meta.env.VITE_ASR_BACKEND_URL || 'http://localhost:8765';
const HEALTH_POLL_MS = 5000;
const PING_INTERVAL_MS = 3000;
// A ping that never gets a pong (backend gone, socket dead) must not grow
// this map forever — clear it and treat latency as unknown rather than leak.
const MAX_PENDING_PINGS = 20;

// Source tokens live 12 h and expiry is re-checked on EVERY audio frame, so a
// capture client that outlives its token is closed mid-stream with 4401. An
// event day can run past 12 h; re-mint at 80% rather than discover this at
// hour twelve of a conference.
const SOURCE_TOKEN_REFRESH_MS = 12 * 3600 * 1000 * 0.8;
// Operator tokens live 12 h too, and `tokenSource.get()` only refreshes once
// 80% of that life has elapsed — calling it more often costs nothing (it
// just returns the cached token) until it's actually time to re-mint. A
// short, minutes-scale poll is therefore both sufficient and more robust
// than one long timer.
const OPERATOR_TOKEN_POLL_MS = 5 * 60 * 1000;

// Only the pair the backend actually supports (protocol-v1.md: "Supported
// pairs: th⇄en"). Anything else is not a language the server will accept.
const LANGS: Record<'th' | 'en', string> = { th: 'ไทย (Thai)', en: 'อังกฤษ (English)' };
const other = (lang: string) => (lang === 'th' ? 'en' : 'th');

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

export default function Admin() {
  const projects = useProjects();
  const tokenSource = useMemo(() => createOperatorTokenSource(), []);

  const [token, setToken] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [session, setSession] = useState<SessionSnapshot | null>(null);
  const [candidates, setCandidates] = useState<SessionSnapshot[]>([]);
  const [sourceToken, setSourceToken] = useState<string | null>(null);
  const [micActive, setMicActive] = useState(false);
  const [glossary, setGlossary] = useState<GlossarySections | null>(null);
  const [report, setReport] = useState<ReportDonePayload | null>(null);
  const [pingMs, setPingMs] = useState<number | null>(null);

  const [config, setConfig] = useState<DisplayConfig>({ fontSize: 'large', showOriginal: true, showLatency: true });
  const [activeTab, setActiveTab] = useState<'languages' | 'dictionary'>('languages');
  const [mobileSettingsOpen, setMobileSettingsOpen] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [finishedProject, setFinishedProject] = useState<Project | null>(null);

  // Captions have no delete command in protocol v1 (they are server-authored
  // history), so "delete" is a local-only hide — it never reaches the
  // backend and never affects the export unless the operator also removes it
  // there. Hidden seqs still exist in the reducer; only the render is filtered.
  const [hiddenSeqs, setHiddenSeqs] = useState<Set<number>>(new Set());
  const [editingSeq, setEditingSeq] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [copiedSeq, setCopiedSeq] = useState<number | null>(null);

  const [captionState, dispatchCaption] = useReducer(captionsReducer, initialCaptionState);
  const allCaptions = useMemo(() => selectCaptions(captionState), [captionState]);
  const captions = useMemo(() => allCaptions.filter((c) => !hiddenSeqs.has(c.seq)), [allCaptions, hiddenSeqs]);

  const bootstrapped = useRef(false);
  const transcriptScrollRef = useRef<HTMLDivElement>(null);
  const pendingPings = useRef<Map<string, number>>(new Map());

  // `useProjects()` returns a fresh object literal every render, so
  // `detachAsrSession` changes identity on every render too. Effects below
  // need to call it without re-running on every render because of that —
  // hold it in a ref refreshed each render instead of depending on `projects`.
  const detachAsrSessionRef = useRef(projects.detachAsrSession);
  detachAsrSessionRef.current = projects.detachAsrSession;

  // ── Operator token: initial fetch + periodic refresh ────────────────────
  useEffect(() => {
    tokenSource.get().then(setToken).catch((err: Error) => setTokenError(err.message));
  }, [tokenSource]);

  useEffect(() => {
    const timer = setInterval(() => {
      tokenSource.get().then(setToken).catch((err: Error) => setTokenError(err.message));
    }, OPERATOR_TOKEN_POLL_MS);
    return () => clearInterval(timer);
    // `tokenSource` is `useMemo(() => createOperatorTokenSource(), [])`, so it
    // is stable for the component's life — unlike `projects` or a re-parsed
    // `session` object, both of which have previously defeated a long timer
    // in this file by forcing it to tear down and rebuild before it fired.
  }, [tokenSource]);

  // ── Adopt or offer to create a session ───────────────────────────────────
  useEffect(() => {
    if (!token || bootstrapped.current) return;
    bootstrapped.current = true;
    listSessions(BACKEND_URL, token)
      .then((live) => {
        const choice = chooseSession(live);
        if (choice.action === 'adopt') setSession(live.find((s) => s.id === choice.id) ?? null);
        else if (choice.action === 'ask') setCandidates(choice.sessions);
      })
      .catch((err: Error) => setTokenError(err.message));
  }, [token]);

  // ── Health polling over HTTP, never over the rate-limited WebSocket ──────
  useEffect(() => {
    if (!token || !session) return;
    const timer = setInterval(async () => {
      let fresh: SessionSnapshot | null | undefined;
      try {
        fresh = await getSession(BACKEND_URL, token, session.id);
      } catch (err) {
        // A 401/500/network blip is not the same as a 404 — the session may
        // still be alive. Surface it instead of silently going dark; do not
        // touch session/mic state, so a transient failure doesn't tear down
        // a healthy session.
        setTokenError((err as Error).message);
        return;
      }
      if (fresh === null) {
        // The backend forgot this session — a restart. Do not retry the id.
        setSession(null);
        setMicActive(false);
        setSourceToken(null);
        detachAsrSessionRef.current();
      } else if (fresh) {
        setSession(fresh);
      }
    }, HEALTH_POLL_MS);
    return () => clearInterval(timer);
    // `session` is a freshly-parsed object on every poll (never
    // reference-equal to the last one, even when unchanged), so depending on
    // it here would tear down and rebuild this very interval every cycle.
  }, [token, session?.id]);

  // ── Control socket ───────────────────────────────────────────────────────
  const onFrame = useCallback((frame: AnyFrame) => {
    dispatchCaption({ kind: 'frame', frame });
    if (frame.type === 'glossary.state') {
      setGlossary((frame.data as { sections: GlossarySections }).sections);
    } else if (frame.type === 'session.welcome') {
      setGlossary((frame.data as { glossary: { sections: GlossarySections } }).glossary.sections);
    } else if (frame.type === 'report.done') {
      setReport(frame.data as ReportDonePayload);
    } else if (frame.type === 'control.pong' && frame.id) {
      const sentAt = pendingPings.current.get(frame.id);
      if (sentAt !== undefined) {
        setPingMs(Date.now() - sentAt);
        pendingPings.current.delete(frame.id);
      }
    }
  }, []);

  const socket = useAsrSocket({ backendUrl: BACKEND_URL, sessionId: session?.id ?? null, token, onFrame });

  useEffect(() => {
    if (!socket.sessionGone) return;
    setSession(null);
    setMicActive(false);
    setSourceToken(null);
    detachAsrSessionRef.current();
  }, [socket.sessionGone]);

  // ── Live socket latency, mirroring the old ping-check/pong-check heartbeat ──
  useEffect(() => {
    if (socket.status !== 'open' || !session) {
      pendingPings.current.clear();
      return;
    }
    const timer = setInterval(() => {
      if (pendingPings.current.size >= MAX_PENDING_PINGS) {
        // Nothing has answered in a while — the connection is not healthy.
        // Stop guessing rather than grow this map forever.
        pendingPings.current.clear();
        setPingMs(null);
      }
      const built = cmd.ping(session.id);
      pendingPings.current.set(built.id, Date.now());
      socket.send(built);
    }, PING_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [socket.status, session?.id]);

  // ── Audio capture ────────────────────────────────────────────────────────
  const capture = useAudioCapture({
    backendUrl: BACKEND_URL,
    sessionId: session?.id ?? null,
    sourceToken,
    active: micActive
  });

  useEffect(() => {
    if (!micActive || !token || !session) return;
    const timer = setInterval(() => {
      mintSourceToken(BACKEND_URL, session.id, token).then(setSourceToken).catch((err: Error) => setTokenError(err.message));
    }, SOURCE_TOKEN_REFRESH_MS);
    return () => clearInterval(timer);
  }, [micActive, token, session?.id]);

  // ── Session + mic as one combined "Session" toggle, matching the original
  //    single Start/Stop button (the backend's create/adopt/end machinery
  //    sits behind it rather than being exposed as separate controls) ──────
  const [starting, setStarting] = useState(false);

  const adoptCandidate = async (id: string) => {
    if (!token) return;
    const found = await getSession(BACKEND_URL, token, id);
    setSession(found);
    setCandidates([]);
    if (found) projects.attachAsrSession(found.id, found.source_lang, found.target_lang);
  };

  const startSessionAndMic = async () => {
    if (!token || starting) return;
    setStarting(true);
    try {
      let live = session;
      if (!live) {
        live = await createSession(BACKEND_URL, token);
        setSession(live);
        setCandidates([]);
        dispatchCaption({ kind: 'reset' });
        setHiddenSeqs(new Set());
        projects.attachAsrSession(live.id, live.source_lang, live.target_lang);
      }
      const src = await mintSourceToken(BACKEND_URL, live.id, token);
      setSourceToken(src);
      setMicActive(true);
    } catch (err) {
      setTokenError((err as Error).message);
    } finally {
      setStarting(false);
    }
  };

  // Ending the session also ends the ASR session on the backend: a project is
  // durable, the Python session is not, and leaving one running would keep
  // billing a recognizer for an event that is over.
  const stopSessionAndMic = async () => {
    setMicActive(false);
    if (token && session) {
      await deleteSession(BACKEND_URL, token, session.id).catch(() => undefined);
    }
    setSession(null);
    setSourceToken(null);
    projects.detachAsrSession();
  };

  const isSessionActive = !!session && micActive;

  const handleRequestFinishProject = async () => {
    await stopSessionAndMic();
    const finished = projects.finishProject(allCaptions);
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
    if (!session) return;
    socket.send(cmd.setLanguages(session.id, source, other(source)));
  };

  const handleSwapLanguages = () => {
    if (!socket.welcome || !session) return;
    socket.send(cmd.setLanguages(session.id, socket.welcome.target_lang, socket.welcome.source_lang));
  };

  // ── Chunking / gate presets — same three named speeds as before, now
  //    expressed as the backend's (min_words, min_interval_ms) pair ───────
  const GATE_PRESETS: Array<{ value: string; minWords: number; minIntervalMs: number; label: string }> = [
    { value: 'fast', minWords: 2, minIntervalMs: 250, label: '⚡ เร็วมาก (Fast)' },
    { value: 'balanced', minWords: 3, minIntervalMs: 400, label: '⚖️ มาตรฐาน (Balanced)' },
    { value: 'relaxed', minWords: 5, minIntervalMs: 700, label: '🧘 ผ่อนคลาย (Relaxed)' }
  ];
  const currentGatePreset = useMemo(() => {
    const gate = socket.welcome?.gate;
    if (!gate) return 'balanced';
    const match = GATE_PRESETS.find((p) => p.minWords === gate.min_words && p.minIntervalMs === gate.min_interval_ms);
    return match?.value ?? 'balanced';
  }, [socket.welcome?.gate]);

  const handleGateChange = (value: string) => {
    if (!session) return;
    const preset = GATE_PRESETS.find((p) => p.value === value);
    if (!preset) return;
    socket.send(cmd.setGate(session.id, preset.minWords, preset.minIntervalMs));
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
      content = `=== Live Translation Transcript (${dateStr}) ===\n${socket.welcome?.source_lang ?? '-'} -> ${socket.welcome?.target_lang ?? '-'}\n\n`;
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

  const disabled = socket.status !== 'open';
  const welcome = socket.welcome;
  const sourceLang = welcome?.source_lang ?? 'th';
  const targetLang = welcome?.target_lang ?? 'en';
  const isListening = capture.status === 'sending';
  const micPermissionError = capture.status === 'error';

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
              <span className="text-[11px] text-slate-400 font-medium leading-tight mt-0.5">Google Chirp 3 + Google Translate</span>
            </div>
          </div>

          <div className="hidden sm:block">
            <ProjectHeaderBar
              project={projects.currentProject}
              activeSession={projects.activeSession}
              onRequestFinish={handleRequestFinishProject}
              onSwitchProject={handleSwitchProject}
              onOpenHistory={() => setShowHistory(true)}
            />
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
                  {welcome?.paused ? 'พักการถอดความ' : 'กำลังแปลสด'}
                </span>
              </>
            ) : (
              <>
                <span className="w-2 h-2 rounded-full bg-slate-400" />
                <span className="text-[11px] whitespace-nowrap">พร้อมใช้งาน</span>
              </>
            )}
          </div>

          <div className="hidden md:flex items-center gap-2 bg-slate-100 px-3 py-1.5 rounded-full text-[11px] font-mono border border-slate-200">
            <Zap className={`w-3.5 h-3.5 ${isSessionActive ? 'text-amber-500' : 'text-slate-400'}`} />
            <span className="text-slate-500">Latency:</span>
            <span className="font-semibold text-slate-800">{captions.at(-1)?.latencyMs ? `${captions.at(-1)!.latencyMs}ms` : '--'}</span>
            <span className="text-slate-300">|</span>
            <Activity className="w-3.5 h-3.5 text-emerald-600" />
            <span className="text-slate-500">Ping:</span>
            <span className="font-semibold text-slate-800">{pingMs !== null ? `${pingMs}ms` : '--'}</span>
          </div>

          {session && (
            <button
              onClick={() => socket.send(cmd.setPaused(session.id, !welcome?.paused))}
              disabled={disabled}
              title={welcome?.paused ? 'เล่นต่อ' : 'พักการถอดความ'}
              className="p-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600 disabled:opacity-40"
            >
              {welcome?.paused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
            </button>
          )}

          <button
            onClick={isSessionActive ? stopSessionAndMic : startSessionAndMic}
            disabled={starting || (!session && candidates.length > 1)}
            className={`px-4 py-2 rounded-lg text-xs font-bold flex items-center gap-2 transition-all shadow-xs whitespace-nowrap disabled:opacity-50 ${
              isSessionActive ? 'bg-rose-600 hover:bg-rose-700 text-white animate-pulse' : 'bg-[#DE5C8E] hover:bg-[#c94577] text-white'
            }`}
          >
            {isSessionActive ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
            <span>{starting ? 'กำลังเริ่ม…' : isSessionActive ? 'จบ Session' : 'เริ่ม Session'}</span>
          </button>
        </div>
      </header>

      <div className="sm:hidden px-3 py-2 bg-white border-b border-slate-200 shrink-0 overflow-x-auto">
        <ProjectHeaderBar
          project={projects.currentProject}
          activeSession={projects.activeSession}
          onRequestFinish={handleRequestFinishProject}
          onSwitchProject={handleSwitchProject}
          onOpenHistory={() => setShowHistory(true)}
        />
      </div>

      {tokenError && (
        <div className="px-4 py-2 bg-rose-50 border-b border-rose-200 text-rose-800 text-xs flex items-center gap-2 shrink-0">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span>{tokenError}</span>
        </div>
      )}
      {socket.error && (
        <div className="px-4 py-2 bg-amber-50 border-b border-amber-200 text-amber-800 text-xs flex items-center gap-2 shrink-0">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span>{socket.error}</span>
        </div>
      )}

      {/* Several ASR sessions are already running on the backend — this is
          new capability that plain socket.io never had, since the old server
          held exactly one global session. Adopting "the first" would attach
          this console to another venue's live event. */}
      {!session && candidates.length > 1 && (
        <div className="px-4 py-3 bg-white border-b border-slate-200 shrink-0 space-y-2">
          <p className="text-xs font-semibold text-slate-700">มีหลายเซสชันกำลังทำงานอยู่บนเซิร์ฟเวอร์ เลือกเซสชันที่ต้องการควบคุม:</p>
          <div className="flex flex-wrap gap-2">
            {candidates.map((c) => (
              <button
                key={c.id}
                onClick={() => adoptCandidate(c.id)}
                className="px-3 py-1.5 bg-slate-100 hover:bg-pink-50 hover:text-[#DE5C8E] border border-slate-200 rounded-lg text-xs font-mono"
              >
                {c.id} — {c.source_lang}→{c.target_lang} · {c.clients} จอ
              </button>
            ))}
          </div>
        </div>
      )}

      {session && (session.recognizer_alive === false || (capture.backpressure && isSessionActive)) && (
        <div className="px-4 py-2 bg-amber-50 border-b border-amber-200 text-amber-800 text-xs flex items-center gap-2 shrink-0">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span>
            {session.recognizer_alive === false
              ? 'ตัวถอดเสียงของเซสชันนี้ขัดข้อง — ลองจบและเริ่ม Session ใหม่'
              : `เซิร์ฟเวอร์รับเสียงไม่ทัน กำลังตัดเฟรมทิ้ง (${capture.droppedFrames} เฟรม)`}
          </span>
        </div>
      )}

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
                <div className="bg-slate-50 p-3.5 rounded-xl border border-slate-200 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                      <Cpu className="w-4 h-4 text-[#DE5C8E]" />
                      <span>ระบบแปลงเสียงพูด (Speech ASR)</span>
                    </span>
                    <span className="text-[10px] bg-emerald-50 text-emerald-800 font-semibold px-2 py-0.5 rounded-md border border-emerald-200">
                      Chirp 3 Engine
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 leading-relaxed">
                    เอนจิน Google Cloud Speech &amp; Chirp แปลงเสียงสดเป็นข้อความอัตโนมัติ ควบคุมโดยเซิร์ฟเวอร์ ASR โดยตรง
                  </p>
                </div>

                <div className="space-y-3 bg-slate-50 p-3.5 rounded-xl border border-slate-200">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-800">คู่ภาษาแปลสด (Thai ↔ English)</span>
                    <button
                      type="button"
                      onClick={handleSwapLanguages}
                      disabled={disabled || !welcome?.asr_switchable}
                      className="text-[11px] px-2.5 py-1 bg-white hover:bg-pink-50 text-[#DE5C8E] border border-pink-200 rounded-lg font-bold flex items-center gap-1 shadow-2xs transition-all disabled:opacity-40"
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
                      disabled={disabled || isListening}
                      className="w-full p-2.5 text-xs bg-white border border-slate-200 rounded-lg outline-none focus:border-[#DE5C8E] disabled:opacity-60 font-semibold text-slate-800"
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
                      disabled={disabled}
                      className="w-full p-2.5 text-xs bg-white border border-slate-200 rounded-lg outline-none focus:border-[#DE5C8E] disabled:opacity-60 font-semibold text-[#DE5C8E]"
                    >
                      <option value="en">แปลเป็นอังกฤษ (English)</option>
                      <option value="th">แปลเป็นไทย (Thai)</option>
                    </select>
                  </div>
                  {welcome?.asr_switchable && (
                    <p className="text-[11px] text-slate-500">การสลับภาษาต้นทางจะรีสตาร์ทการฟังเสียงราว 1 วินาที</p>
                  )}
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="block text-xs font-bold text-slate-700">ความไวการตัดช่วงแปลสด (Live Chunking)</label>
                    {welcome && (
                      <span className="text-[10px] text-[#DE5C8E] font-semibold flex items-center gap-1">
                        <Timer className="w-3 h-3" />
                        <span>
                          {welcome.gate.min_words} คำ / {welcome.gate.min_interval_ms}ms
                        </span>
                      </span>
                    )}
                  </div>
                  <select
                    value={currentGatePreset}
                    onChange={(e) => handleGateChange(e.target.value)}
                    disabled={disabled}
                    className="w-full p-2.5 text-xs bg-slate-50 border border-slate-200 rounded-lg outline-none focus:bg-white focus:border-[#DE5C8E] font-medium disabled:opacity-60"
                  >
                    {GATE_PRESETS.map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-[11px] text-slate-500 leading-normal">
                    กำหนดจังหวะที่ระบบจะส่งคำแปลระหว่างที่ผู้พูดยังพูดไม่จบประโยค
                  </p>
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

                {session && (
                  <div className="pt-3 border-t border-slate-200">
                    <button
                      onClick={() => socket.send(welcome?.report.active ? cmd.reportStop(session.id) : cmd.reportStart(session.id))}
                      disabled={disabled}
                      className="w-full py-2 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-lg text-xs font-semibold text-slate-700 flex items-center justify-center gap-1.5 disabled:opacity-40"
                    >
                      <ClipboardList className="w-3.5 h-3.5 text-[#DE5C8E]" />
                      <span>
                        {welcome?.report.active ? `หยุดบันทึกช่วง (${welcome.report.count} รายการ)` : 'เริ่มบันทึกช่วงเพื่อสรุป'}
                      </span>
                    </button>
                  </div>
                )}
              </div>
            )}

            {activeTab === 'dictionary' && (
              <DictionaryManager
                sections={glossary}
                disabled={disabled}
                onAdd={(section: GlossarySection, abbr, full) => session && socket.send(cmd.glossaryAdd(session.id, section, abbr, full))}
                onRemove={(section: GlossarySection, abbr) => session && socket.send(cmd.glossaryRemove(session.id, section, abbr))}
                onReload={() => session && socket.send(cmd.glossaryReload(session.id))}
              />
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
            <div className="flex items-center gap-2 text-xs text-slate-600">
              <Radio className={`w-4 h-4 ${isListening ? 'text-emerald-500 animate-pulse' : 'text-slate-400'}`} />
              <div className="flex items-center gap-1.5 bg-slate-100 px-2.5 py-1 rounded-lg border border-slate-200">
                <span className="font-bold text-slate-800">
                  {LANGS[sourceLang as 'th' | 'en'] ?? sourceLang} ➔ {LANGS[targetLang as 'th' | 'en'] ?? targetLang}
                </span>
                <button
                  onClick={handleSwapLanguages}
                  disabled={disabled || !welcome?.asr_switchable}
                  className="p-1 hover:bg-white rounded-md text-slate-500 hover:text-[#DE5C8E] transition-all disabled:opacity-40"
                  title="สลับภาษาผู้พูดและภาษาแปล"
                >
                  <ArrowLeftRight className="w-3.5 h-3.5" />
                </button>
              </div>
              <span className="text-slate-400 font-medium hidden sm:inline">({captions.length} รายการ)</span>
            </div>

            <div className="flex items-center gap-2">
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
                  {captionState.interim?.sourceText ? (
                    <span className="bg-emerald-100/80 px-2 py-0.5 rounded text-emerald-900 font-semibold animate-pulse">
                      &ldquo;{captionState.interim.sourceText}&rdquo;
                    </span>
                  ) : (
                    <span className="text-emerald-600/80 italic">กำลังรอเสียงพูด... (พูดใส่ไมโครโฟนได้ทันที)</span>
                  )}
                </div>
              </div>
              {welcome && (
                <span className="hidden sm:inline-flex items-center gap-1 px-2 py-0.5 bg-white text-[11px] font-semibold text-emerald-800 border border-emerald-300 rounded-md shadow-2xs shrink-0">
                  <Timer className="w-3 h-3 text-emerald-600" />
                  <span>ตัดวรรค ~{welcome.gate.min_interval_ms}ms</span>
                </span>
              )}
            </div>
          )}

          <div ref={transcriptScrollRef} className="flex-1 p-3.5 sm:p-6 overflow-y-auto space-y-3.5">
            {captions.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center p-6 text-slate-400 space-y-3">
                <div className="w-14 h-14 rounded-2xl bg-white border border-slate-200 shadow-xs flex items-center justify-center text-[#DE5C8E]">
                  <Mic className="w-7 h-7" />
                </div>
                <div className="space-y-1 max-w-sm">
                  <div className="font-bold text-slate-700 text-sm">พร้อมรับเสียงจากไมโครโฟน</div>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    กดปุ่ม <strong>&quot;เริ่ม Session&quot;</strong> ด้านบน จากนั้นพูดใส่ไมโครโฟนเพื่อทำการแปลภาษาแบบเรียลไทม์
                  </p>
                </div>
              </div>
            ) : (
              captions.map((item, index) => {
                const isEditing = editingSeq === item.seq;
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
                        {/* Original text is server-authored and not editable —
                            protocol v1 has no command to amend it. */}
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
              })
            )}
          </div>

          {report && (
            <div className="p-3.5 bg-white border-t border-slate-200 shrink-0 space-y-1.5 max-h-40 overflow-y-auto">
              <h2 className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                <ClipboardList className="w-3.5 h-3.5 text-[#DE5C8E]" />
                <span>สรุปช่วงการประชุม</span>
              </h2>
              <p className="text-xs text-slate-600 whitespace-pre-wrap leading-relaxed">{report.summary}</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
