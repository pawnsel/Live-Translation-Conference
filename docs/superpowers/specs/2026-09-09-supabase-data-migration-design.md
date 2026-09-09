# Supabase data migration — design

Date: 2026-09-09

Moves projects, sessions, transcripts and the glossary out of `localStorage`
and into Supabase Postgres, and replaces the single per-browser glossary with
an org-wide library of reusable lists that each project subscribes to.

Auth is already real (`access_requests` + RLS, see
[`supabase-auth-setup.md`](../../supabase-auth-setup.md)). This is the
remaining half: everything the operator actually produces.

---

## 1. What is being replaced

There is no hardcoded fake data in the app. The "mock" layer is persistence:

| Data | Today | localStorage key |
|---|---|---|
| Projects, nested sessions, transcripts, summaries, bills | `src/storage/projectStore.ts`, `src/hooks/useProjects.ts` | `ai_translate_projects` |
| Selected project id | same | `ai_translate_selected_project` |
| Glossary, 4 sections | `src/glossary.ts` | `ai_translate_glossary` |

`src/storage/projectStore.ts` was written anticipating this change: it is
already an interface with a swappable adapter, and its header comment names
the database phase explicitly.

## 2. Decisions taken

| Question | Decision |
|---|---|
| Project visibility | Private per user — `owner_id = auth.uid()` |
| Glossary scope | Per project, composed from reusable shared lists |
| Glossary list ownership | Shared org-wide, admin-maintained (users select, don't edit) |
| Caption durability | Streamed as each caption closes |
| Existing localStorage data | Start fresh; no migration |
| Transport | Browser → Supabase directly, RLS-enforced |

### Why browser-direct rather than through the Express server

The app already queries Supabase from the browser for `access_requests`, and
RLS is what enforces that correctly. Routing project CRUD through
`server.ts` would duplicate authorisation logic in TypeScript, introduce a
service-role key into the deployment, and put project writes on the same
process that proxies live audio. The server's job is guarding the billed
Gemini key, which it already does. No new server code.

### Why not offline-first

Captions originate from Gemini over the network. A dead connection means
there is nothing to save, so a local queue that syncs later would be real
complexity for a case that cannot occur. A short in-memory retry queue
covers the case that does: a transient blip mid-session.

## 3. Schema

Two enums: `project_status` (`active` | `ended`) and `glossary_section`
(`protected_terms` | `person_names` | `thai_corrections` | `en_th_corrections`,
matching `GlossarySection` in `src/glossary.ts`).

### 3.1 Projects, sessions, transcripts

```
projects
  id             uuid pk
  owner_id       uuid not null default auth.uid() → auth.users on delete cascade
  name           text not null
  status         project_status not null default 'active'
  created_at     timestamptz not null default now()
  ended_at       timestamptz
  auto_finished  boolean not null default false
  asr_session_id text                       -- attached live session, null when detached
  bill           jsonb                      -- ProjectBill, written once at finish

project_sessions
  id                uuid pk
  project_id        uuid not null → projects on delete cascade
  owner_id          uuid not null default auth.uid()
  asr_session_id    text not null
  started_at        timestamptz not null default now()
  ended_at          timestamptz
  source_lang       text not null
  target_lang       text not null
  summary           text
  report_item_count integer
  summarize_runs    integer not null default 0
  unique (project_id, asr_session_id)

transcript_items
  session_id   uuid not null → project_sessions on delete cascade
  seq          integer not null
  owner_id     uuid not null default auth.uid()
  source_text  text not null
  target_text  text not null
  source_lang  text not null
  target_lang  text not null
  ts           timestamptz not null
  latency_ms   integer not null
  is_edited    boolean not null default false
  primary key (session_id, seq)
```

`bill` stays JSONB deliberately: it is a frozen receipt written once when a
project is finished and never queried by field. Everything else is columns.

`summary` keeps its existing three-state meaning, which
`src/components/ProjectPanel.tsx` depends on:

- `null` — nobody has asked for a summary
- `''` — a summary was asked for and the AI call failed
- text — a real summary

`TranscriptItem.ts` is epoch **seconds** in TypeScript (`Date.now() / 1000`)
and `timestamptz` in Postgres. The repo converts at the boundary; nothing
above the repo changes units. The same applies to `startedAt` / `endedAt` /
`createdAt`, which stay epoch milliseconds in TypeScript.

`Project.id` and `ProjectSession.id` become database uuids instead of
`proj_${Date.now()}` / `sess_${Date.now()}`. Both are already typed `string`,
so no consumer changes. `asrSessionId` is unaffected — it stays a
client-generated `local_${Date.now()}` text value, because it names a live
capture session that exists only in the browser and must be known before any
row is written.

### 3.2 Glossary

```
glossary_lists
  id          uuid pk
  name        text not null
  description text
  scope       glossary_scope not null      -- 'shared' | 'project'
  owner_id    uuid                          -- null when shared
  project_id  uuid → projects on delete cascade   -- null when shared
  is_default  boolean not null default false
  created_at  timestamptz not null default now()
  check (scope = 'shared'  and project_id is null     and owner_id is null
      or scope = 'project' and project_id is not null and owner_id is not null)

glossary_terms
  id          uuid pk
  list_id     uuid not null → glossary_lists on delete cascade
  section     glossary_section not null
  term        text not null
  translation text not null
  unique (list_id, section, lower(term))

project_glossary_lists
  project_id uuid → projects on delete cascade
  list_id    uuid → glossary_lists on delete cascade
  primary key (project_id, list_id)
```

One list table, one term table, one join table. A project's own ad-hoc terms
are not a special case: every project owns one `scope='project'` list, so a
term typed mid-meeting has somewhere to go.

That list is created by an `after insert` **trigger** on `projects`, which
also inserts a `project_glossary_lists` row for every `is_default` shared
list. Doing it in the database rather than as a second client call makes it
atomic: there is no window in which a project exists without its own list,
and a client that forgets the second call cannot create one.

**Effective glossary** for a project = terms from every subscribed shared
list, overlaid by terms from the project's own list. The project's own list
wins on a `(section, term)` collision — a local correction must be able to
override the canonical one, or an operator cannot fix a wrong shared term
during a live meeting.

Lists flagged `is_default` are auto-subscribed when a project is created, so
the person-name map is present without anyone selecting it.

### 3.3 Row-level security

A `security definer` helper answers "is this caller approved":

```sql
create function public.is_approved() returns boolean
  language sql security definer stable as $$
    select exists (
      select 1 from public.access_requests
       where id = auth.uid() and status = 'approved'
    );
  $$;
```

It reads `access_requests` from policies on *other* tables, so it is not the
recursive-RLS trap warned about in `auth-roadmap.md` §4.

| Table | Policy |
|---|---|
| `projects`, `project_sessions`, `transcript_items` | select/update/delete where `owner_id = auth.uid()`; insert where `owner_id = auth.uid() and is_approved()` |
| `glossary_lists` where `scope='project'` | same as above |
| `glossary_terms` on a project-scoped list | all commands where the parent list is one the caller owns |
| `glossary_lists` where `scope='shared'` | `select` for `is_approved()`; **no** insert/update/delete policy |
| `glossary_terms` on a shared list | `select` for `is_approved()`; no write policy |
| `project_glossary_lists` | all commands where the project is the caller's |

Reads of your own rows do not require approval; writes do. A revoked account
can still open its past meetings but cannot record new ones. More
importantly, a signed-in-but-unapproved Google account holding the public
anon key cannot write rows into the database at all.

Shared lists have no write policy by design — they are maintained from the
SQL editor or dashboard, exactly as account approvals are today. Giving
users an editing path is a separate feature with its own privilege
questions.

### 3.4 Deliberately not moving

- **Selected project id** stays in `localStorage`. It is per-device UI state;
  two screens signed in as the same person should not fight over which
  project is open.
- **The 7-day expiry sweep** stays client-side and unchanged
  (`useProjects.sweepExpired`). `pg_cron` would be more correct — a sweep
  that only runs while someone has the app open is not a real deadline — but
  that is a separate concern from this migration. Recorded as follow-up.
- **`MAX_ACTIVE_PROJECTS = 3`** stays a client-side check. A trigger would
  make it real; not in scope.

## 4. Application structure

### 4.1 Repositories

`ProjectStore`'s blob interface is replaced by two repos whose methods each
map to roughly one statement.

```
src/data/projectsRepo.ts
  listProjects()                                  → Project[] (sessions, no transcript text)
  createProject(name)                             → Project
  attachAsrSession(projectId, asrSessionId, src, tgt)
  endSession(sessionId)
  detachAsrSession(projectId)
  appendCaption(sessionId, caption)
  editCaption(sessionId, seq, targetText)
  loadTranscript(sessionId)                       → TranscriptItem[]
  markSummarizing(sessionId)                      -- increments summarize_runs
  saveSummary(sessionId, summary, reportItemCount)
  finishProject(projectId, bill, closedSessions)
  sweepExpired(projects)

src/data/glossaryRepo.ts
  listSharedLists()                               → GlossaryList[] (name, description, is_default)
  loadProjectLists(projectId)                     → { own: GlossaryList, subscribed: GlossaryList[] }
  loadTerms(listIds)                              → Record<listId, GlossarySections>
  subscribeList(projectId, listId)
  unsubscribeList(projectId, listId)
  addTerm(projectId, section, term, translation)  -- into the project's own list
  removeTerm(projectId, section, term)
```

The repo returns raw per-list terms and does **no** merging.
`mergeGlossary` (§4.5) is a pure function called by `useGlossary`, so the
precedence rule is testable without a database and lives in exactly one
place.

`listProjects` is a single nested select (`projects(*, project_sessions(*))`)
— one round trip for the whole picker.

### 4.2 Transcripts become lazy

Today every caption of every past session is held in memory. The session
history list only needs a *count*
(`src/components/ProjectPanel.tsx`, `session.transcripts?.length`), so a view

```sql
create view public.project_sessions_with_counts as
  select s.*, (select count(*) from public.transcript_items t
                where t.session_id = s.id) as item_count
    from public.project_sessions s;
```

supplies `itemCount`, and `ProjectSession.transcripts` stays `undefined`
until something needs the text — opening a summary popup, or summarising.
Initial load stays small however many meetings have been recorded.

`ProjectSession` gains `itemCount: number`. `reportItemCount` is kept: it
records how many items were sent to the summariser, which is not the same
number as how many the session holds now.

### 4.3 `useProjects`

Reshapes from "mirror state into storage" to "issue a mutation per action":

- Local React state remains the render cache, so the UI stays instant.
- Each action updates state optimistically, calls the repo, and on failure
  sets `persistError` and re-reads from the server to resync.
- The two blanket write effects (`useEffect` → `saveProjects` /
  `saveSelectedId`) are removed.
- Dead code `saveTranscripts` — never called from any component — is deleted.
- Gains `loading: boolean`. Loads once `auth.ready && status === 'approved'`;
  clears on sign-out, so a second operator on a shared machine never sees the
  first one's cache.

`PersistResult` gains the `'network'` and `'auth'` reasons that
`projectStore.ts` already anticipated in its header comment. The banner copy
in `src/pages/Admin.tsx` extends to match.

**The existing rule holds throughout: a failed write must never look like a
successful one.** That is why `PersistResult` exists at all.

### 4.4 Live caption writes

`handleCaptureResult` in `src/pages/Admin.tsx` additionally calls
`appendCaption`, fire-and-forget. A failed insert goes onto an in-memory
retry queue drained on a short backoff and flushed at session end; if it
still will not land, `persistError` surfaces it. Caption edits call
`editCaption`, keyed by `(session_id, seq)`.

Write volume is roughly one small insert every few seconds — a caption closes
about once per sentence.

### 4.5 Glossary wiring

`src/glossary.ts` keeps its pure transforms — `glossaryToVocabulary`,
`glossaryToPairs`, `applyEnThCorrections` — unchanged, and loses only
`loadGlossary` / `saveGlossary`. A new pure
`mergeGlossary(shared: GlossarySections[], own: GlossarySections)` in
`src/data/glossaryMerge.ts` implements the precedence rule from §3.2:
sections merge independently, shared lists apply in order, and `own`
overwrites last.

`src/pages/Admin.tsx` is already 1110 lines, so per-project glossary loading,
list subscription, and term add/remove move into a new
`src/hooks/useGlossary.ts` rather than growing that file further.

`DictionaryManager` already accepts `sections: GlossarySections | null` and a
`disabled` prop, so the "no project selected" state costs almost nothing. It
gains a checkbox list of shared lists, showing which are subscribed.

`useGeminiLiveCapture` is unchanged. It receives the merged effective
glossary at session start exactly as it receives the localStorage one today,
so the server-side `customVocabulary` and `systemInstruction` paths are
untouched.

## 5. Error handling

| Failure | Behaviour |
|---|---|
| Initial load fails | Keep previous cache (usually empty), show banner, offer retry |
| Mutation fails | Roll back to server truth by re-reading, show banner with reason |
| `appendCaption` fails | Retry queue, backoff, flush at session end; banner only if it never lands |
| Session expired (`auth`) | Banner says to sign in again; `RequireAuth` handles the redirect |
| Supabase not configured | Existing `isSupabaseConfigured` / `SUPABASE_SETUP_MESSAGE` path, unchanged |

## 6. Testing

Test-driven, as usual in this repo.

- **Repos** — tested against a fake Supabase query builder, asserting the
  statements issued and the mapping in both directions (snake_case columns ↔
  camelCase types, epoch seconds ↔ `timestamptz`).
- **`useProjects`** — `src/hooks/useProjects.test.ts` already injects its
  store, so it switches to injecting a fake repo. Expectations are rewritten
  from "the blob it saved" to "the mutations it issued". Existing coverage of
  expiry sweep, billing and session lifecycle is preserved.
- **`mergeGlossary`** — pure; direct tests for precedence, including a
  project term overriding a shared one in the same section.
- **`src/glossary.test.ts`** — unchanged; its subject functions do not move.
- **RLS** — cannot be unit-tested without a live database. The schema file
  ships with a commented two-account verification script in the same style as
  the existing admin cheat-sheet in `supabase/schema.sql`. **Running it is a
  manual step and is the check that actually proves privacy holds.**

## 7. Files

**New**

- `supabase/schema-projects.sql` — tables, view, `is_approved()`, RLS,
  seed for one `is_default` person-name list, verification script
- `src/data/projectsRepo.ts` + test
- `src/data/glossaryRepo.ts` + test
- `src/data/glossaryMerge.ts` + test
- `src/hooks/useGlossary.ts` + test

**Rewritten**

- `src/hooks/useProjects.ts` — mutations instead of blob writes
- `src/storage/projectStore.ts` — reduced to the selected-project-id
  localStorage helper; the `Project[]` blob interface is removed

**Edited**

- `src/glossary.ts` — drop `loadGlossary` / `saveGlossary`
- `src/types.ts` — `ProjectSession.itemCount`; ids are uuid strings
- `src/pages/Admin.tsx` — `appendCaption` / `editCaption`, loading state,
  glossary via `useGlossary`, banner copy
- `src/components/DictionaryManager.tsx` — shared-list picker
- `src/components/ProjectPanel.tsx` — `itemCount`, lazy transcript fetch
- `SYSTEM_OVERVIEW.md` — §2.4, §2.6 and the roadmap no longer say
  "localStorage" or "ยังไม่มี database จริง"

`.env` is unchanged — the same `VITE_SUPABASE_URL` and
`VITE_SUPABASE_ANON_KEY` already in use.

## 8. Order of work

1. Schema + RLS, applied to the Supabase project and verified with two accounts
2. Repos, tested against fakes
3. `useProjects` on top of `projectsRepo`
4. Admin / ProjectPanel wiring, including live caption writes
5. Glossary lists, `useGlossary`, and the picker UI
6. Documentation

## 9. Follow-ups, explicitly out of scope

- `pg_cron` for the 7-day expiry sweep, so it does not depend on a browser
  being open
- An in-app admin UI for editing shared glossary lists (needs the role work
  described in `auth-roadmap.md` §4)
- Enforcing `MAX_ACTIVE_PROJECTS` in the database
- Realtime subscriptions, so two open tabs see each other's changes
