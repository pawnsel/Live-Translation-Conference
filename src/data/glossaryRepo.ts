/** Every statement against glossary lists, terms and subscriptions.
 *
 *  Shared lists are read-only here by design: they have no write policy in
 *  the database, so an addTerm against one fails with 42501 rather than
 *  silently doing nothing. Terms are addressed by LIST id, not project id —
 *  the caller already knows which list it is writing to, and a lookup on
 *  every keystroke would be waste.
 */

import { emptyGlossary, type GlossarySection, type GlossarySections } from '../glossary';
import type { QueryClient } from './queryClient';
import { toPersistError } from './persistError';

export interface GlossaryList {
  id: string;
  name: string;
  description: string | null;
  scope: 'shared' | 'project';
  isDefault: boolean;
}

interface ListRow {
  id: string;
  name: string;
  description: string | null;
  scope: 'shared' | 'project';
  is_default: boolean;
}

interface TermRow {
  list_id: string;
  section: GlossarySection;
  term: string;
  translation: string;
}

const LIST_COLUMNS = 'id, name, description, scope, is_default';

export interface GlossaryRepo {
  listSharedLists(): Promise<GlossaryList[]>;
  loadProjectLists(projectId: string): Promise<{ own: GlossaryList | null; subscribed: GlossaryList[] }>;
  loadTerms(listIds: string[]): Promise<Record<string, GlossarySections>>;
  subscribeList(projectId: string, listId: string): Promise<void>;
  unsubscribeList(projectId: string, listId: string): Promise<void>;
  addTerm(listId: string, section: GlossarySection, term: string, translation: string): Promise<void>;
  removeTerm(listId: string, section: GlossarySection, term: string): Promise<void>;
}

function unwrap<T>(result: { data: unknown; error: unknown }): T {
  if (result.error) throw toPersistError(result.error);
  return result.data as T;
}

function toList(row: ListRow): GlossaryList {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    scope: row.scope,
    isDefault: row.is_default
  };
}

export function createGlossaryRepo(client: QueryClient): GlossaryRepo {
  return {
    async listSharedLists() {
      const rows = unwrap<ListRow[]>(
        await client
          .from('glossary_lists')
          .select(LIST_COLUMNS)
          .eq('scope', 'shared')
          .order('created_at', { ascending: true })
      );
      return (rows ?? []).map(toList);
    },

    async loadProjectLists(projectId) {
      const ownRows = unwrap<ListRow[]>(
        await client
          .from('glossary_lists')
          .select(LIST_COLUMNS)
          .eq('project_id', projectId)
          .eq('scope', 'project')
      );

      const subscriptionRows = unwrap<{ glossary_lists: ListRow }[]>(
        await client
          .from('project_glossary_lists')
          .select(`list_id, glossary_lists(${LIST_COLUMNS})`)
          .eq('project_id', projectId)
      );

      return {
        // The trigger guarantees exactly one, but null beats a crash.
        own: ownRows?.length ? toList(ownRows[0]) : null,
        subscribed: (subscriptionRows ?? [])
          .map((row) => row.glossary_lists)
          .filter(Boolean)
          .filter((list) => list.scope === 'shared')
          .map(toList)
      };
    },

    async loadTerms(listIds) {
      if (listIds.length === 0) return {};

      const rows = unwrap<TermRow[]>(
        await client
          .from('glossary_terms')
          .select('list_id, section, term, translation')
          .in('list_id', listIds)
      );

      // Every requested list gets an entry even when it has no terms, so
      // callers can index without guarding.
      const byList: Record<string, GlossarySections> = {};
      for (const id of listIds) byList[id] = emptyGlossary();
      for (const row of rows ?? []) {
        (byList[row.list_id] ||= emptyGlossary())[row.section][row.term] = row.translation;
      }
      return byList;
    },

    async subscribeList(projectId, listId) {
      // Upsert: subscribing twice is a no-op, not an error.
      unwrap(
        await client
          .from('project_glossary_lists')
          .upsert({ project_id: projectId, list_id: listId }, { onConflict: 'project_id,list_id' })
      );
    },

    async unsubscribeList(projectId, listId) {
      unwrap(
        await client
          .from('project_glossary_lists')
          .delete()
          .eq('project_id', projectId)
          .eq('list_id', listId)
      );
    },

    async addTerm(listId, section, term, translation) {
      unwrap(
        await client.from('glossary_terms').upsert(
          {
            list_id: listId,
            section,
            // A stray space creates a second, invisible entry that never
            // matches anything the recogniser hears.
            term: term.trim(),
            translation: translation.trim()
          },
          { onConflict: 'list_id,section,term' }
        )
      );
    },

    async removeTerm(listId, section, term) {
      unwrap(
        await client
          .from('glossary_terms')
          .delete()
          .eq('list_id', listId)
          .eq('section', section)
          .eq('term', term)
      );
    }
  };
}
