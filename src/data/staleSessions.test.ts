import { describe, expect, it } from 'vitest';
import {
  SESSION_STALE_MS,
  staleSessions,
  withSessionsClosed
} from './staleSessions';

import type { Project, ProjectSession } from '../types';

const NOW = Date.UTC(2026, 8, 10, 12, 0, 0);

function session(over: Partial<ProjectSession> & { id: string; asrSessionId: string }): ProjectSession {
  return {
    startedAt: NOW - 60 * 60_000,
    sourceLang: 'th',
    targetLang: 'en',
    itemCount: 0,
    ...over
  };
}

function project(sessions: ProjectSession[], over: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'ประชุม',
    status: 'active',
    sessions,
    transcripts: [],
    createdAt: NOW - 2 * 60 * 60_000,
    asrSessionId: null,
    ...over
  };
}

describe('staleSessions', () => {
  it('leaves a session whose tab is still reporting alone', () => {
    const live = session({ id: 's1', asrSessionId: 'a', lastSeenAt: NOW - 5_000 });
    expect(staleSessions([project([live])], NOW, null)).toEqual([]);
  });

  it('leaves a session that has only just fallen behind alone', () => {
    const recent = session({ id: 's1', asrSessionId: 'a', lastSeenAt: NOW - SESSION_STALE_MS + 1 });
    expect(staleSessions([project([recent])], NOW, null)).toEqual([]);
  });

  // The case this exists for: the operator pressed refresh mid-meeting.
  it('closes a session whose heartbeat stopped', () => {
    const lastSeenAt = NOW - SESSION_STALE_MS;
    const orphan = session({ id: 's1', asrSessionId: 'a', lastSeenAt });
    expect(staleSessions([project([orphan])], NOW, null)).toEqual([{ id: 's1', endedAt: lastSeenAt }]);
  });

  // Billing an orphan up to the moment it happened to be noticed is what made
  // a refresh cost $158 over a weekend. It ends when the tab did.
  it('ends the session at its last heartbeat, not at the sweep', () => {
    const lastSeenAt = NOW - 3 * 24 * 60 * 60_000;
    const orphan = session({ id: 's1', asrSessionId: 'a', startedAt: lastSeenAt - 60_000, lastSeenAt });
    expect(staleSessions([project([orphan])], NOW, null)[0].endedAt).toBe(lastSeenAt);
  });

  it('ignores sessions that are already closed', () => {
    const done = session({ id: 's1', asrSessionId: 'a', lastSeenAt: NOW - SESSION_STALE_MS, endedAt: NOW - 10 });
    expect(staleSessions([project([done])], NOW, null)).toEqual([]);
  });

  // The console runs in more than one tab. A tab sweeping on load must never
  // close the meeting another tab is recording — and it cannot use a
  // heartbeat to tell, because its own writes are what it would be reading.
  it('never closes the session this tab is recording', () => {
    const mine = session({ id: 's1', asrSessionId: 'mine', lastSeenAt: NOW - SESSION_STALE_MS * 10 });
    expect(staleSessions([project([mine])], NOW, 'mine')).toEqual([]);
  });

  it('still closes another tab’s dead session while this tab records', () => {
    const mine = session({ id: 's1', asrSessionId: 'mine', lastSeenAt: NOW });
    const orphan = session({ id: 's2', asrSessionId: 'other', lastSeenAt: NOW - SESSION_STALE_MS });
    expect(staleSessions([project([mine, orphan])], NOW, 'mine').map((s) => s.id)).toEqual(['s2']);
  });

  // Sessions recorded before heartbeats existed have no lastSeenAt at all.
  // Reading that as "never seen" rather than "always fresh" is what lets the
  // sweep clean them up instead of leaving them open forever.
  it('falls back to the start time for a row written before heartbeats', () => {
    const legacy = session({ id: 's1', asrSessionId: 'a', startedAt: NOW - SESSION_STALE_MS * 2 });
    expect(legacy.lastSeenAt).toBeUndefined();
    expect(staleSessions([project([legacy])], NOW, null)).toEqual([
      { id: 's1', endedAt: NOW - SESSION_STALE_MS * 2 }
    ]);
  });

  it('skips finished projects, whose rows finishProject already settled', () => {
    const orphan = session({ id: 's1', asrSessionId: 'a', lastSeenAt: NOW - SESSION_STALE_MS });
    expect(staleSessions([project([orphan], { status: 'ended' })], NOW, null)).toEqual([]);
  });
});

