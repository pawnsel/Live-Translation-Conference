// GENERATED FILE — DO NOT EDIT.
// Source: server/protocol.py → schemas/protocol.v1.json
// Regenerate:
//   .venv/bin/python scripts/gen_protocol_schema.py
//   .venv/bin/python scripts/gen_protocol_ts.py

export const PROTOCOL_VERSION = 1;


export interface AckPayload {
}

export interface AudioBackpressureFrame {
  data: BackpressurePayload;
  id?: string | null;
  seq?: number | null;
  session: string;
  ts: number;
  type: "audio.backpressure";
  v: number;
}

export interface AudioHelloCommand {
  channels: 1;
  encoding: "pcm_s16le";
  frame_ms: number;
  sample_rate: 16000;
}

export interface AudioHelloFrame {
  data: AudioHelloCommand;
  id?: string | null;
  seq?: number | null;
  session: string;
  ts: number;
  type: "audio.hello";
  v: number;
}

export interface AudioReadyFrame {
  data: AckPayload;
  id?: string | null;
  seq?: number | null;
  session: string;
  ts: number;
  type: "audio.ready";
  v: number;
}

export interface BackpressurePayload {
  level: "normal" | "high";
}

export interface CaptionFinalFrame {
  data: CaptionPayload;
  id?: string | null;
  seq: number;
  session: string;
  ts: number;
  type: "caption.final";
  v: number;
}

export interface CaptionPartialFrame {
  data: CaptionPayload;
  id?: string | null;
  seq: number;
  session: string;
  ts: number;
  type: "caption.partial";
  v: number;
}

export interface CaptionPayload {
  corrected: string;
  latency_ms: number;
  raw: string;
  source_lang: string;
  source_text: string;
  target_lang: string;
  target_text: string;
}

export interface CaptionTargetPartialFrame {
  data: TargetPayload;
  id?: string | null;
  seq: number;
  session: string;
  ts: number;
  type: "caption.target_partial";
  v: number;
}

export interface CaptionTargetUpdateFrame {
  data: TargetPayload;
  id?: string | null;
  seq: number;
  session: string;
  ts: number;
  type: "caption.target_update";
  v: number;
}

export interface ControlAckFrame {
  data: AckPayload;
  id?: string | null;
  seq?: number | null;
  session: string;
  ts: number;
  type: "control.ack";
  v: number;
}

export interface ControlErrorFrame {
  data: ErrorPayload;
  id?: string | null;
  seq?: number | null;
  session: string;
  ts: number;
  type: "control.error";
  v: number;
}

export interface ControlGlossaryAddFrame {
  data: GlossaryAddCommand;
  id?: string | null;
  seq?: number | null;
  session: string;
  ts: number;
  type: "control.glossary_add";
  v: number;
}

export interface ControlGlossaryReloadFrame {
  data: EmptyCommand;
  id?: string | null;
  seq?: number | null;
  session: string;
  ts: number;
  type: "control.glossary_reload";
  v: number;
}

export interface ControlGlossaryRemoveFrame {
  data: GlossaryRemoveCommand;
  id?: string | null;
  seq?: number | null;
  session: string;
  ts: number;
  type: "control.glossary_remove";
  v: number;
}

export interface ControlPingFrame {
  data: EmptyCommand;
  id?: string | null;
  seq?: number | null;
  session: string;
  ts: number;
  type: "control.ping";
  v: number;
}

export interface ControlPongFrame {
  data: AckPayload;
  id?: string | null;
  seq?: number | null;
  session: string;
  ts: number;
  type: "control.pong";
  v: number;
}

export interface ControlReportStartFrame {
  data: EmptyCommand;
  id?: string | null;
  seq?: number | null;
  session: string;
  ts: number;
  type: "control.report_start";
  v: number;
}

export interface ControlReportStopFrame {
  data: EmptyCommand;
  id?: string | null;
  seq?: number | null;
  session: string;
  ts: number;
  type: "control.report_stop";
  v: number;
}

export interface ControlSetGateFrame {
  data: SetGateCommand;
  id?: string | null;
  seq?: number | null;
  session: string;
  ts: number;
  type: "control.set_gate";
  v: number;
}

export interface ControlSetLanguagesFrame {
  data: SetLanguagesCommand;
  id?: string | null;
  seq?: number | null;
  session: string;
  ts: number;
  type: "control.set_languages";
  v: number;
}

export interface ControlSetModeFrame {
  data: SetModeCommand;
  id?: string | null;
  seq?: number | null;
  session: string;
  ts: number;
  type: "control.set_mode";
  v: number;
}

export interface ControlSetPausedFrame {
  data: SetPausedCommand;
  id?: string | null;
  seq?: number | null;
  session: string;
  ts: number;
  type: "control.set_paused";
  v: number;
}

export interface EmptyCommand {
}

export type ErrorCode = "unauthenticated" | "forbidden" | "bad_request" | "not_found" | "conflict" | "rate_limited" | "internal";

export interface ErrorPayload {
  code: ErrorCode;
  message: string;
  retryable: boolean;
}

export interface GateSettings {
  min_interval_ms: number;
  min_words: number;
}

export interface GateStateFrame {
  data: GateSettings;
  id?: string | null;
  seq?: number | null;
  session: string;
  ts: number;
  type: "gate.state";
  v: number;
}

