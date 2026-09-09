/** The glossary for one project: which shared lists it uses, its own terms,
 *  and the single merged GlossarySections that the capture hook and the
 *  dictionary UI consume.
 *
 *  Lives here rather than in Admin.tsx, which is long enough already.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { emptyGlossary, type GlossarySection, type GlossarySections } from '../glossary';
import { mergeGlossary } from '../data/glossaryMerge';
import { createGlossaryRepo, type GlossaryList, type GlossaryRepo } from '../data/glossaryRepo';
import { toPersistError } from '../data/persistError';
import { supabase } from '../lib/supabase';

export interface UseGlossaryOptions {
  /** Injected in tests. Defaults to the live Supabase-backed repo. */
  repo?: GlossaryRepo;
  /** Null when no project is open — the glossary is per project now. */
  projectId?: string | null;
}

const defaultRepo = () => createGlossaryRepo(supabase as never);

export function useGlossary({ repo, projectId = null }: UseGlossaryOptions = {}) {
  const activeRepo = useMemo(() => repo ?? defaultRepo(), [repo]);

  const [sharedLists, setSharedLists] = useState<GlossaryList[]>([]);
  const [ownList, setOwnList] = useState<GlossaryList | null>(null);
  const [subscribedIds, setSubscribedIds] = useState<Set<string>>(() => new Set());
  /** Terms per list id, kept unmerged so a subscription can be toggled off
   *  without another round trip. */
  const [termsByList, setTermsByList] = useState<Record<string, GlossarySections>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    if (!projectId) {
      setSharedLists([]);
      setOwnList(null);
      setSubscribedIds(new Set());
      setTermsByList({});
      setLoading(false);
      return;
    }
    try {
      const [shared, projectLists] = await Promise.all([
        activeRepo.listSharedLists(),
        activeRepo.loadProjectLists(projectId)
      ]);
      // Every shared list is offered in the picker, but only the subscribed
      // ones plus the project's own list need their terms.
      const ids = [
        ...projectLists.subscribed.map((l) => l.id),
        ...(projectLists.own ? [projectLists.own.id] : [])
      ];
      const terms = await activeRepo.loadTerms(ids);
      if (seq !== loadSeq.current) return;

      setSharedLists(shared);
      setOwnList(projectLists.own);
      setSubscribedIds(new Set(projectLists.subscribed.map((l) => l.id)));
      setTermsByList(terms);
      setError(null);
    } catch (caught) {
      if (seq === loadSeq.current) setError(toPersistError(caught).message);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [activeRepo, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Shared lists in a stable order, then the project's own — the precedence
   *  mergeGlossary expects. */
  const sections: GlossarySections | null = useMemo(() => {
    if (!projectId) return null;
    const shared = sharedLists
      .filter((list) => subscribedIds.has(list.id))
      .map((list) => termsByList[list.id] ?? emptyGlossary());
    const own = (ownList && termsByList[ownList.id]) || emptyGlossary();
    return mergeGlossary(shared, own);
  }, [projectId, sharedLists, subscribedIds, termsByList, ownList]);

  const guard = useCallback(async (mutate: () => Promise<void>) => {
    try {
      await mutate();
      setError(null);
    } catch (caught) {
      setError(toPersistError(caught).message);
    }
  }, []);

  const addTerm = useCallback(
    async (section: GlossarySection, term: string, translation: string) => {
      if (!ownList) return;
      const listId = ownList.id;
      await guard(async () => {
        await activeRepo.addTerm(listId, section, term, translation);
        setTermsByList((prev) => {
          const list = prev[listId] ?? emptyGlossary();
          return {
            ...prev,
            [listId]: { ...list, [section]: { ...list[section], [term.trim()]: translation.trim() } }
          };
        });
      });
    },
    [activeRepo, guard, ownList]
  );

  /** Writes a whole GlossarySections in one statement — what a JSON import
   *  produces. One round trip rather than one per term, and one failure
   *  rather than a glossary left half-written. */
  const addTerms = useCallback(
    async (incoming: GlossarySections) => {
      if (!ownList) return;
      const listId = ownList.id;
      const entries = (Object.keys(incoming) as GlossarySection[]).flatMap((section) =>
        Object.entries(incoming[section] ?? {}).map(([term, translation]) => ({
          section,
          term,
          translation
        }))
      );
      if (entries.length === 0) return;

      await guard(async () => {
        await activeRepo.addTerms(listId, entries);
        setTermsByList((prev) => {
          const list = prev[listId] ?? emptyGlossary();
          const next = { ...list };
          for (const entry of entries) {
            next[entry.section] = {
              ...next[entry.section],
              [entry.term.trim()]: entry.translation.trim()
            };
          }
          return { ...prev, [listId]: next };
        });
      });
    },
    [activeRepo, guard, ownList]
  );

  const removeTerm = useCallback(
    async (section: GlossarySection, term: string) => {
      if (!ownList) return;
      const listId = ownList.id;
      await guard(async () => {
        await activeRepo.removeTerm(listId, section, term);
        setTermsByList((prev) => {
          const list = prev[listId] ?? emptyGlossary();
          const next = { ...list[section] };
          delete next[term];
          return { ...prev, [listId]: { ...list, [section]: next } };
        });
      });
    },
    [activeRepo, guard, ownList]
  );

  /** `sections` is the merge of every subscribed shared list plus the
   *  project's own, overlaid last (see mergeGlossary), so a delete button
   *  bound only to `removeTerm` (which always targets `ownList`) silently
   *  no-ops on a term that actually came from a shared list — the DELETE
   *  matches zero rows, and the next merge just puts it right back. Callers
   *  use this to tell the two apart before offering a delete control. */
  const isOwnTerm = useCallback(
    (section: GlossarySection, term: string): boolean => {
      if (!ownList) return false;
      return Object.prototype.hasOwnProperty.call(termsByList[ownList.id]?.[section] ?? {}, term);
    },
    [ownList, termsByList]
  );

  const toggleList = useCallback(
    async (listId: string) => {
      if (!projectId) return;
      const on = subscribedIds.has(listId);
      await guard(async () => {
        if (on) {
          await activeRepo.unsubscribeList(projectId, listId);
          setSubscribedIds((prev) => {
            const next = new Set(prev);
            next.delete(listId);
            return next;
          });
        } else {
          await activeRepo.subscribeList(projectId, listId);
          // Terms for a newly subscribed list have never been fetched.
          const terms = await activeRepo.loadTerms([listId]);
          setTermsByList((prev) => ({ ...prev, ...terms }));
          setSubscribedIds((prev) => new Set(prev).add(listId));
        }
      });
    },
    [activeRepo, guard, projectId, subscribedIds]
  );

  return {
    sections,
    sharedLists,
    subscribedIds,
    ownList,
    loading,
    error,
    addTerm,
    addTerms,
    removeTerm,
    isOwnTerm,
    toggleList,
    reload: load
  };
}
