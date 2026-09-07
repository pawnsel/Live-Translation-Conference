import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AnyFrame,
  ErrorPayload,
  GateSettings,
  LanguagesPayload,
  ModePayload,
  PausedPayload,
  ReportStatePayload,
  WelcomePayload,
} from './protocol';
import type { BuiltCommand } from './commands';
import { describeCloseCode, describeErrorCode } from './closeCodes';

export interface AsrSocketState {
  status: 'idle' | 'connecting' | 'open' | 'closed';
  welcome: WelcomePayload | null;
  error: string | null;
  sessionGone: boolean;
  /** True once consecutive retryable-close reconnects have been exhausted
   *  without a single successful open. A 4404 (the backend explicitly
   *  forgetting a session) is not the only way a session becomes
   *  unreachable — a hard kill or a crash closes the socket with 1006
   *  ("abnormal closure", no close frame at all), which this hook's own
   *  fallback treats as retryable. Retrying THAT forever, at a fixed
   *  interval, with the operator never told it stopped working, is the
   *  exact failure this flag exists to end. */
  giveUp: boolean;
}

const RECONNECT_DELAY_MS = 2000;
// After this many consecutive failed reconnects with no successful open in
// between, stop retrying automatically and surface `giveUp` instead —
// roughly 10s of silence is long enough to know this isn't a blip.
const MAX_RECONNECT_ATTEMPTS = 5;

function toWsUrl(backendUrl: string, path: string): string {
  const url = new URL(backendUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = path;
  url.search = '';
  return url.toString().replace(/\/$/, '');
}

export function useAsrSocket(opts: {
  backendUrl: string;
  sessionId: string | null;
  token: string | null;
  onFrame: (frame: AnyFrame) => void;
}) {
  const { backendUrl, sessionId, token } = opts;
  const [state, setState] = useState<AsrSocketState>({
    status: 'idle',
    welcome: null,
    error: null,
    sessionGone: false,
    giveUp: false,
  });

  const socketRef = useRef<WebSocket | null>(null);
  const onFrameRef = useRef(opts.onFrame);
  onFrameRef.current = opts.onFrame;

  useEffect(() => {
    if (!sessionId || !token) return;

    // This effect re-runs once per NEW session (sessionId/token change) as
    // well as on cleanup/remount, but `connect()` below is ALSO called on
    // every in-session reconnect attempt via the retry `setTimeout`. Reset
    // the exposed state here, at the effect's own top level, so it fires
    // exactly once per new session — never on a same-session reconnect,
    // which must NOT wipe `welcome` (a caption feed re-showing "loading"
    // every couple of seconds during a blip would be its own regression).
    //
    // Without this, `giveUp` is a sticky `s.giveUp || exhausted` that can
    // only ever go true -> true across sessions (the give-up cleanup then
    // fires once per page load, not once per dead backend), and `welcome`
    // survives from the old session, leaving stale `report.active` state
    // that silently defeats the auto-report-start effect in Admin.tsx.
    setState({ status: 'connecting', welcome: null, error: null, sessionGone: false, giveUp: false });

    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let consecutiveFailures = 0;

    const connect = () => {
      if (disposed) return;
      setState((s) => ({ ...s, status: 'connecting' }));

      // The token goes in Sec-WebSocket-Protocol so it stays out of proxy
      // logs, browser history and Referer headers.
      const socket = new WebSocket(toWsUrl(backendUrl, `/ws/${sessionId}`), ['bearer', token]);
      socketRef.current = socket;

      socket.onopen = () => {
        if (disposed) return;
        // A real open proves the backend is reachable again — a retry budget
        // from a past, unrelated outage must not count against a fresh one.
        consecutiveFailures = 0;
        setState((s) => ({ ...s, status: 'open', error: null }));
      };

      socket.onmessage = (event) => {
        if (disposed || typeof event.data !== 'string') return;
        let frame: AnyFrame;
        try {
          frame = JSON.parse(event.data) as AnyFrame;
        } catch {
          return;
        }

        // `welcome` is the live projection of server-owned state. Every
        // broadcast below folds into it, because the UI renders from it and
        // never writes it optimistically. A state frame arriving before
        // welcome is dropped: there is no partial WelcomePayload to build on,
        // and inventing one would put made-up languages on screen.
        const fold = (patch: Partial<WelcomePayload>) =>
          setState((s) => (s.welcome ? { ...s, welcome: { ...s.welcome, ...patch } } : s));

        switch (frame.type) {
          case 'session.welcome':
            setState((s) => ({ ...s, welcome: frame.data as WelcomePayload }));
            break;
          case 'session.languages': {
            const d = frame.data as LanguagesPayload;
            fold({ source_lang: d.source_lang, target_lang: d.target_lang, asr_switchable: d.asr_switchable });
            break;
          }
          case 'session.paused':
            fold({ paused: (frame.data as PausedPayload).paused });
            break;
          case 'session.mode':
            fold({ mode: (frame.data as ModePayload).mode });
            break;
          case 'gate.state':
            fold({ gate: frame.data as GateSettings });
            break;
          case 'report.state':
            fold({ report: frame.data as ReportStatePayload });
            break;
          case 'control.error': {
            const payload = frame.data as ErrorPayload;
            setState((s) => ({ ...s, error: describeErrorCode(payload.code, payload.message) }));
            break;
          }
          default:
            break;
        }

        // Every frame is forwarded, including unknown types — the consumer
        // decides. Ignoring what we don't recognise is required by the
        // protocol, and dropping it here would hide new backend frames.
        onFrameRef.current(frame);
      };

      socket.onclose = (event) => {
        if (disposed) return;
        const described = describeCloseCode(event.code);
        // A 4404 session id can only fail again. Retrying it would spin
        // forever against a backend that restarted. A retryable close (e.g.
        // 1006, "abnormal closure" — what a killed or crashed process
        // produces, since there is no time to send a proper close frame) is
        // different: it MIGHT be a blip, so it earns retries — but only up
        // to a budget. Retrying forever at a fixed interval with nothing
        // ever telling the operator it stopped working is the same class of
        // failure as mishandling 4404, just reached through 1006 instead.
        const exhausted = described.retryable && ++consecutiveFailures >= MAX_RECONNECT_ATTEMPTS;
        setState((s) => ({
          ...s,
          status: 'closed',
          sessionGone: described.sessionGone,
          giveUp: s.giveUp || exhausted,
          error: event.code === 1000 ? s.error : exhausted ? 'ติดต่อเซิร์ฟเวอร์ ASR ไม่ได้หลายครั้งติดต่อกัน — เซิร์ฟเวอร์อาจไม่ทำงาน กรุณาตรวจสอบแล้วเริ่ม Session ใหม่' : described.message,
        }));
        if (described.retryable && !exhausted) {
          retryTimer = setTimeout(connect, RECONNECT_DELAY_MS);
        }
      };
    };

    connect();

    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [backendUrl, sessionId, token]);

  const send = useCallback((built: BuiltCommand) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(built.frame));
  }, []);

  return { ...state, send };
}
