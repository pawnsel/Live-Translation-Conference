import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
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
  Edit2,
  Menu,
  ShieldAlert,
  FileText,
  ArrowLeftRight,
  Pause,
  Play,
  ClipboardList,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  User,
  LogOut
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { getAccessToken } from '../lib/supabase';
// ProjectPanel.tsx has NO default export — it exports named components only.
import {
  BillModal,
  HistoryPanel,
  LiveCostBadge,
  ProjectHeaderBar,
  ProjectPicker,
  SessionHistoryModal,
  SessionSummaryModal
} from '../components/ProjectPanel';
import DictionaryManager from '../components/DictionaryManager';
import { captionsReducer, initialCaptionState, selectCaptions, type Caption } from '../asr/captions';
import { groupCaptionsIntoParagraphs } from '../asr/historyParagraphs';
import { activeUtteranceSeq, buildCaptionRows } from '../asr/captionStack';
import { useGeminiLiveCapture, type CaptionResult } from '../asr/audio/useGeminiLiveCapture';
import { useAudioInputDevices } from '../asr/audio/useAudioInputDevices';
import { deviceLabel, resolveDeviceId } from '../asr/audio/audioDevices';
import { loadMicDeviceId, saveMicDeviceId } from '../storage/micStore';
import { autoStopReason, IDLE_STOP_MS, type AutoStopReason } from '../asr/audio/sessionLimits';
import { SESSION_HEARTBEAT_MS } from '../data/staleSessions';
import { forgetTabSession, loadTabSession, rememberTabSession } from '../storage/tabSession';
import SubtitleText from '../components/SubtitleText';
import { useProjects } from '../hooks/useProjects';
import { useLiveProjectCost } from '../hooks/useLiveProjectCost';
import { emptyGlossary, type GlossarySection, type GlossarySections } from '../glossary';
import { useGlossary } from '../hooks/useGlossary';
import type { DisplayConfig, Project, ProjectSession, TranscriptItem } from '../types';

// Bounded wait for a summary before giving up and showing the "AI summary
// failed" state. A two-hour transcript is summarised chunk by chunk on the
// server, so this must stay comfortably above the server's own job budget
// (SUMMARIZE_TIMEOUT_MS, 150s) or the client abandons work about to succeed.
const REPORT_WAIT_TIMEOUT_MS = 180000;

// How often the auto-stop limits are evaluated. Both limits are measured in
// minutes, so checking every ten seconds is precise enough and costs nothing.
const AUTO_STOP_CHECK_MS = 10_000;

// Shown when the mock session somehow has no address on it — the guard in
// App.tsx means this should not be reachable, but the header must render.
const ANONYMOUS_USER_NAME = 'ผู้ใช้งาน';

// Only the pair this console supports. Anything else is not a language
// the model is instructed to expect.
const LANGS: Record<'th' | 'en', string> = { th: 'ไทย (Thai)', en: 'อังกฤษ (English)' };
const other = (lang: string) => (lang === 'th' ? 'en' : 'th');

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const m = String(Math.floor(totalSeconds / 60) % 60).padStart(2, '0');
  const s = String(totalSeconds % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function formatSrtTime(ms: number): string {
  const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const m = String(Math.floor(ms / 60000) % 60).padStart(2, '0');
  const s = String(Math.floor(ms / 1000) % 60).padStart(2, '0');
  const msPart = String(Math.floor(ms % 1000)).padStart(3, '0');
  return `${h}:${m}:${s},${msPart}`;
}

/** Rows in the rolling caption stack — one utterance each, newest on top. */
const CAPTION_ROWS = 3;

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
      return 'text-xl sm:text-2xl';
    case 'medium':
      return 'text-2xl sm:text-3xl';
    case 'xlarge':
      return 'text-4xl sm:text-5xl';
    case 'large':
    default:
      return 'text-3xl sm:text-4xl';
  }
}

