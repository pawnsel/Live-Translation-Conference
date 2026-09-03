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
}

const RECONNECT_DELAY_MS = 2000;

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
  });

  const socketRef = useRef<WebSocket | null>(null);
  const onFrameRef = useRef(opts.onFrame);
  onFrameRef.current = opts.onFrame;

  useEffect(() => {
    if (!sessionId || !token) return;

    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      if (disposed) return;
      setState((s) => ({ ...s, status: 'connecting' }));

      // The token goes in Sec-WebSocket-Protocol so it stays out of proxy
      // logs, browser history and Referer headers.
      const socket = new WebSocket(toWsUrl(backendUrl, `/ws/${sessionId}`), ['bearer', token]);
      socketRef.current = socket;

      socket.onopen = () => {
        if (disposed) return;
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
        setState((s) => ({
          ...s,
          status: 'closed',
          sessionGone: described.sessionGone,
          error: event.code === 1000 ? s.error : described.message,
        }));
        // A 4404 session id can only fail again. Retrying it would spin
        // forever against a backend that restarted.
        if (described.retryable) {
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
