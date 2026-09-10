import { describe, expect, it } from 'vitest';
import { projectCost, projectTranscripts, sessionCost, type LiveBuffer } from './projectCost';
import { liveSessionCost } from './geminiCost';
import type { Project, ProjectSession, TranscriptItem } from '../types';

const NOW = Date.UTC(2026, 8, 8, 12, 0, 0);

function item(sourceText: string, targetText: string, seq = 1): TranscriptItem {
  return { seq, sourceText, targetText, sourceLang: 'th', targetLang: 'en', ts: 0, latencyMs: 0, isEdited: false };
}

function session(over: Partial<ProjectSession> & { asrSessionId: string }): ProjectSession {
  return {
    id: `sess_${over.asrSessionId}`,
    startedAt: NOW - 60_000,
    endedAt: NOW,
    sourceLang: 'th',
    targetLang: 'en',
    itemCount: 0,
    ...over
  };
}

function project(sessions: ProjectSession[]): Project {
  return { id: 'p1', name: 'P', status: 'active', sessions, transcripts: [], createdAt: 0 };
}

const idle: LiveBuffer = { transcripts: [], asrSessionId: null, now: NOW };

describe('projectCost', () => {
  it('is zero with no project', () => {
    expect(projectCost(undefined, idle).total).toBe(0);
  });

  it('sums every session', () => {
    const p = project([
      session({ asrSessionId: 'a', transcripts: [item('one', 'two')] }),
      session({ asrSessionId: 'b', transcripts: [item('one', 'two')] })
    ]);
    const one = sessionCost(p.sessions[0], idle).total;
    expect(projectCost(p, idle).total).toBeCloseTo(one * 2, 10);
  });

  // The audio charge is per minute of session, so an open session has to keep
  // climbing — otherwise the badge sits still through a whole meeting.
  it('charges an open session up to now', () => {
    const open = session({ asrSessionId: 'live', startedAt: NOW - 120_000, endedAt: undefined });
    const live: LiveBuffer = { transcripts: [], asrSessionId: 'live', now: NOW };
    expect(sessionCost(open, live).liveMinutes).toBeCloseTo(2, 10);

    const later: LiveBuffer = { ...live, now: NOW + 60_000 };
    expect(sessionCost(open, later).liveMinutes).toBeCloseTo(3, 10);
  });

  it('bills the live buffer for the session that owns it', () => {
    const open = session({ asrSessionId: 'live', endedAt: undefined });
    const captions = [item('hello world', 'สวัสดีชาวโลก')];
    const live: LiveBuffer = { transcripts: captions, asrSessionId: 'live', now: NOW };
    expect(sessionCost(open, live).liveTextCost).toBeCloseTo(liveSessionCost(0, captions).liveTextCost, 10);
  });

  // Stopping a session files its captions on the record while the buffer is
  // still in memory. Counting both would double the text charge for the
  // entire meeting.
  it('never bills the same captions twice across the stop', () => {
    const captions = [item('hello world', 'สวัสดีชาวโลก')];
    const p = project([session({ asrSessionId: 'live', transcripts: captions })]);
    const recording: LiveBuffer = { transcripts: captions, asrSessionId: 'live', now: NOW };
    const stopped: LiveBuffer = { transcripts: captions, asrSessionId: null, now: NOW };
    expect(projectCost(p, recording).total).toBeCloseTo(projectCost(p, stopped).total, 10);
  });

  it('ignores sessions recorded before transcripts were kept', () => {
    const p = project([session({ asrSessionId: 'old' })]);
    expect(projectCost(p, idle).liveTextCost).toBe(0);
    expect(projectCost(p, idle).liveAudioCost).toBeGreaterThan(0);
  });

  describe('summary runs', () => {
    const captions = [item('hello world', 'สวัสดีชาวโลก')];

    it('charges the recorded run count', () => {
      const once = project([session({ asrSessionId: 'a', transcripts: captions, summarizeRuns: 1 })]);
      const twice = project([session({ asrSessionId: 'a', transcripts: captions, summarizeRuns: 2 })]);
      expect(projectCost(twice, idle).summaryCost).toBeCloseTo(projectCost(once, idle).summaryCost * 2, 10);
      expect(projectCost(twice, idle).summaryRuns).toBe(2);
    });

    // Sessions written before the counter existed only record whether a
    // summary was attempted, so that is what they are charged for.
    it('falls back to one run for a legacy summarised session', () => {
      const legacy = project([session({ asrSessionId: 'a', transcripts: captions, summary: 'x' })]);
      const counted = project([session({ asrSessionId: 'a', transcripts: captions, summarizeRuns: 1 })]);
      expect(projectCost(legacy, idle).summaryCost).toBeCloseTo(projectCost(counted, idle).summaryCost, 10);
    });

    it('charges a legacy session that was never summarised nothing', () => {
      const never = project([session({ asrSessionId: 'a', transcripts: captions })]);
      expect(projectCost(never, idle).summaryCost).toBe(0);
    });

    // A failed summary is stored as "" and still cost a call.
    it('charges a legacy session whose summary failed', () => {
      const failed = project([session({ asrSessionId: 'a', transcripts: captions, summary: '' })]);
      expect(projectCost(failed, idle).summaryCost).toBeGreaterThan(0);
    });

    // The bug this guards: captions load lazily, one session at a time, so a
    // session the operator summarised can reach the bill with `transcripts`
    // still undefined — after a page reload, or when a project switch
    // resynced from the server. The run count lives on the record and must
    // survive that; reading it off the in-memory transcript made the bill
    // announce "สรุปการประชุม 0 ครั้ง" for a summary that had just run.
    it('reports runs for a session whose captions are not loaded', () => {
      const unloaded = project([
        session({ asrSessionId: 'a', summarizeRuns: 1, summary: 'สรุป', itemCount: 12 })
      ]);
      expect(unloaded.sessions[0].transcripts).toBeUndefined();
      expect(projectCost(unloaded, idle).summaryRuns).toBe(1);
      expect(projectCost(unloaded, idle).summaryCost).toBeGreaterThan(0);
    });

    // Same fact seen from the other side: the live buffer is empty at the
    // moment the project is finished, but the session it belongs to was
    // summarised earlier in the meeting.
    it('reports runs when the live buffer for that session is empty', () => {
      const p = project([session({ asrSessionId: 'live', transcripts: captions, summarizeRuns: 1 })]);
      const emptyBuffer: LiveBuffer = { transcripts: [], asrSessionId: 'live', now: NOW };
      expect(projectCost(p, emptyBuffer).summaryRuns).toBe(1);
    });
  });
});

describe('projectTranscripts', () => {
  it('collects every session’s captions, live buffer included, exactly once', () => {
    const filed = [item('one', 'two', 1)];
    const buffered = [item('three', 'four', 2)];
    const p = project([
      session({ asrSessionId: 'a', transcripts: filed }),
      session({ asrSessionId: 'live', endedAt: undefined })
    ]);
    const live: LiveBuffer = { transcripts: buffered, asrSessionId: 'live', now: NOW };
    expect(projectTranscripts(p, live)).toEqual([...filed, ...buffered]);
  });
});