export interface GlossaryAddCommand {
  abbr: string;
  full: string;
  section: "thai_corrections" | "protected_terms" | "person_names";
}

export interface GlossaryRemoveCommand {
  abbr: string;
  section: "thai_corrections" | "protected_terms" | "person_names";
}

export interface GlossarySections {
  person_names: Record<string, string>;
  protected_terms: Record<string, string>;
  thai_corrections: Record<string, string>;
}

export interface GlossaryStateFrame {
  data: GlossaryStatePayload;
  id?: string | null;
  seq?: number | null;
  session: string;
  ts: number;
  type: "glossary.state";
  v: number;
}

export interface GlossaryStatePayload {
  sections: GlossarySections;
}

export interface LanguagesPayload {
  asr_switchable: boolean;
  source_lang: string;
  target_lang: string;
}

export interface ModePayload {
  mode: "stream" | "chunk";
}

export interface PausedPayload {
  paused: boolean;
}

export interface ReportDoneFrame {
  data: ReportDonePayload;
  id?: string | null;
  seq?: number | null;
  session: string;
  ts: number;
  type: "report.done";
  v: number;
}

export interface ReportDonePayload {
  items: Array<ReportItem>;
  started: number;
  summary: string;
}

export interface ReportItem {
  source_text: string;
  target_text: string;
  ts: number;
}

export interface ReportStateFrame {
  data: ReportStatePayload;
  id?: string | null;
  seq?: number | null;
  session: string;
  ts: number;
  type: "report.state";
  v: number;
}

export interface ReportStatePayload {
  active: boolean;
  count: number;
}

export type Role = "operator" | "viewer" | "source";

export interface SessionLanguagesFrame {
  data: LanguagesPayload;
  id?: string | null;
  seq?: number | null;
  session: string;
  ts: number;
  type: "session.languages";
  v: number;
}

export interface SessionModeFrame {
  data: ModePayload;
  id?: string | null;
  seq?: number | null;
  session: string;
  ts: number;
  type: "session.mode";
  v: number;
}

export interface SessionPausedFrame {
  data: PausedPayload;
  id?: string | null;
  seq?: number | null;
  session: string;
  ts: number;
  type: "session.paused";
  v: number;
}

export interface SessionWelcomeFrame {
  data: WelcomePayload;
  id?: string | null;
  seq?: number | null;
  session: string;
  ts: number;
  type: "session.welcome";
  v: number;
}

export interface SetGateCommand {
  min_interval_ms: number;
  min_words: number;
}

export interface SetLanguagesCommand {
  source: string;
  target: string;
}

export interface SetModeCommand {
  mode: "stream" | "chunk";
}

export interface SetPausedCommand {
  paused: boolean;
}

export interface TargetPayload {
  latency_ms: number;
  rev: number;
  target_lang: string;
  target_text: string;
}

export interface WelcomePayload {
  asr_switchable: boolean;
  clients: number;
  gate: GateSettings;
  glossary: GlossaryStatePayload;
  mode: "stream" | "chunk";
  paused: boolean;
  report: ReportStatePayload;
  role: Role;
  source_lang: string;
  target_lang: string;
  v_supported: Array<number>;
}

export type AnyFrame =
  | AudioBackpressureFrame
  | AudioHelloFrame
  | AudioReadyFrame
  | CaptionFinalFrame
  | CaptionPartialFrame
  | CaptionTargetPartialFrame
  | CaptionTargetUpdateFrame
  | ControlAckFrame
  | ControlErrorFrame
  | ControlGlossaryAddFrame
  | ControlGlossaryReloadFrame
  | ControlGlossaryRemoveFrame
  | ControlPingFrame
  | ControlPongFrame
  | ControlReportStartFrame
  | ControlReportStopFrame
  | ControlSetGateFrame
  | ControlSetLanguagesFrame
  | ControlSetModeFrame
  | ControlSetPausedFrame
  | GateStateFrame
  | GlossaryStateFrame
  | ReportDoneFrame
  | ReportStateFrame
  | SessionLanguagesFrame
  | SessionModeFrame
  | SessionPausedFrame
  | SessionWelcomeFrame;

export type FrameType =
  | "audio.backpressure"
  | "audio.hello"
  | "audio.ready"
  | "caption.final"
  | "caption.partial"
  | "caption.target_partial"
  | "caption.target_update"
  | "control.ack"
  | "control.error"
  | "control.glossary_add"
  | "control.glossary_reload"
  | "control.glossary_remove"
  | "control.ping"
  | "control.pong"
  | "control.report_start"
  | "control.report_stop"
  | "control.set_gate"
  | "control.set_languages"
  | "control.set_mode"
  | "control.set_paused"
  | "gate.state"
  | "glossary.state"
  | "report.done"
  | "report.state"
  | "session.languages"
  | "session.mode"
  | "session.paused"
  | "session.welcome";

// Pre-v1 type names and their v1 successors. Migration reference only.
export const LEGACY_TYPE_MAP: Record<string, FrameType> = {
  "ack": "control.ack",
  "connected": "session.welcome",
  "english_partial": "caption.target_partial",
  "english_update": "caption.target_update",
  "final": "caption.final",
  "gate": "gate.state",
  "glossary": "glossary.state",
  "languages": "session.languages",
  "mode": "session.mode",
  "partial": "caption.partial",
  "paused": "session.paused",
  "pong": "control.pong",
  "report": "report.state",
  "report_done": "report.done"
} as const;