// The heartbeat alone cannot fix the case it was built for. A tab that
// refreshes leaves a session whose last beat is SECONDS old, so at the moment
// the reloaded page sweeps, that session is correctly not stale — and it would
// have to wait out the whole staleness window before anything closed it.
//
// But the tab that refreshed knows something no heartbeat can express: that
// session was MINE, and I am not recording it any more. sessionStorage
// survives a refresh and dies with the tab, which is exactly that fact.
describe('staleSessions — a session the tab is handing back', () => {
  it('closes a just-refreshed session without waiting out the stale window', () => {
    const fresh = session({ id: 's1', asrSessionId: 'a', lastSeenAt: NOW - 1_000 });
    expect(staleSessions([project([fresh])], NOW, null)).toEqual([]);
    expect(staleSessions([project([fresh])], NOW, null, 'a')).toEqual([
      { id: 's1', endedAt: NOW - 1_000 }
    ]);
  });

  it('still ends it at its last heartbeat, not at the reload', () => {
    const fresh = session({ id: 's1', asrSessionId: 'a', lastSeenAt: NOW - 30_000 });
    expect(staleSessions([project([fresh])], NOW, null, 'a')[0].endedAt).toBe(NOW - 30_000);
  });

  // The tab reclaims the id it remembered, then starts recording again under a
  // new one. If a reclaim could outrank the live session the tab would end its
  // own meeting the moment the sweep ran.
  it('never reclaims the session this tab is recording right now', () => {
    const mine = session({ id: 's1', asrSessionId: 'a', lastSeenAt: NOW - 1_000 });
    expect(staleSessions([project([mine])], NOW, 'a', 'a')).toEqual([]);
  });

  it('leaves other tabs’ live sessions alone', () => {
    const other = session({ id: 's2', asrSessionId: 'other', lastSeenAt: NOW - 1_000 });
    expect(staleSessions([project([other])], NOW, null, 'a')).toEqual([]);
  });

  it('does not resurrect a reclaimed session that is already closed', () => {
    const done = session({ id: 's1', asrSessionId: 'a', lastSeenAt: NOW - 1_000, endedAt: NOW - 500 });
    expect(staleSessions([project([done])], NOW, null, 'a')).toEqual([]);
  });
});

describe('withSessionsClosed', () => {
  it('returns the same array when nothing was closed', () => {
    const projects = [project([session({ id: 's1', asrSessionId: 'a' })])];
    expect(withSessionsClosed(projects, [])).toBe(projects);
  });

  it('stamps the end time onto the matching session only', () => {
    const projects = [
      project([
        session({ id: 's1', asrSessionId: 'a' }),
        session({ id: 's2', asrSessionId: 'b' })
      ])
    ];
    const next = withSessionsClosed(projects, [{ id: 's2', endedAt: NOW }]);
    expect(next[0].sessions[0].endedAt).toBeUndefined();
    expect(next[0].sessions[1].endedAt).toBe(NOW);
  });

  it('leaves projects it did not touch untouched', () => {
    const other = project([session({ id: 'x', asrSessionId: 'x' })], { id: 'p2' });
    const projects = [project([session({ id: 's1', asrSessionId: 'a' })]), other];
    expect(withSessionsClosed(projects, [{ id: 's1', endedAt: NOW }])[1]).toBe(other);
  });
});
