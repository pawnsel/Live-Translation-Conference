import { PROTOCOL_VERSION } from './protocol';

export type GlossarySection = 'thai_corrections' | 'protected_terms' | 'person_names';

let counter = 0;

export interface BuiltCommand {
  frame: Record<string, unknown>;
  id: string;
}

/**
 * Command payloads are STRICT server-side: an unknown field is a
 * bad_request, not an ignored extra. Each helper below therefore sends the
 * documented fields and nothing else.
 */
export function buildCommand(type: string, session: string, data: unknown, id?: string): BuiltCommand {
  const commandId = id ?? `c-${Date.now().toString(36)}-${(counter += 1)}`;
  return {
    id: commandId,
    frame: {
      v: PROTOCOL_VERSION,
      type,
      session,
      // Epoch SECONDS — the backend parses this through the same model as
      // every other frame.
      ts: Date.now() / 1000,
      id: commandId,
      data,
    },
  };
}

export const setPaused = (session: string, paused: boolean) =>
  buildCommand('control.set_paused', session, { paused });

export const setLanguages = (session: string, source: string, target: string) =>
  buildCommand('control.set_languages', session, { source, target });

export const setMode = (session: string, mode: 'stream' | 'chunk') =>
  buildCommand('control.set_mode', session, { mode });

export const setGate = (session: string, minWords: number, minIntervalMs: number) =>
  buildCommand('control.set_gate', session, { min_words: minWords, min_interval_ms: minIntervalMs });

export const glossaryAdd = (session: string, section: GlossarySection, abbr: string, full: string) =>
  buildCommand('control.glossary_add', session, { section, abbr, full });

export const glossaryRemove = (session: string, section: GlossarySection, abbr: string) =>
  buildCommand('control.glossary_remove', session, { section, abbr });

export const glossaryReload = (session: string) => buildCommand('control.glossary_reload', session, {});

export const reportStart = (session: string) => buildCommand('control.report_start', session, {});

export const reportStop = (session: string) => buildCommand('control.report_stop', session, {});

export const ping = (session: string) => buildCommand('control.ping', session, {});