export default function Admin() {
  // Session + approval state. Both are needed before any project loads:
  // an unapproved account must hold nothing, so a shared machine never shows
  // the previous operator's meetings.
  const { user, session, status, signOut } = useAuth();
  const navigate = useNavigate();

  const [sessionId, setSessionId] = useState<string | null>(null);

  // What this tab was recording before the page reloaded, read once at mount.
  // A refresh leaves the session's heartbeat only seconds old, so the sweep
  // correctly finds it fresh and it would sit marked "recording" for the
  // whole staleness window — unable to be summarised, blocking a project
  // switch. sessionStorage survives the reload and dies with the tab, which
  // is precisely the fact needed: that session was mine, and it is over.
  const [reclaimAsrSessionId, setReclaimAsrSessionId] = useState<string | null>(() =>
    loadTabSession()
  );

  const projects = useProjects({
    userId: status === 'approved' ? user?.id ?? null : null,
    // Names the session this tab owns so the sweep can never close the
    // meeting being recorded right here.
    ownAsrSessionId: sessionId,
    reclaimAsrSessionId
  });
  const glossaryState = useGlossary({ projectId: projects.currentProject?.id ?? null });
  const glossary: GlossarySections | null = glossaryState.sections;

  const [micActive, setMicActive] = useState(false);

  // ── Auto-stop ─────────────────────────────────────────────────────────────
  // A live session bills by wall clock — roughly $2.20 an hour — for as long
  // as it stays open, and nothing used to close one. These two clocks are what
  // stop a tab left open on a Friday evening from billing all weekend. The
  // rules themselves live in asr/audio/sessionLimits.ts.
  //
  // Speech, not audio: an open microphone streams frames continuously from a
  // silent room, so frames say nothing about whether anybody is talking. A
  // partial or a closed caption is the only evidence of a person.
  const sessionStartedAtRef = useRef<number | null>(null);
  const lastSpeechAtRef = useRef<number>(Date.now());
  /** Why the last session stopped itself, or null when the operator stopped
   *  it. Cleared when the next session starts. */
  const [autoStopped, setAutoStopped] = useState<AutoStopReason | null>(null);

  // ── Microphone choice ─────────────────────────────────────────────────────
  // A real meeting swaps interfaces between sessions, so the operator picks
  // one here rather than in the OS. It is remembered per device, and it is
  // frozen for the whole of a session — including while paused. Changing it
  // flows into useGeminiLiveCapture's effect dependencies, which tears the
  // pipeline down and reconnects; doing that mid-meeting would drop the
  // sentence in flight and cost a fresh handshake. The picker below is
  // disabled whenever a session is open, and this state is what enforces it.
  const { devices: micDevices, refresh: refreshMicDevices } = useAudioInputDevices();
  const [micDeviceId, setMicDeviceId] = useState<string | null>(() => loadMicDeviceId());
  const effectiveMicDeviceId = resolveDeviceId(micDeviceId, micDevices);
  // True once the machine has a list AND the remembered choice is not in it:
  // the interface was unplugged, and this session will fall back to default.
  const micDeviceMissing = micDeviceId !== null && micDevices.length > 0 && effectiveMicDeviceId === undefined;

  const handleSelectMicDevice = (deviceId: string) => {
    const next = deviceId === '' ? null : deviceId;
    setMicDeviceId(next);
    saveMicDeviceId(next);
  };
  const [sourceLang, setSourceLangState] = useState<'th' | 'en'>('th');
  const [targetLang, setTargetLangState] = useState<'th' | 'en'>('en');
  const [paused, setPaused] = useState(false);

  // Real-time elapsed clock for the current session, hh:mm:ss — mirrors a
  // voice-recorder timer: it runs while recording and freezes while paused,
  // so the number always reads "how much has actually been recorded".
  const [elapsedMs, setElapsedMs] = useState(0);
  const elapsedTickRef = useRef<number | null>(null);

  const [config, setConfig] = useState<DisplayConfig>({
    fontSize: 'medium',
    showOriginal: false,
    showPrevious: false,
    showLatency: false,
    captionTheme: 'light'
  });
  const [activeTab, setActiveTab] = useState<'languages' | 'dictionary'>('languages');
  const [mobileSettingsOpen, setMobileSettingsOpen] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showSessionHistory, setShowSessionHistory] = useState(false);
  // Which session's summary popup is open, by ProjectSession id. The session
  // itself is read from the live project record, so a summary that arrives
  // while the popup is open fills itself in.
  const [summarySessionId, setSummarySessionId] = useState<string | null>(null);
  // Epoch ms when the current summarize request started, null when idle — lets
  // the popup show elapsed time instead of a static spinner.
  const [summarizingSince, setSummarizingSince] = useState<number | null>(null);
  const [showAllHistory, setShowAllHistory] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [finishedProject, setFinishedProject] = useState<Project | null>(null);

  // The signed-in operator (Supabase — see src/auth/AuthProvider.tsx). The
  // header identifies the account by its email address, which is what the user
  // actually recognises; the Google display name is secondary.
  const userEmail = user?.email || ANONYMOUS_USER_NAME;
  const userPicture = user?.picture;
  const userFullName = [user?.firstName, user?.lastName].filter(Boolean).join(' ') || user?.name || '';

  const handleSignOut = useCallback(async () => {
    setProfileOpen(false);
    await signOut();
    navigate('/login', { replace: true });
  }, [signOut, navigate]);

  // Captions have no "delete" concept anymore (there is no server to delete
  // them from) — "delete" stays a local-only hide so an operator can tidy
  // the visible history. Hiding removes a caption from the on-screen view
  // and from TXT/SRT export, but it is still included in the AI summary and
  // the permanent project record.
  const [hiddenSeqs, setHiddenSeqs] = useState<Set<number>>(new Set());
  const [editingSeq, setEditingSeq] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [copiedSeq, setCopiedSeq] = useState<number | null>(null);
  // History reads as prose, so per-caption controls cannot sit inline without
  // pushing the text around. The caption under the cursor is highlighted and
  // its actions appear in one toolbar pinned to the top of the scroller.
  const [hoveredSeq, setHoveredSeq] = useState<number | null>(null);

  const [captionState, dispatchCaption] = useReducer(captionsReducer, initialCaptionState);
  const allCaptions = useMemo(() => selectCaptions(captionState), [captionState]);
  const captions = useMemo(() => allCaptions.filter((c) => !hiddenSeqs.has(c.seq)), [allCaptions, hiddenSeqs]);
  const historyParagraphs = useMemo(() => groupCaptionsIntoParagraphs(captions), [captions]);
  const hoveredItem = useMemo(() => captions.find((c) => c.seq === hoveredSeq) ?? null, [captions, hoveredSeq]);

  const transcriptScrollRef = useRef<HTMLDivElement>(null);

  // ── Gemini capture result → captions ─────────────────────────────────────
  const handleCaptureResult = useCallback(
    (result: CaptionResult) => {
      const item: TranscriptItem = {
        seq: result.seq,
        sourceText: result.sourceText,
        targetText: result.targetText,
        sourceLang: result.sourceLang,
        targetLang: result.targetLang,
        ts: Date.now() / 1000,
        latencyMs: result.latencyMs,
        isEdited: false
      };
      // A closed sentence is the strongest evidence there is that somebody is
      // in the room, so it holds the idle auto-stop off.
      lastSpeechAtRef.current = Date.now();
      // Spelled out rather than spread: CaptionAction's 'add' has no `ts` or
      // `isEdited` — the reducer stamps its own timestamp — so spreading the
      // item would not typecheck.
      dispatchCaption({
        kind: 'add',
        seq: item.seq,
        sourceText: item.sourceText,
        targetText: item.targetText,
        sourceLang: item.sourceLang,
        targetLang: item.targetLang,
        latencyMs: item.latencyMs
      });
      // Written as it closes rather than at the end of the session: a crashed
      // tab now loses the sentence in flight, not the whole meeting. Not
      // awaited — the subtitle must never wait on a round trip.
      if (sessionId) void projects.appendCaption(sessionId, item);
    },
    [sessionId, projects]
  );

  const capture = useGeminiLiveCapture({
    active: micActive,
    paused,
    deviceId: effectiveMicDeviceId,
    sourceLang,
    targetLang,
    glossary: glossary ?? emptyGlossary(),
    onResult: handleCaptureResult,
    accessToken: session?.access_token ?? null
  });

  // A browser hides microphone LABELS until the page has been granted
  // permission at least once, so the very first enumeration comes back as a
  // list of blank names. The first successful capture is that grant — read
  // the list again there and the picker fills in with real product names,
  // without ever prompting on its own just to populate a dropdown.
  useEffect(() => {
    if (capture.status === 'listening') void refreshMicDevices();
  }, [capture.status, refreshMicDevices]);

  // ── Session + mic as one combined "Session" toggle, matching the original
  //    single Start/Stop button ─────────────────────────────────────────────
  const [endingSession, setEndingSession] = useState(false);
  const [startingSession, setStartingSession] = useState(false);

  const startSessionAndMic = async () => {
    // Guard set synchronously, before the await below — otherwise a rapid
    // double-click re-enters this function while attachAsrSession is still
    // in flight, generating a second sessionId and a second concurrent
    // attach call. Mirrors the endingSession guard on the stop path.
    if (micActive || startingSession) return;
    setStartingSession(true);
    const id = `local_${Date.now()}`;
    setSessionId(id);
    // Both auto-stop clocks start here. lastSpeechAt starts at "now" rather
    // than at zero so a session nobody ever speaks into is still stopped, one
    // idle window after it began.
    sessionStartedAtRef.current = Date.now();
    lastSpeechAtRef.current = Date.now();
    setAutoStopped(null);
    // Remembered before the attach round trip: if the tab is closed or
    // refreshed while that request is in flight, the id still has to be
    // reclaimable. Clearing the reclaim state at the same time stops the
    // sweep from confusing the session just ended with the one starting.
    rememberTabSession(id);
    setReclaimAsrSessionId(null);
    dispatchCaption({ kind: 'reset' });
    setHiddenSeqs(new Set());
    setElapsedMs(0);
    const ok = await projects.attachAsrSession(id, sourceLang, targetLang);
    setStartingSession(false);
    if (!ok) {
      setSessionId(null);
      return;
    }
    setMicActive(true);
  };

  // Ending the session flushes whatever audio is still buffered (so the last
  // few words of a sentence aren't lost) and files that transcript under the
  // session. Nothing is sent to the AI here: a summary costs a model call, so
  // it happens only when the operator asks for one from the session history.
  const stopSessionAndMic = async (): Promise<Caption[]> => {
    // Disable the "End Session" button immediately, before the await below —
    // otherwise a second click fires a duplicate flush.
    setEndingSession(true);
    const flushed = await capture.flush();
    setMicActive(false);
    // The flushed caption arrives too late for the reducer to have re-rendered
    // this component, so it is folded in by hand.
    const sessionCaptions: Caption[] = flushed
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
    setEndingSession(false);
    setSessionId(null);
    setPaused(false);
    // Stopped properly, so there is nothing left for a future reload to
    // reclaim — and leaving it behind would make the next load try to close
    // a session that is already closed.
    forgetTabSession();
    setReclaimAsrSessionId(null);
    // The last sentences must be on the record before the operator moves on —
    // finishing a project prices what the database holds.
    await projects.flushCaptions();
    await projects.detachAsrSession();
    return sessionCaptions;
  };

  const isSessionActive = !!sessionId && micActive;

  // Deliberately wider than isSessionActive, which is false during the two
  // windows where a switch would do the most damage: after startSessionAndMic
  // has attached a session but before the mic is up, and while
  // stopSessionAndMic is flushing the last sentence. `paused` is not an
  // escape either — a paused session still owns its websocket and its
  // caption sequence.
  const micLocked = sessionId !== null || micActive || startingSession || endingSession;

  // Ticks the elapsed-time clock once a second while actually recording;
  // freezes (clears the interval) the moment the session pauses or ends, so
  // the displayed duration always matches time actually captured. The ref
  // tracks the last tick's wall-clock time so a delta is added rather than
  // a fixed 1000ms, keeping the clock accurate even if a tab is throttled.
  useEffect(() => {
    if (!isSessionActive || paused) {
      elapsedTickRef.current = null;
      return;
    }
    elapsedTickRef.current = Date.now();
    const id = setInterval(() => {
      const now = Date.now();
      const last = elapsedTickRef.current ?? now;
      elapsedTickRef.current = now;
      setElapsedMs((prev) => prev + (now - last));
    }, 1000);
    return () => clearInterval(id);
  }, [isSessionActive, paused]);

  // "This tab is still here." Without it a session whose browser vanished —
  // a refresh, a crash, a closed laptop — stays open in the database forever,
  // and an open session is billed up to `now`: a mid-meeting refresh added
  // real money to the project's estimate for every hour nobody noticed.
  //
  // Runs while a session exists, INCLUDING while paused: a paused session is
  // still owned by this tab, and another tab must not decide it is dead.
  useEffect(() => {
    if (!sessionId) return;
    void projects.touchSession(sessionId);
    const id = setInterval(() => void projects.touchSession(sessionId), SESSION_HEARTBEAT_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `projects` is
    // rebuilt on every render; depending on it would restart the interval
    // constantly. The session id is what actually decides what to write.
  }, [sessionId]);

  // Streaming partials are the earliest evidence of a person speaking —
  // earlier than a closed caption, which needs a pause to finish. Read during
  // render because that is when a new partial arrives.
  if (capture.partialSource || capture.partialTarget) lastSpeechAtRef.current = Date.now();

  useEffect(() => {
    if (!isSessionActive) return;
    const id = setInterval(() => {
      const startedAt = sessionStartedAtRef.current;
      if (startedAt === null) return;
      const reason = autoStopReason({
        startedAt,
        lastSpeechAt: lastSpeechAtRef.current,
        now: Date.now()
      });
      if (!reason) return;
      // Set before the await so the banner explains the stop that is already
      // under way, rather than appearing after the screen has gone quiet.
      setAutoStopped(reason);
      void stopSessionAndMic();
    }, AUTO_STOP_CHECK_MS);
    return () => clearInterval(id);
  }, [isSessionActive]);

  // Running total for the header badge: finished sessions come off the project
  // record, the session recording right now comes out of the live caption
  // buffer. Sampled on a timer, so a long meeting isn't recounting every word
  // on every caption.
  const liveCost = useLiveProjectCost(projects.currentProject, allCaptions, sessionId);

  // On-demand summary for one recorded session, from the transcript kept with
  // it. Opens the popup straight away so the operator watches it fill in.
  const summarizeSession = async (session: ProjectSession) => {
    if (!session.endedAt) return;
    if (projects.summarizingIds.has(session.asrSessionId)) return;
    // Captions for an ended session are fetched on demand — the history list
    // holds only counts, so a project with fifty meetings still opens fast.
    const transcripts = await projects.loadSessionTranscript(session.asrSessionId);
    if (transcripts.length === 0) return;

    setSummarySessionId(session.id);
    setSummarizingSince(Date.now());
    await projects.markSessionSummarizing(session.asrSessionId);
    const items = transcripts.map((c) => ({ source_text: c.sourceText, target_text: c.targetText }));
    try {
      // The server checks this against the approval table before spending a
      // single token on the summary.
      const accessToken = await getAccessToken();
      const res = await fetch('/api/gemini/summarize', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {})
        },
        body: JSON.stringify({ items }),
        signal: AbortSignal.timeout(REPORT_WAIT_TIMEOUT_MS)
      });
      const data = (await res.json()) as { summary?: string; items?: number };
      await projects.saveSessionSummary(session.asrSessionId, data.summary ?? '', data.items ?? items.length);
    } catch {
      // An AI failure never loses the transcript — the session keeps it, and
      // the operator can ask again.
      await projects.saveSessionSummary(session.asrSessionId, '', items.length);
    } finally {
      setSummarizingSince(null);
    }
  };

  const handleRequestFinishProject = async () => {
    // Captured before the stop clears it: the bill prices per session, so it
    // has to be told which session the returned captions belong to.
    const lastAsrSessionId = sessionId;
    const captionsForProject = await stopSessionAndMic();
    const finished = await projects.finishProject(captionsForProject, lastAsrSessionId);
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
  // Terms go into the project's own list; shared lists are read-only here and
  // are maintained from the Supabase dashboard.
  const handleGlossaryAdd = (section: GlossarySection, term: string, equivalent: string) => {
    void glossaryState.addTerm(section, term, equivalent);
  };

  const handleGlossaryAddMany = (incoming: GlossarySections) => {
    void glossaryState.addTerms(incoming);
  };

  const handleGlossaryRemove = (section: GlossarySection, term: string) => {
    void glossaryState.removeTerm(section, term);
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
    const nextText = editDraft.trim();
    dispatchCaption({ kind: 'edit', seq: editingSeq, targetText: nextText });
    if (sessionId) void projects.editCaption(sessionId, editingSeq, nextText);
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

  // The escape hatch when storage is refusing writes: whatever is still in
  // memory leaves the browser as a file the operator controls.
  const downloadProjectBackup = () => {
    const payload = JSON.stringify(
      { exportedAt: new Date().toISOString(), projects: [...projects.activeProjects, ...projects.endedProjects] },
      null,
      2
    );
    const blob = new Blob([payload], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `backup-projects-${new Date().toISOString().slice(0, 10)}.json`;
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
  const isDarkCaption = config.captionTheme === 'dark';

  // ── Rolling caption stack ────────────────────────────────────────────────
  // Song-lyric behaviour: one row per utterance with the sentence being
  // spoken on the BOTTOM line, finished ones climbing a row each time and
  // fading as they go, oldest off the top.
  //
  // Everything hangs off ONE number: which utterance owns the bottom row. A
  // live partial belongs to the utterance after the newest committed one —
  // the capture hook hands out one seq per closed caption, in order, and an
  // utterance with nothing at all in it never takes a number — so that seq is
  // knowable before the caption exists. Giving the live row that identity is
  // what makes a caption closing a NON-event for the stack: the row keeps its
  // identity while its text firms up from partial to final. Deriving the rows
  // from "is a partial in flight" instead is what made the stack sometimes
  // stand still and sometimes jump — the two states disagree about how many
  // rows history gets.
  const newestSeq = allCaptions.length > 0 ? allCaptions[allCaptions.length - 1].seq : -1;
  const activeSeq = activeUtteranceSeq(newestSeq, hasPartial);

  const captionRows = useMemo(
    () =>
      buildCaptionRows({
        lines: captions,
        activeSeq,
        liveText: capture.partialTarget,
        hasPartial,
        rows: CAPTION_ROWS
      }),
    [captions, activeSeq, hasPartial, capture.partialTarget]
  );

  // The slide is measured, not predicted. Each row is keyed by its utterance,
  // so React MOVES the same node up the stack, and the animation is simply
  // "you were there, you are here now, cover the difference". Nothing about
  // the caption pipeline can talk it into a shift that did not happen, or out
  // of one that did — which is what every earlier attempt at this got wrong.
  const rowNodesRef = useRef(new Map<string, HTMLDivElement>());
  const rowTopsRef = useRef(new Map<string, number>());
  // The animation currently playing for each row, if any — so a shift that
  // lands before the previous one finishes can be handled deliberately
  // instead of by accident.
  const rowAnimsRef = useRef(new Map<string, Animation>());
  const [captionDebug] = useState(() => {
    try {
      return window.localStorage.getItem('captionStackDebug') === '1';
    } catch {
      return false;
    }
  });

  // The translateY a row is rendering RIGHT NOW, mid-animation or not.
  // getComputedStyle reports the live interpolated value regardless of how
  // many keyframes are involved, so this is the one place both 2D and 3D
  // transform matrices need reading (a translate3d keyframe on some engines
  // computes to matrix3d instead of matrix).
  const currentTranslateY = (node: HTMLElement): number => {
    try {
      const transform = getComputedStyle(node).transform;
      if (!transform || transform === 'none' || typeof DOMMatrixReadOnly === 'undefined') return 0;
      return new DOMMatrixReadOnly(transform).m42;
    } catch {
      return 0;
    }
  };

  useLayoutEffect(() => {
    const previousTops = rowTopsRef.current;
    const nextTops = new Map<string, number>();
    rowNodesRef.current.forEach((node, key) => nextTops.set(key, node.offsetTop));
    rowTopsRef.current = nextTops;
    if (previousTops.size === 0) return; // first paint: the stack arrived, it did not move

    const moves: string[] = [];
    nextTops.forEach((top, key) => {
      const node = rowNodesRef.current.get(key);
      if (!node || typeof node.animate !== 'function') return;
      // A row that was already on screen slides from where it was; a row that
      // is new to the stack rides in from just under the bottom edge.
      const from = previousTops.get(key) ?? top + node.offsetHeight;
      let delta = from - top;

      // Rapid, back-to-back sentences close faster than one 220ms slide can
      // finish, so the next shift for this row lands while its animation from
      // the PREVIOUS shift is still running. `node.animate()` again here
      // would start a second animation on the same property — WAAPI has the
      // newer one replace the older wholesale, so the row would cut straight
      // from wherever it visually was to this shift's theoretical start point,
      // an instant jump that reads as a skip. Reading the live transform
      // before cancelling makes the new animation continue from exactly where
      // the eye last saw the row, no matter how many shifts have piled up.
      const running = rowAnimsRef.current.get(key);
      if (running?.playState === 'running') {
        delta = currentTranslateY(node);
        running.cancel();
      }
      if (delta === 0) return;

      moves.push(`${key}: ${from}→${top}`);
      const anim = node.animate(
        [{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }],
        { duration: 220, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }
      );
      rowAnimsRef.current.set(key, anim);
      anim.addEventListener('finish', () => {
        if (rowAnimsRef.current.get(key) === anim) rowAnimsRef.current.delete(key);
      });
    });

    // Switched on with `localStorage.captionStackDebug = '1'` (then reload).
    // The stack has now been rebuilt several times off reports of it "not
    // sliding sometimes", and guessing has cost more than measuring would
    // have: this prints what the rows actually were, and what actually moved.
    if (captionDebug) {
      // eslint-disable-next-line no-console
      console.debug(
        '[caption-stack]',
        captionRows.map((row) => `${row.key}:${JSON.stringify(row.text.slice(0, 24))}`).join(' | '),
        moves.length > 0 ? `moved ${moves.join(', ')}` : 'no movement'
      );
    }
  }, [captionRows, captionDebug]);

  // Read live off the project record so the popup fills itself in the moment
  // the summary lands, rather than holding a stale copy of the session.
  const summarySession = projects.currentProject?.sessions.find((s) => s.id === summarySessionId) ?? null;

  if (projects.loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 text-slate-500 text-sm">
        กำลังโหลดโปรเจกต์…
      </div>
    );
  }

  // ── No project selected: the picker is the whole screen, as it always was ──
  if (!projects.currentProject) {
    return (
      <>
        <ProjectPicker
          activeProjects={projects.activeProjects}
          canCreateProject={projects.canCreateProject}
          onSelect={(id) => void projects.selectProject(id)}
          onCreate={(name) => void projects.createProject(name)}
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
          onSummarize={summarizeSession}
          onViewSummary={(session) => setSummarySessionId(session.id)}
          onClose={() => setShowSessionHistory(false)}
        />
      )}
      {summarySession && (
        <SessionSummaryModal
          project={projects.currentProject}
          session={summarySession}
          isSummarizing={projects.summarizingIds.has(summarySession.asrSessionId)}
          summarizingSince={summarizingSince}
          onSummarize={summarizeSession}
          onClose={() => setSummarySessionId(null)}
          onOpen={(s) => void projects.loadSessionTranscript(s.asrSessionId)}
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
              <span className="font-bold text-sm text-slate-900 tracking-tight leading-none">Live Translation</span>
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
            <LiveCostBadge cost={liveCost} isRecording={isSessionActive} />
          </div>
        </div>

        <div className="flex items-center gap-2 sm:gap-3">
          <span className="hidden sm:block text-xs font-semibold text-slate-700 truncate max-w-48" title={userEmail}>
            {userEmail}
          </span>

          {/* The record control itself now lives in the middle of the screen;
              this corner is reserved for the operator's own account. */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setProfileOpen((v) => !v)}
              className={`w-9 h-9 rounded-full border overflow-hidden flex items-center justify-center transition-all ${
                profileOpen
                  ? 'border-pink-200 ring-2 ring-pink-100 text-[#DE5C8E] bg-pink-50'
                  : 'bg-slate-100 border-slate-200 text-slate-500 hover:text-[#DE5C8E] hover:bg-slate-200'
              }`}
              title={userEmail}
              aria-label="โปรไฟล์ผู้ใช้"
              aria-expanded={profileOpen}
            >
              {userPicture ? (
                <img src={userPicture} alt="" className="w-full h-full object-cover" />
              ) : (
                <User className="w-4.5 h-4.5" />
              )}
            </button>
            {profileOpen && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setProfileOpen(false)} />
                <div className="absolute right-0 top-11 z-40 w-64 bg-white border border-slate-200 rounded-xl shadow-lg p-3.5">
                  <div className="flex items-center gap-2.5">
                    {userPicture ? (
                      <img src={userPicture} alt="" className="w-9 h-9 rounded-full shrink-0" />
                    ) : (
                      <div className="w-9 h-9 rounded-full bg-slate-100 border border-slate-200 flex items-center justify-center text-slate-400 shrink-0">
                        <User className="w-4 h-4" />
                      </div>
                    )}
                    <div className="min-w-0">
                      <div className="text-xs font-bold text-slate-800 truncate">{userEmail}</div>
                      {userFullName && (
                        <div className="text-[11px] text-slate-400 truncate">{userFullName}</div>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleSignOut}
                    className="mt-3 pt-3 border-t border-slate-100 w-full flex items-center gap-2 text-xs font-semibold text-slate-600 hover:text-red-600 transition-colors"
                  >
                    <LogOut className="w-3.5 h-3.5" />
                    ออกจากระบบ
                  </button>
                </div>
              </>
            )}
          </div>
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
        <LiveCostBadge cost={liveCost} isRecording={isSessionActive} />
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

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1.5">ธีมคำบรรยาย (Caption Theme)</label>
                  <div className="grid grid-cols-2 gap-1.5">
                    <button
                      type="button"
                      onClick={() => setConfig((c) => ({ ...c, captionTheme: 'light' }))}
                      className={`flex items-center justify-center gap-1.5 py-2 px-1 rounded-lg text-[11px] font-bold border transition-all ${
                        (config.captionTheme ?? 'light') === 'light'
                          ? 'border-[#DE5C8E] ring-2 ring-pink-100 bg-white text-slate-800'
                          : 'border-slate-200 bg-slate-50 text-slate-500 hover:bg-white'
                      }`}
                    >
                      <span className="w-3.5 h-3.5 rounded-full bg-white border border-slate-300 text-black flex items-center justify-center text-[8px] font-black">A</span>
                      <span>ตัวดำพื้นขาว</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfig((c) => ({ ...c, captionTheme: 'dark' }))}
                      className={`flex items-center justify-center gap-1.5 py-2 px-1 rounded-lg text-[11px] font-bold border transition-all ${
                        config.captionTheme === 'dark'
                          ? 'border-[#DE5C8E] ring-2 ring-pink-100 bg-white text-slate-800'
                          : 'border-slate-200 bg-slate-50 text-slate-500 hover:bg-white'
                      }`}
                    >
                      <span className="w-3.5 h-3.5 rounded-full bg-black text-white flex items-center justify-center text-[8px] font-black">A</span>
                      <span>ตัวขาวพื้นดำ</span>
                    </button>
                  </div>
                </div>

                {/* Microphone picker. Locked for the whole of a session —
                    pausing does not unlock it, because switching device
                    reconnects the capture pipeline and would cut the meeting
                    mid-sentence. */}
                <div>
                  <label htmlFor="mic-device" className="block text-xs font-bold text-slate-700 mb-1.5">
                    ไมโครโฟนที่ใช้อัดเสียง (Microphone)
                  </label>
                  <select
                    id="mic-device"
                    value={micDeviceId ?? ''}
                    onChange={(e) => handleSelectMicDevice(e.target.value)}
                    disabled={micLocked}
                    title={
                      micLocked
                        ? 'เปลี่ยนไมโครโฟนระหว่าง session ไม่ได้ — จบ session นี้ก่อน'
                        : 'เลือกไมโครโฟนที่จะใช้อัดเสียงใน session ถัดไป'
                    }
                    className="w-full p-2.5 text-xs bg-slate-50 border border-slate-200 rounded-lg outline-none focus:bg-white focus:border-[#DE5C8E] font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <option value="">ไมโครโฟนเริ่มต้นของเบราว์เซอร์</option>
                    {micDevices.map((device, index) => (
                      <option key={device.deviceId} value={device.deviceId}>
                        {deviceLabel(device, index)}
                      </option>
                    ))}
                  </select>
                  {/* Ranked by urgency, not by state: a session recording on
                      the WRONG microphone is the one thing the operator has to
                      hear about immediately, even while the picker is locked. */}
                  {capture.deviceFallback ? (
                    <p className="mt-1 text-[11px] text-amber-600 font-semibold">
                      เปิดไมโครโฟนที่เลือกไว้ไม่ได้ — กำลังอัดด้วยไมโครโฟนเริ่มต้นของเครื่องแทน
                    </p>
                  ) : micLocked ? (
                    <p className="mt-1 text-[11px] text-slate-400">
                      เปลี่ยนไมโครโฟนได้เมื่อจบ session แล้วเท่านั้น
                    </p>
                  ) : micDeviceMissing ? (
                    <p className="mt-1 text-[11px] text-amber-600">
                      ไม่พบไมโครโฟนที่เคยเลือกไว้ — session ถัดไปจะใช้ไมโครโฟนเริ่มต้นแทน
                    </p>
                  ) : null}
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
                      checked={config.showPrevious === true}
                      onChange={(e) => setConfig((c) => ({ ...c, showPrevious: e.target.checked }))}
                      className="rounded text-[#DE5C8E] focus:ring-[#DE5C8E] w-4 h-4"
                    />
                    <span>แสดงคำแปลย้อนหลัง</span>
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
              <DictionaryManager
                sections={glossary}
                sharedLists={glossaryState.sharedLists}
                subscribedIds={glossaryState.subscribedIds}
                onToggleList={(id) => void glossaryState.toggleList(id)}
                disabled={false}
                onAdd={handleGlossaryAdd}
                onAddMany={handleGlossaryAddMany}
                onRemove={handleGlossaryRemove}
                isOwnTerm={glossaryState.isOwnTerm}
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
          {projects.persistError && (
            <div className="shrink-0 flex items-start gap-2.5 m-3 p-3 bg-rose-50 border border-rose-300 rounded-xl text-rose-800 text-xs leading-relaxed">
              <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="font-bold">บันทึกข้อมูลไม่สำเร็จ — การประชุมนี้อาจไม่ถูกเก็บไว้</p>
                <p className="mt-0.5">
                  {projects.persistError.reason === 'auth'
                    ? 'เซสชันหมดอายุหรือไม่มีสิทธิ์บันทึก กรุณาเข้าสู่ระบบอีกครั้ง'
                    : projects.persistError.reason === 'network'
                    ? 'เชื่อมต่อฐานข้อมูลไม่ได้ กรุณาตรวจสอบอินเทอร์เน็ต แล้วดาวน์โหลดสำรองไว้ก่อน'
                    : projects.persistError.reason === 'quota'
                    ? 'พื้นที่จัดเก็บในเบราว์เซอร์เต็ม กรุณาดาวน์โหลดสำรองไว้'
                    : projects.persistError.reason === 'unavailable'
                    ? 'เบราว์เซอร์นี้ปิดการจัดเก็บข้อมูลไว้ กรุณาดาวน์โหลดสำรองก่อนปิดหน้านี้'
                    : 'เกิดข้อผิดพลาดที่ไม่รู้จัก กรุณาดาวน์โหลดสำรองก่อนปิดหน้านี้'}
                </p>
              </div>
              <button
                onClick={downloadProjectBackup}
                className="shrink-0 px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white rounded-lg font-semibold flex items-center gap-1.5"
              >
                <Download className="w-3.5 h-3.5" />
                <span>ดาวน์โหลดสำรอง</span>
              </button>
            </div>
          )}

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

          {/* ─────────────────────────────────────────────────────────────
              LIVE SUBTITLE — pinned to the top edge. Two-line mode pages the
              way broadcast subtitles do: a caption that outgrows the block
              restarts from the word that no longer fitted. Rolling mode
              instead keeps one line per sentence, newest on the bottom line
              and older ones fading upwards out of the block. Either way
              the box holds ONE fixed height for a given display setting:
              nothing that happens while someone speaks may resize it.
          ────────────────────────────────────────────────────────────── */}
          <div className="shrink-0 px-3 pt-3 sm:px-6 sm:pt-4">
            <div
              className={`relative w-full max-w-5xl mx-auto rounded-2xl border shadow-sm px-6 py-6 sm:px-10 sm:py-[28.8px] text-left overflow-hidden transition-colors ${
                isDarkCaption ? 'bg-black border-slate-700' : 'bg-white border-slate-200'
              }`}
            >
              {latestCaption && !isEditingBox && !hasPartial && (
                <div className="absolute top-2.5 right-2.5 flex items-center gap-1">
                  <button
                    onClick={() => handleCopyItem(latestCaption)}
                    className={`p-1.5 rounded-md transition-all ${
                      isDarkCaption
                        ? 'text-slate-500 hover:text-white hover:bg-white/10'
                        : 'text-slate-400 hover:text-slate-700 hover:bg-slate-100'
                    }`}
                    title="คัดลอกข้อความ"
                  >
                    {copiedSeq === latestCaption.seq ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                  </button>
                  <button
                    onClick={() => startEditing(latestCaption)}
                    className={`p-1.5 rounded-md transition-all ${
                      isDarkCaption
                        ? 'text-slate-500 hover:text-white hover:bg-white/10'
                        : 'text-slate-400 hover:text-slate-700 hover:bg-slate-100'
                    }`}
                    title="แก้ไขคำแปล"
                  >
                    <Edit2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}

              {/* Every slot below is ALWAYS mounted and every one of them is
                  locked to its own line count, so the box is exactly as tall
                  as the display settings demand and not one pixel more. The
                  states that used to replace the content — the idle hint and
                  the edit form — now sit on top of it instead, because a
                  box that resized under a speaker would shove the whole page
                  around mid-sentence. */}
              {config.showOriginal && (
                <SubtitleText
                  text={boxSourceText}
                  maxLines={1}
                  className={`text-base sm:text-lg mb-2 ${
                    isDarkCaption
                      ? hasPartial ? 'text-slate-600' : 'text-slate-400'
                      : hasPartial ? 'text-slate-300' : 'text-slate-400'
                  }`}
                />
              )}
              {config.showPrevious ? (
                <div className="relative overflow-hidden">
                  {/* Keyed by utterance, so a line that climbs is the SAME
                      node in a new place — which is what lets the animation
                      measure the move instead of guessing it. The fade belongs
                      to the slot, not to the sentence: a line dims by
                      climbing, the way a lyric does, and the transition makes
                      that dimming travel with the slide. */}
                  {captionRows.map((row, index) => {
                    const isLive = index === CAPTION_ROWS - 1;
                    return (
                      <div
                        key={row.key}
                        ref={(node) => {
                          const nodes = rowNodesRef.current;
                          if (node) {
                            nodes.set(row.key, node);
                          } else {
                            nodes.delete(row.key);
                            // The row is gone for good once it falls off the
                            // top of the stack — nothing will ever animate it
                            // again, so its Animation handle would otherwise
                            // just sit in the map for the rest of the session.
                            rowAnimsRef.current.get(row.key)?.cancel();
                            rowAnimsRef.current.delete(row.key);
                          }
                        }}
                        // One line tall, in CSS, from the very first paint:
                        // leading-snug is a 1.375 line-height, so 1.375em of
                        // this element's own font size IS one line. Letting
                        // the row measure its own height instead (the way the
                        // paged caption does) leaves it briefly the wrong size
                        // while that measurement lands — and a stack whose
                        // geometry moves under the animation is a slide that
                        // sometimes plays and sometimes does not.
                        className={`${boxTextSizeClass(config.fontSize)} leading-snug overflow-hidden`}
                        style={{
                          height: '1.375em',
                          opacity: 1 - (CAPTION_ROWS - 1 - index) * 0.35,
                          transition: 'opacity 220ms ease-out'
                        }}
                      >
                        <SubtitleText
                          text={isLive ? row.text || 'กำลังแปล…' : row.text}
                          maxLines={1}
                          reserveLines={false}
                          // The live line follows the speaker (newest words
                          // win); a finished one is read from its start.
                          overflow={isLive ? 'page' : 'clip'}
                          className={`${boxTextSizeClass(config.fontSize)} leading-snug tracking-tight ${
                            isLive && !row.text
                              ? `font-normal ${isDarkCaption ? 'text-slate-600' : 'text-slate-300'}`
                              : `font-bold ${isDarkCaption ? 'text-white' : 'text-black'}`
                          }`}
                        />
                      </div>
                    );
                  })}
                </div>
              ) : (
                <SubtitleText
                  text={boxTargetText || 'กำลังแปล…'}
                  maxLines={2}
                  className={`${boxTextSizeClass(config.fontSize)} leading-snug tracking-tight ${
                    boxTargetText
                      ? `font-bold ${isDarkCaption ? 'text-white' : 'text-black'}`
                      : `font-normal ${isDarkCaption ? 'text-slate-600' : 'text-slate-300'}`
                  }`}
                />
              )}
              {/* The last MEASURED latency, kept on screen. Blanking it for
                  the whole of the next sentence (the old `!hasPartial` rule)
                  left it visible only in the gap between utterances — which
                  in continuous speech is never, so it read as broken. */}
              {config.showLatency && (
                <span
                  className={`mt-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-mono text-[10px] border ${
                    latestCaption?.latencyMs ? '' : 'invisible'
                  } ${
                    isDarkCaption
                      ? 'bg-white/5 text-slate-400 border-slate-700'
                      : 'bg-slate-100 text-slate-500 border-slate-200'
                  }`}
                >
                  <Zap className="w-3 h-3 text-amber-500" />
                  <span>{latestCaption?.latencyMs ?? 0}ms</span>
                </span>
              )}

              {!latestCaption && !hasPartial && (
                <div
                  className={`absolute inset-0 rounded-2xl flex flex-col items-center justify-center text-center px-6 ${
                    isDarkCaption ? 'bg-black text-slate-500' : 'bg-white text-slate-400'
                  }`}
                >
                  <div className={`font-bold text-sm ${isDarkCaption ? 'text-slate-300' : 'text-slate-700'}`}>
                    พร้อมรับเสียงจากไมโครโฟน
                  </div>
                  <p className="text-xs leading-relaxed mt-1">
                    กดปุ่มไมโครโฟนวงกลมกลางจอ จากนั้นพูดใส่ไมโครโฟนเพื่อทำการแปลภาษาแบบเรียลไทม์
                  </p>
                </div>
              )}

              {isEditingBox && (
                <div
                  className={`absolute inset-0 rounded-2xl flex flex-col justify-center gap-2 px-4 py-3 sm:px-8 overflow-y-auto ${
                    isDarkCaption ? 'bg-black' : 'bg-white'
                  }`}
                >
                  <label className={`text-xs font-bold ${isDarkCaption ? 'text-slate-300' : 'text-slate-600'}`}>
                    คำแปล:
                  </label>
                  <input
                    type="text"
                    autoFocus
                    value={editDraft}
                    onChange={(e) => setEditDraft(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && saveEdit()}
                    className="w-full p-2 text-base font-bold text-black border border-slate-300 rounded-lg outline-none focus:border-[#DE5C8E]"
                  />
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={saveEdit}
                      className="px-3.5 py-1.5 text-xs text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg font-semibold flex items-center gap-1.5 shadow-xs transition-all"
                    >
                      <Check className="w-3.5 h-3.5" />
                      <span>บันทึก</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingSeq(null)}
                      className="px-3.5 py-1.5 text-xs text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg font-medium transition-all"
                    >
                      ยกเลิก
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* ─────────────────────────────────────────────────────────────
              RECORD CONTROL — the one big target, dead centre of the screen.
          ────────────────────────────────────────────────────────────── */}
          <div className="flex-1 flex flex-col items-center justify-center gap-4 p-4 min-h-0">
            <button
              onClick={isSessionActive ? stopSessionAndMic : startSessionAndMic}
              disabled={capture.status === 'starting' || endingSession || startingSession}
              aria-label={isSessionActive ? 'จบ Session (หยุดอัดเสียง)' : 'เริ่ม Session (อัดเสียง)'}
              title={isSessionActive ? 'จบ Session' : 'เริ่ม Session'}
              className={`relative w-28 h-28 sm:w-36 sm:h-36 rounded-full flex items-center justify-center transition-all shadow-lg ring-8 disabled:opacity-60 disabled:cursor-not-allowed ${
                isSessionActive
                  ? 'bg-rose-600 hover:bg-rose-700 text-white ring-rose-100'
                  : 'bg-[#DE5C8E] hover:bg-[#c94577] text-white ring-pink-100'
              }`}
            >
              {isListening && !paused && (
                <span className="absolute inset-0 rounded-full bg-rose-400/40 animate-ping pointer-events-none" />
              )}
              {isSessionActive ? (
                <MicOff className="relative w-12 h-12 sm:w-14 sm:h-14" />
              ) : (
                <Mic className="relative w-12 h-12 sm:w-14 sm:h-14" />
              )}
            </button>

            <div className="h-5 flex items-center gap-2 text-xs font-semibold text-slate-500">
              {capture.status === 'starting' ? (
                <span>กำลังเริ่ม…</span>
              ) : endingSession ? (
                <span>กำลังปิด Session…</span>
              ) : isSessionActive && paused ? (
                <span className="text-amber-600">พักการถอดความ — กดปุ่มเล่นต่อด้านล่าง</span>
              ) : isListening ? (
                <>
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                  </span>
                  <span className="text-emerald-700">
                    {capture.partialSource ? 'กำลังฟัง…' : 'กำลังรอเสียงพูด — พูดใส่ไมโครโฟนได้ทันที'}
                  </span>
                </>
              ) : (
                <span>กดเพื่อเริ่มอัดเสียงและแปลสด</span>
              )}
            </div>

            {/* Why the session stopped on its own. Shown until the next one
                starts: a session that ends by itself while nobody is looking
                would otherwise be indistinguishable from one that crashed. */}
            {autoStopped && !isSessionActive && (
              <div className="max-w-sm px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-[11px] text-amber-800 text-center leading-relaxed">
                {autoStopped === 'idle' ? (
                  <>
                    ปิด session อัตโนมัติ เพราะไม่มีเสียงพูดเข้ามานานเกิน{' '}
                    {Math.round(IDLE_STOP_MS / 60_000)} นาที — บทสนทนาที่บันทึกไว้ยังอยู่ครบ
                    กดเริ่ม session ใหม่เพื่อบันทึกต่อได้
                  </>
                ) : (
                  <>
                    ปิด session อัตโนมัติ เพราะใช้งานครบเวลาสูงสุดต่อหนึ่ง session แล้ว —
                    บทสนทนาที่บันทึกไว้ยังอยู่ครบ กดเริ่ม session ใหม่เพื่อบันทึกต่อได้
                  </>
                )}
              </div>
            )}

            {isSessionActive && (
              <div
                className="flex items-center gap-1.5 font-mono text-sm font-bold text-slate-700 tabular-nums"
                title="เวลาที่บันทึกไปแล้วใน session นี้"
              >
                <span className={`w-2 h-2 rounded-full ${paused ? 'bg-amber-500' : 'bg-rose-500 animate-pulse'}`} />
                <span>{formatElapsed(elapsedMs)}</span>
              </div>
            )}

            <div className="flex items-center gap-2">
              {sessionId && (
                <button
                  onClick={() => setPaused((p) => !p)}
                  title={paused ? 'เล่นต่อ' : 'พักการถอดความ'}
                  className="px-2.5 py-1.5 text-xs text-slate-700 bg-white hover:bg-slate-50 border border-slate-200 rounded-lg font-semibold transition-all flex items-center gap-1.5 shadow-2xs"
                >
                  {paused ? <Play className="w-3.5 h-3.5 text-slate-500" /> : <Pause className="w-3.5 h-3.5 text-slate-500" />}
                  <span>{paused ? 'เล่นต่อ' : 'พัก'}</span>
                </button>
              )}
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
                className="p-1.5 text-slate-400 hover:text-rose-600 rounded-lg hover:bg-rose-50 transition-all disabled:opacity-30"
                title="ล้างประวัติข้อความทั้งหมด"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* ─────────────────────────────────────────────────────────────
              HISTORY — collapsed by default so the subtitle box above stays
              the primary view. Captions run together as paragraphs of
              continuous speech rather than one card per utterance; the full
              edit/hide/copy tooling still reaches every caption, through the
              toolbar that follows the cursor.
          ────────────────────────────────────────────────────────────── */}
          {captions.length > 0 && (
            <div className="border-t border-slate-200 bg-white shrink-0">
              <button
                onClick={() => setShowAllHistory((v) => !v)}
                className="w-full flex items-center justify-between px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
              >
                <span>ประวัติทั้งหมด</span>
                {showAllHistory ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </button>
              {showAllHistory && (
                <div
                  ref={transcriptScrollRef}
                  onMouseLeave={() => setHoveredSeq(null)}
                  className="max-h-64 overflow-y-auto px-4 pt-2 pb-3.5 border-t border-slate-100"
                >
                  {/* A zero-height sticky row, so the toolbar floats over the
                      prose at the top of the scroller. Inline controls would
                      reflow the paragraph every time the cursor moved. */}
                  <div className="sticky top-0 z-10 h-0 flex justify-end pointer-events-none">
                    {hoveredItem && editingSeq === null && (
                      <div className="pointer-events-auto flex items-center gap-1 bg-white/95 backdrop-blur-sm border border-slate-200 rounded-lg shadow-sm px-1.5 py-1">
                        <span className="font-mono text-[10px] text-slate-400 px-0.5">
                          {new Date(hoveredItem.ts * 1000).toLocaleTimeString()}
                        </span>
                        {config.showLatency && hoveredItem.latencyMs ? (
                          <span className="inline-flex items-center gap-0.5 font-mono text-[10px] text-slate-600">
                            <Zap className="w-3 h-3 text-amber-500" />
                            <span>{hoveredItem.latencyMs}ms</span>
                          </span>
                        ) : null}
                        <button
                          onClick={() => handleCopyItem(hoveredItem)}
                          className="p-1 text-slate-400 hover:text-slate-700 rounded-md hover:bg-slate-100 transition-all"
                          title="คัดลอกข้อความ"
                        >
                          {copiedSeq === hoveredItem.seq ? (
                            <Check className="w-3.5 h-3.5 text-emerald-600" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                        </button>
                        <button
                          onClick={() => startEditing(hoveredItem)}
                          className="p-1 text-slate-400 hover:text-slate-700 rounded-md hover:bg-slate-100 transition-all"
                          title="แก้ไขคำแปล"
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => hideItem(hoveredItem.seq)}
                          className="p-1 text-slate-400 hover:text-rose-600 rounded-md hover:bg-rose-50 transition-all"
                          title="ซ่อนรายการนี้ (ไม่ลบจากรายงานสรุป)"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="space-y-4 pt-1.5">
                    {historyParagraphs.map((paragraph) => (
                      <div key={paragraph.key} className="space-y-1">
                        <div className="font-mono text-[10px] text-slate-400">
                          {new Date(paragraph.startTs * 1000).toLocaleTimeString()}
                        </div>

                        {config.showOriginal && (
                          <p className="text-xs text-slate-500 font-medium leading-relaxed">
                            {paragraph.items
                              .map((i) => i.sourceText)
                              .filter(Boolean)
                              .join(' ')}
                          </p>
                        )}

                        {/* A div rather than a p: an open editor is a block
                            element and cannot legally nest inside a paragraph. */}
                        <div
                          className={`${textSizeClass(config.fontSize)} font-bold text-black leading-relaxed tracking-tight`}
                        >
                          {paragraph.items.map((item) => {
                            // Editing the latest caption happens in the box
                            // above, not duplicated here.
                            const isEditing = editingSeq === item.seq && item.seq !== latestCaption?.seq;
                            if (isEditing) {
                              return (
                                <div
                                  key={item.seq}
                                  className="my-2 p-3.5 bg-amber-50/90 border border-amber-300 ring-2 ring-amber-200 rounded-xl space-y-2.5"
                                >
                                  {/* Original text has no re-transcription command in
                                      this pipeline — it's corrected by re-speaking, not typed. */}
                                  <div>
                                    <label className="text-xs font-bold text-slate-600 block mb-1">
                                      ประโยคต้นฉบับ (แก้ไขไม่ได้):
                                    </label>
                                    <p className="w-full p-2.5 text-xs font-normal bg-slate-100 border border-slate-200 rounded-lg text-slate-500">
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
                                      className="w-full p-2.5 text-xs bg-white border border-slate-300 rounded-lg font-bold text-black outline-none focus:border-[#DE5C8E]"
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
                              );
                            }
                            return (
                              <span
                                key={item.seq}
                                onMouseEnter={() => setHoveredSeq(item.seq)}
                                title={item.isEdited ? 'แก้ไขแล้ว' : undefined}
                                className={`rounded px-0.5 -mx-0.5 transition-colors ${
                                  hoveredSeq === item.seq ? 'bg-amber-100' : ''
                                } ${
                                  item.isEdited ? 'underline decoration-dotted decoration-amber-400 underline-offset-4' : ''
                                }`}
                              >
                                {item.targetText || <span className="text-slate-400 font-normal">กำลังแปล…</span>}{' '}
                              </span>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

        </main>
      </div>
    </div>
  );
}
