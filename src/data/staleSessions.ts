/** Finding recording sessions whose tab is gone.
 *
 *  A session is opened in the database when recording starts and closed when
 *  the operator stops it. Nothing closed one whose browser simply vanished —
 *  a refresh, a crashed tab, a closed laptop — so it stayed open forever, and
 *  because an open session is billed up to `now` (see billing/projectCost.ts)
 *  a refresh mid-meeting could inflate a project's estimate by a hundred
 *  dollars over a weekend. It also made the session look live: it could not be
 *  summarised, and it blocked switching projects.
 *
 *  The tab that owns a session writes `lastSeenAt` every
 *  SESSION_HEARTBEAT_MS. A session whose heartbeat has stopped for longer
 *  than SESSION_STALE_MS is orphaned, and is closed AT ITS LAST HEARTBEAT —
 *  not at the moment it was noticed, which would bill all the silence in
 *  between.
 *
 *  Pure, so the rule can be tested without a database or a clock.
 */

import type { Project, ProjectSession } from '../types';

/** How often the recording tab announces it is still there. */
export const SESSION_HEARTBEAT_MS = 30_000;

/**
 * How far behind a heartbeat may fall before the session counts as orphaned.
 *
 * Four missed beats. Generous on purpose: the cost of being wrong in one
 * direction is a live meeting cut off by another tab, and in the other it is
 * a stale session lingering a couple more minutes. A background tab can also
 * have its timers throttled by the browser, so a tight threshold would close
 * sessions that are merely in the background rather than gone.
 */
export const SESSION_STALE_MS = 4 * SESSION_HEARTBEAT_MS;

export interface StaleSession {
  /** Row id, for the UPDATE. */
  id: string;
  /** When to record the session as having ended: its last heartbeat. */
  endedAt: number;
}

/**
 * The open sessions in `projects` that nothing is recording any more.
 *
 * Two different kinds of evidence, in strict order of authority:
 *
 * `ownAsrSessionId` — the session THIS tab is recording right now. Excluded
 * by id rather than by its heartbeat, because the tab doing the sweep is the
 * one authority on whether its own session is alive; reading its own beat
 * back could let a write still in flight end its own meeting.
 *
 * `reclaimAsrSessionId` — a session this tab owned BEFORE the page reloaded,
 * remembered in sessionStorage (see storage/tabSession.ts). This is the case
 * the heartbeat alone cannot serve: a tab that refreshes leaves a beat only
 * seconds old, so the reloaded page's sweep correctly finds it fresh, and the
 * session would sit there looking live for the whole staleness window. The
 * reloaded tab knows better — that session was mine and I am not recording it
 * — so it is closed at once. Still at its last heartbeat, never at `now`.
 *
 * Everything else falls back to the heartbeat, which is what covers the cases
 * no tab is left alive to report: a crash, a closed laptop, another machine.
 */
export function staleSessions(
  projects: Project[],
  now: number,
  ownAsrSessionId: string | null,
  reclaimAsrSessionId: string | null = null
): StaleSession[] {
  const stale: StaleSession[] = [];
  for (const project of projects) {
    // A finished project's sessions were all closed by finishProject; an
    // open row there is a bookkeeping leftover, not a live meeting.
    if (project.status !== 'active') continue;
    for (const session of project.sessions) {
      if (session.endedAt !== undefined) continue;
      // Checked first: a reclaim must never outrank a session that is live
      // right now, or a tab that reloaded and started recording again under a
      // new id could end the meeting it just began.
      if (ownAsrSessionId !== null && session.asrSessionId === ownAsrSessionId) continue;

      // A row written before heartbeats existed has no lastSeenAt. Its start
      // is the last moment it is known to have been alive, which is the same
      // question this is asking.
      const lastSeen = session.lastSeenAt ?? session.startedAt;
      const handedBack =
        reclaimAsrSessionId !== null && session.asrSessionId === reclaimAsrSessionId;
      if (!handedBack && now - lastSeen < SESSION_STALE_MS) continue;
      stale.push({ id: session.id, endedAt: lastSeen });
    }
  }
  return stale;
}

/** Applies the closures to an in-memory project list, so the console does not
 *  have to re-fetch to stop showing a dead session as live. */
export function withSessionsClosed(projects: Project[], closed: StaleSession[]): Project[] {
  if (closed.length === 0) return projects;
  const endedById = new Map(closed.map((s) => [s.id, s.endedAt]));
  return projects.map((project) => {
    if (!project.sessions.some((s) => endedById.has(s.id))) return project;
    return {
      ...project,
      sessions: project.sessions.map((session: ProjectSession) => {
        const endedAt = endedById.get(session.id);
        return endedAt === undefined ? session : { ...session, endedAt };
      })
    };
  });
}
