import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
// ProjectPanel.tsx has NO default export — it exports four named components.
import { BillModal, HistoryPanel, ProjectHeaderBar, ProjectPicker } from '../components/ProjectPanel';
import DictionaryManager from '../components/DictionaryManager';
import SessionBar from '../components/SessionBar';
import CaptionFeed from '../components/CaptionFeed';
import ControlPanel from '../components/ControlPanel';
import { captionsReducer, initialCaptionState, selectCaptions } from '../asr/captions';
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
// Source tokens live 12 h and expiry is re-checked on EVERY audio frame, so a
// capture client that outlives its token is closed mid-stream with 4401. An
// event day can run past 12 h; re-mint at 80% rather than discover this at
// hour twelve of a conference.
const SOURCE_TOKEN_REFRESH_MS = 12 * 3600 * 1000 * 0.8;
// Operator tokens live 12 h too, and `tokenSource.get()` only refreshes once
// 80% of that life has elapsed — calling it more often costs nothing (it
// just returns the cached token) until it's actually time to re-mint. A
// short, minutes-scale poll is therefore both sufficient and more robust
// than one long timer: it re-checks often enough to catch the 80% mark
// promptly, and a short interval is far less exposed to whatever might tear
// an effect down and rebuild it (see the stale-dependency notes below).
const OPERATOR_TOKEN_POLL_MS = 5 * 60 * 1000;

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
  const [config, setConfig] = useState<DisplayConfig>({ fontSize: 'large', showOriginal: true, showLatency: true });
  const [showHistory, setShowHistory] = useState(false);
  const [finishedProject, setFinishedProject] = useState<Project | null>(null);
  const [captionState, dispatchCaption] = useReducer(captionsReducer, initialCaptionState);

  const captions = useMemo(() => selectCaptions(captionState), [captionState]);
  const bootstrapped = useRef(false);

  // `useProjects()` returns a fresh object literal every render, so
  // `detachAsrSession` changes identity on every render too. Effects below
  // need to call it without re-running on every render because of that —
  // hold it in a ref refreshed each render instead of depending on `projects`.
  const detachAsrSessionRef = useRef(projects.detachAsrSession);
  detachAsrSessionRef.current = projects.detachAsrSession;

  // ── Token ────────────────────────────────────────────────────────────────
  useEffect(() => {
    tokenSource
      .get()
      .then(setToken)
      .catch((err: Error) => setTokenError(err.message));
  }, [tokenSource]);

  // `tokenSource.get()` caches internally and only re-mints once 80% of the
  // token's life has passed, but nothing calls `.get()` again unless we ask
  // it to. Without this, the operator token fetched on mount is never
  // refreshed, and it silently expires partway through a conference.
  useEffect(() => {
    const timer = setInterval(() => {
      tokenSource
        .get()
        .then(setToken)
        .catch((err: Error) => setTokenError(err.message));
    }, OPERATOR_TOKEN_POLL_MS);
    return () => clearInterval(timer);
    // `tokenSource` is created with `useMemo(() => createOperatorTokenSource(), [])`
    // above, so it is stable for the life of the component — unlike `projects`
    // (a fresh object every render) and `session` (a fresh parse every poll),
    // both of which have previously defeated a long timer in this file by
    // forcing it to tear down and rebuild before it could ever fire.
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
    // `session?.id` is the only field this effect reads.
  }, [token, session?.id]);

  // ── Control socket ───────────────────────────────────────────────────────
  const onFrame = useCallback((frame: AnyFrame) => {
    dispatchCaption({ kind: 'frame', frame });
    if (frame.type === 'glossary.state') setGlossary((frame.data as { sections: GlossarySections }).sections);
    else if (frame.type === 'session.welcome') setGlossary((frame.data as { glossary: { sections: GlossarySections } }).glossary.sections);
    else if (frame.type === 'report.done') setReport(frame.data as ReportDonePayload);
  }, []);

  const socket = useAsrSocket({ backendUrl: BACKEND_URL, sessionId: session?.id ?? null, token, onFrame });

  useEffect(() => {
    if (!socket.sessionGone) return;
    setSession(null);
    setMicActive(false);
    setSourceToken(null);
    detachAsrSessionRef.current();
  }, [socket.sessionGone]);

  // ── Audio ────────────────────────────────────────────────────────────────
  const capture = useAudioCapture({
    backendUrl: BACKEND_URL,
    sessionId: session?.id ?? null,
    sourceToken,
    active: micActive,
  });

  useEffect(() => {
    if (!micActive || !token || !session) return;
    const timer = setInterval(() => {
      mintSourceToken(BACKEND_URL, session.id, token)
        .then(setSourceToken)
        .catch((err: Error) => setTokenError(err.message));
    }, SOURCE_TOKEN_REFRESH_MS);
    return () => clearInterval(timer);
    // Same reasoning as the health-poll effect above: `session` changes
    // identity on every health poll, which would tear down and rebuild this
    // 9.6 h interval roughly every 5 s — long enough that it would never
    // survive to fire once. Depend on the stable `session?.id` instead.
  }, [micActive, token, session?.id]);

  const toggleMic = async () => {
    if (micActive) {
      setMicActive(false);
      return;
    }
    if (!token || !session) return;
    try {
      setSourceToken(await mintSourceToken(BACKEND_URL, session.id, token));
      setMicActive(true);
    } catch (err) {
      setTokenError((err as Error).message);
    }
  };

  // ── Session actions ──────────────────────────────────────────────────────
  const adopt = async (id: string) => {
    if (!token) return;
    const found = await getSession(BACKEND_URL, token, id);
    setSession(found);
    setCandidates([]);
    if (found) projects.attachAsrSession(found.id, found.source_lang, found.target_lang);
  };

  const create = async () => {
    if (!token) return;
    try {
      const created = await createSession(BACKEND_URL, token);
      setSession(created);
      setCandidates([]);
      dispatchCaption({ kind: 'reset' });
      projects.attachAsrSession(created.id, created.source_lang, created.target_lang);
    } catch (err) {
      setTokenError((err as Error).message);
    }
  };

  const end = async () => {
    if (!token || !session) return;
    await deleteSession(BACKEND_URL, token, session.id);
    setSession(null);
    setMicActive(false);
    setSourceToken(null);
    projects.detachAsrSession();
  };

  // Ending the project also ends the ASR session: a project is durable, the
  // Python session is not, and leaving one running would keep billing a
  // recognizer for an event that is over.
  const finishProject = async () => {
    if (session && token) await deleteSession(BACKEND_URL, token, session.id);
    setSession(null);
    setMicActive(false);
    setSourceToken(null);
    const finished = projects.finishProject(captions);
    dispatchCaption({ kind: 'reset' });
    if (finished) setFinishedProject(finished);
  };

  // ── Export ───────────────────────────────────────────────────────────────
  const download = (name: string, body: string) => {
    const url = URL.createObjectURL(new Blob([body], { type: 'text/plain;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const srtTime = (ms: number) => {
    const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
    const m = String(Math.floor(ms / 60000) % 60).padStart(2, '0');
    const s = String(Math.floor(ms / 1000) % 60).padStart(2, '0');
    return `${h}:${m}:${s},${String(Math.floor(ms % 1000)).padStart(3, '0')}`;
  };

  const exportTranscript = (type: 'txt' | 'srt') => {
    if (captions.length === 0) return;
    if (type === 'txt') {
      const body = captions
        .map((c) => `[${new Date(c.ts * 1000).toLocaleTimeString('th-TH')}]\n${c.sourceText}\n${c.targetText}\n`)
        .join('\n');
      download(`transcript-${Date.now()}.txt`, body);
      return;
    }
    const start = captions[0].ts;
    const body = captions
      .map((c, i) => {
        const from = (c.ts - start) * 1000;
        const to = from + 3000;
        return `${i + 1}\n${srtTime(from)} --> ${srtTime(to)}\n${c.targetText}\n`;
      })
      .join('\n');
    download(`subtitles-${Date.now()}.srt`, body);
  };

  const disabled = socket.status !== 'open';
  const send = socket.send;
  const sid = session?.id ?? '';

  // No project selected: the picker is the whole screen, as it is today.
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
      </>
    );
  }

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 p-4 flex flex-col gap-4">
      <ProjectHeaderBar
        project={projects.currentProject}
        activeSession={projects.activeSession}
        onRequestFinish={finishProject}
        onSwitchProject={projects.clearSelection}
        onOpenHistory={() => setShowHistory(true)}
      />

      {tokenError && <p className="text-sm text-red-400 bg-red-950/40 border border-red-900 rounded p-2">{tokenError}</p>}
      {socket.error && <p className="text-sm text-amber-300 bg-amber-950/40 border border-amber-900 rounded p-2">{socket.error}</p>}

      <SessionBar
        session={session}
        candidates={candidates}
        connecting={socket.status === 'connecting'}
        micActive={micActive}
        micStatus={capture.error ?? (capture.status === 'sending' ? 'กำลังส่งเสียงเข้าเซิร์ฟเวอร์' : '')}
        backpressure={capture.backpressure}
        droppedFrames={capture.droppedFrames}
        onAdopt={adopt}
        onCreate={create}
        onEnd={end}
        onToggleMic={toggleMic}
      />

      <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-4">
        <div className="flex flex-col gap-3">
          <div className="flex gap-2">
            <button onClick={() => exportTranscript('txt')} className="px-3 py-1.5 rounded bg-slate-700 text-sm">
              ส่งออก .TXT
            </button>
            <button onClick={() => exportTranscript('srt')} className="px-3 py-1.5 rounded bg-slate-700 text-sm">
              ส่งออก .SRT
            </button>
          </div>
          <CaptionFeed
            captions={captions}
            interim={captionState.interim?.sourceText ?? null}
            config={config}
            onEdit={(seq, targetText) => dispatchCaption({ kind: 'edit', seq, targetText })}
          />
        </div>

        <div className="flex flex-col gap-6">
          <ControlPanel
            state={socket.welcome}
            disabled={disabled}
            onSetLanguages={(source, target) => send(cmd.setLanguages(sid, source, target))}
            onSetPaused={(paused) => send(cmd.setPaused(sid, paused))}
            onSetGate={(w, ms) => send(cmd.setGate(sid, w, ms))}
            onReport={(start) => send(start ? cmd.reportStart(sid) : cmd.reportStop(sid))}
          />

          <DictionaryManager
            sections={glossary}
            disabled={disabled}
            onAdd={(section: GlossarySection, abbr, full) => send(cmd.glossaryAdd(sid, section, abbr, full))}
            onRemove={(section: GlossarySection, abbr) => send(cmd.glossaryRemove(sid, section, abbr))}
            onReload={() => send(cmd.glossaryReload(sid))}
          />

          <div className="flex flex-col gap-2">
            <label className="text-xs text-slate-400">ขนาดตัวอักษร</label>
            <select
              value={config.fontSize}
              onChange={(e) => setConfig((c) => ({ ...c, fontSize: e.target.value as DisplayConfig['fontSize'] }))}
              className="bg-slate-800 rounded px-2 py-1.5 text-sm"
            >
              <option value="small">เล็ก</option>
              <option value="medium">กลาง</option>
              <option value="large">ใหญ่</option>
              <option value="xlarge">ใหญ่พิเศษ</option>
            </select>
          </div>
        </div>
      </div>

      {report && (
        <div className="p-3 bg-slate-800 rounded">
          <h2 className="text-sm font-semibold mb-2">สรุปช่วงการประชุม</h2>
          <p className="text-sm whitespace-pre-wrap">{report.summary}</p>
        </div>
      )}

      {showHistory && <HistoryPanel projects={projects.endedProjects} onClose={() => setShowHistory(false)} />}
      {finishedProject && <BillModal project={finishedProject} onClose={() => setFinishedProject(null)} />}
    </div>
  );
}
