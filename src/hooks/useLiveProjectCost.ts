import { useEffect, useRef, useState } from 'react';
import { Project, TranscriptItem } from '../types';
import { ZERO_COST, ceilCents, type CostBreakdown } from '../billing/geminiCost';
import { projectCost } from '../billing/projectCost';

/** How often the header badge re-prices the project. The dominant term is
 *  audio minutes, which grows smoothly and predictably, so sampling a couple
 *  of seconds apart costs nothing in accuracy and saves recounting every word
 *  of a long meeting on every caption. */
export const LIVE_COST_REFRESH_MS = 2000;

export interface LiveProjectCost extends CostBreakdown {
  /** `total`, rounded up to whole cents — what the badge shows. */
  displayCost: number;
}

function withDisplay(cost: CostBreakdown): LiveProjectCost {
  return { ...cost, displayCost: ceilCents(cost.total) };
}

/** What the project's bill would say if it were closed right now — the same
 *  function the closing bill calls, so the badge and the bill agree. */
export function liveProjectCost(
  project: Project | undefined,
  liveTranscripts: TranscriptItem[],
  liveAsrSessionId: string | null,
  now: number = Date.now()
): LiveProjectCost {
  if (!project) return withDisplay(ZERO_COST);
  return withDisplay(projectCost(project, { transcripts: liveTranscripts, asrSessionId: liveAsrSessionId, now }));
}

/** Same figure, sampled on a timer rather than recomputed on every render. */
export function useLiveProjectCost(
  project: Project | undefined,
  liveTranscripts: TranscriptItem[],
  liveAsrSessionId: string | null,
  refreshMs: number = LIVE_COST_REFRESH_MS
): LiveProjectCost {
  // Read through a ref so the interval always sees the newest captions
  // without the timer restarting each time one arrives.
  const latest = useRef({ project, liveTranscripts, liveAsrSessionId });
  latest.current = { project, liveTranscripts, liveAsrSessionId };

  const [cost, setCost] = useState<LiveProjectCost>(() =>
    liveProjectCost(project, liveTranscripts, liveAsrSessionId)
  );

  useEffect(() => {
    const sample = () => {
      const next = liveProjectCost(
        latest.current.project,
        latest.current.liveTranscripts,
        latest.current.liveAsrSessionId
      );
      setCost((prev) => (prev.total === next.total ? prev : next));
    };
    // Switching projects must not leave the old project's number on screen
    // for a tick, so this samples immediately as well as on the interval.
    sample();
    const timer = setInterval(sample, refreshMs);
    return () => clearInterval(timer);
  }, [project?.id, refreshMs]);

  return cost;
}
