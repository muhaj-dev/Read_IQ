// Drives the Root Cause block on Weak Topics.
//
// The traversal makes several network round-trips, so it runs after paint and
// never blocks the topic list — the screen is useful immediately and deepens
// when the graph answers.

import { useEffect, useRef, useState } from 'react';

import { findRootCauses, type RootCause } from '@/lib/root-cause';

/** How many missed topics to analyse. Each one costs a query round-trip. */
const MAX_TOPICS = 4;

type State = {
  causes: RootCause[];
  loading: boolean;
  /** How many topics the analysis actually ran on — the denominator the
   *  cards quote. Capped at MAX_TOPICS, so it can be fewer than were missed. */
  analyzed: number;
};

export function useRootCauses(missedTopics: string[]): State {
  const [state, setState] = useState<State>({ causes: [], loading: false, analyzed: 0 });

  // Re-run only when the actual topics change, not on every render.
  const key = missedTopics.slice(0, MAX_TOPICS).join('|');
  const lastKey = useRef<string | null>(null);

  useEffect(() => {
    if (!key || key === lastKey.current) return;
    lastKey.current = key;

    const controller = new AbortController();
    const topics = key.split('|');
    setState({ causes: [], loading: true, analyzed: topics.length });

    findRootCauses(topics, controller.signal)
      .then((causes) => {
        if (!controller.signal.aborted)
          setState({ causes, loading: false, analyzed: topics.length });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setState({ causes: [], loading: false, analyzed: topics.length });
      });

    return () => controller.abort();
  }, [key]);

  return state;
}
