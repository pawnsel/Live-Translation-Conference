# Supabase Data Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move projects, sessions, transcripts and the glossary out of `localStorage` into Supabase Postgres, and replace the single per-browser glossary with an org-wide library of reusable lists that each project subscribes to.

**Architecture:** The browser talks to Postgres directly through the existing anon key; row-level security (`owner_id = auth.uid()`) is what enforces privacy, exactly as it already does for `access_requests`. No new server code. The `ProjectStore` blob interface is replaced by two repositories whose methods each map to roughly one SQL statement, with pure row-mapping functions between database rows and the existing TypeScript types.

**Tech Stack:** React 19, TypeScript 5.8 (no `strictNullChecks`), Vite 6, Vitest 3 + @testing-library/react, `@supabase/supabase-js` 2.x, Postgres 15+ (Supabase).

**Spec:** `docs/superpowers/specs/2026-09-09-supabase-data-migration-design.md`

## Global Constraints

- **Private per user.** Every row of project data carries `owner_id` and is readable only by its owner. No sharing, no membership tables.
- **Shared glossary lists are read-only to the app.** `scope='shared'` lists have a `SELECT` policy and deliberately **no** insert/update/delete policy — they are maintained from the Supabase dashboard, exactly as account approvals are.
- **Writes require approval, reads do not.** Every `INSERT`/`UPDATE` policy includes `public.is_approved()`. `SELECT` policies do not.
- **A failed write must never look like a successful one.** This is why `PersistResult` exists (`src/storage/projectStore.ts` header). Every mutation reports success or failure; failures reach `persistError`.
- **`summary` is three-state.** `null`/`undefined` = nobody asked; `''` = a summary was asked for and the AI call failed; text = a real summary. `src/components/ProjectPanel.tsx:540-542` depends on this. Never collapse `null` and `''`.
- **Time units.** `TranscriptItem.ts` is epoch **seconds** (`Date.now() / 1000`, set in `src/asr/captions.ts`). `startedAt` / `endedAt` / `createdAt` are epoch **milliseconds**. Postgres stores `timestamptz` for both. Conversion happens only in `src/data/rowMappers.ts`; nothing above the repo layer changes units.
- **`asrSessionId` stays client-generated.** It is `local_${Date.now()}` text, created in `src/pages/Admin.tsx` before any row exists, and is not a database id.
- **No data migration.** Existing `localStorage` keys are simply no longer read. Nothing is deleted.
- **Thai UI copy.** All user-facing strings are Thai, matching the surrounding code.
- **Run tests with:** `npm test` (Vitest, `src/**/*.test.ts(x)` + `server/**/*.test.ts`). Typecheck with `npm run lint` (`tsc --noEmit`).

## Two refinements to the spec, decided during planning

1. **`item_count` is a trigger-maintained column, not a view.** The spec proposed a `project_sessions_with_counts` view. PostgREST cannot reliably embed a view in a nested select from `projects` (views carry no foreign keys, so the relationship is not auto-detected). A denormalised `item_count` column on `project_sessions`, maintained by an `after insert or delete` trigger on `transcript_items`, keeps the single-round-trip nested select working and costs one cheap `UPDATE` per caption.
2. **The selected project loads its transcripts eagerly.** The spec said transcripts load only when a summary popup opens. But `useLiveProjectCost` → `projectCost` reads `session.transcripts ?? []` for every session in the current project, so the running cost badge would silently undercount. Selecting a project therefore loads that project's transcripts in one query; projects in the ended-history list stay lazy.

## File structure

**New**

| File | Responsibility |
|---|---|
| `supabase/schema-projects.sql` | Tables, triggers, `is_approved()`, RLS, default-list seed, manual verification script |
| `src/data/rowMappers.ts` | Pure database-row ↔ domain-type conversion. No I/O. |
| `src/data/testing/fakeSupabase.ts` | Recording chainable fake of the Supabase query builder, for repo tests |
| `src/data/projectsRepo.ts` | Every project/session/transcript statement |
| `src/data/persistError.ts` | The failure taxonomy every repo throws and the banner reads |
| `src/data/captionQueue.ts` | Serial retrying outbox so a network blip never costs a caption |
| `src/data/glossaryMerge.ts` | Pure `mergeGlossary` precedence rule |
| `src/data/glossaryRepo.ts` | Every glossary list/term/subscription statement |
| `src/hooks/useGlossary.ts` | Per-project glossary state: load, subscribe, add/remove term |

**Rewritten**

| File | Change |
|---|---|
| `src/hooks/useProjects.ts` | Mutations per action instead of blob writes; gains `loading`; deletes dead `saveTranscripts` |
| `src/storage/projectStore.ts` | Reduced to the selected-project-id localStorage helper; `Project[]` blob interface removed |

**Edited**

| File | Change |
|---|---|
| `src/types.ts` | `ProjectSession.itemCount` |
| `src/glossary.ts` | Drop `loadGlossary` / `saveGlossary`; pure transforms unchanged |
| `src/pages/Admin.tsx` | Live caption writes, loading state, glossary via `useGlossary`, banner copy |
| `src/components/ProjectPanel.tsx` | `itemCount`, lazy transcript fetch |
| `src/components/DictionaryManager.tsx` | Shared-list picker |
| `SYSTEM_OVERVIEW.md` | §1.3, §2.4, §2.6, §5 no longer say localStorage |

---

### Task 1: Database schema, triggers and RLS

No automated test exists for RLS — it needs a live database and two accounts. The deliverable is the SQL file plus a **manual** verification you must run. Everything is guarded so the file is safe to re-run.

**Files:**
- Create: `supabase/schema-projects.sql`

**Interfaces:**
- Consumes: `public.access_requests` from the existing `supabase/schema.sql`.
- Produces: tables `projects`, `project_sessions` (with `item_count`), `transcript_items`, `glossary_lists`, `glossary_terms`, `project_glossary_lists`; function `public.is_approved()`; one seeded `is_default` shared list.

- [ ] **Step 1: Write the schema file**

Create `supabase/schema-projects.sql`:

```sql
-- ===========================================================================
--  AI Live Translator — project, session, transcript and glossary schema
--  Run once in Supabase → SQL Editor, AFTER schema.sql.
--  Safe to re-run: every statement is guarded.
-- ===========================================================================
--
--  Everything here is private to one person. `owner_id = auth.uid()` in the
--  policies below is what actually enforces that — the browser holds the
--  public anon key, so the client cannot be trusted to filter.
--
--  Writes additionally require an approved account; reads do not. A revoked
--  account can still open its past meetings but cannot record new ones, and a
--  signed-in-but-unapproved Google account cannot write rows at all.

-- ---------------------------------------------------------------------------
-- 1. Enums
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'project_status') then
    create type public.project_status as enum ('active', 'ended');
  end if;
  if not exists (select 1 from pg_type where typname = 'glossary_section') then
    -- Must match GlossarySection in src/glossary.ts, exactly and in order.
    create type public.glossary_section as enum
      ('protected_terms', 'person_names', 'thai_corrections', 'en_th_corrections');
  end if;
  if not exists (select 1 from pg_type where typname = 'glossary_scope') then
    create type public.glossary_scope as enum ('shared', 'project');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. Approval helper
-- ---------------------------------------------------------------------------
-- Reads access_requests from policies on OTHER tables, so this is not the
-- recursive-RLS trap described in docs/auth-roadmap.md §4. security definer
-- because the caller's own SELECT policy on access_requests would otherwise
-- have to be consulted from inside every policy that uses this.
create or replace function public.is_approved() returns boolean
  language sql
  security definer
  stable
  set search_path = public
as $$
  select exists (
    select 1 from public.access_requests
     where id = auth.uid() and status = 'approved'
  );
$$;

revoke all on function public.is_approved() from public;
grant execute on function public.is_approved() to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Tables
-- ---------------------------------------------------------------------------
create table if not exists public.projects (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null default auth.uid()
                  references auth.users (id) on delete cascade,
  name          text not null check (length(trim(name)) > 0),
  status        public.project_status not null default 'active',
  created_at    timestamptz not null default now(),
  ended_at      timestamptz,
  auto_finished boolean not null default false,
  -- The live capture session currently attached, null when detached. Client
  -- generated (`local_<epoch>`), not a database id.
  asr_session_id text,
  -- ProjectBill: a frozen receipt written once when the project is finished
  -- and never queried by field, so it stays a document.
  bill          jsonb
);

create index if not exists projects_owner_idx
  on public.projects (owner_id, created_at desc);

create table if not exists public.project_sessions (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references public.projects (id) on delete cascade,
  owner_id          uuid not null default auth.uid()
                      references auth.users (id) on delete cascade,
  asr_session_id    text not null,
  started_at        timestamptz not null default now(),
  ended_at          timestamptz,
  source_lang       text not null,
  target_lang       text not null,
  -- Three states, and they must stay distinct:
  --   null = nobody has asked for a summary
  --   ''   = a summary was asked for and the AI call failed
  --   text = a real summary
  summary           text,
  -- How many items were sent to the summariser. NOT the same number as
  -- item_count: the session may have grown since.
  report_item_count integer,
  summarize_runs    integer not null default 0,
  -- Denormalised count of transcript_items, kept current by the trigger in
  -- section 4. A column rather than a view because PostgREST cannot embed a
  -- view in a nested select from projects (no foreign keys on views).
  item_count        integer not null default 0,
  unique (project_id, asr_session_id)
);

create index if not exists project_sessions_project_idx
  on public.project_sessions (project_id, started_at);

create table if not exists public.transcript_items (
  session_id  uuid not null references public.project_sessions (id) on delete cascade,
  seq         integer not null,
  owner_id    uuid not null default auth.uid()
                references auth.users (id) on delete cascade,
  source_text text not null,
  target_text text not null,
  source_lang text not null,
  target_lang text not null,
  ts          timestamptz not null,
  latency_ms  integer not null,
  is_edited   boolean not null default false,
  -- seq is assigned by the capture hook and is unique within a session, so it
  -- is the natural key. An edit updates one row by (session_id, seq).
  primary key (session_id, seq)
);

create table if not exists public.glossary_lists (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  scope       public.glossary_scope not null,
  -- Shared lists belong to the organisation, so both are null. Project lists
  -- belong to one project and one person, so both are set.
  owner_id    uuid references auth.users (id) on delete cascade,
  project_id  uuid references public.projects (id) on delete cascade,
  -- Auto-subscribed by new projects (see the trigger in section 4).
  is_default  boolean not null default false,
  created_at  timestamptz not null default now(),
  constraint glossary_lists_scope_shape check (
    (scope = 'shared'  and project_id is null     and owner_id is null) or
    (scope = 'project' and project_id is not null and owner_id is not null)
  )
);

create unique index if not exists glossary_lists_one_per_project
  on public.glossary_lists (project_id) where scope = 'project';

create table if not exists public.glossary_terms (
  id          uuid primary key default gen_random_uuid(),
  list_id     uuid not null references public.glossary_lists (id) on delete cascade,
  section     public.glossary_section not null,
  term        text not null,
  translation text not null
);

-- One meaning per term per section, case-insensitively.
create unique index if not exists glossary_terms_unique
  on public.glossary_terms (list_id, section, lower(term));

create table if not exists public.project_glossary_lists (
  project_id uuid not null references public.projects (id) on delete cascade,
  list_id    uuid not null references public.glossary_lists (id) on delete cascade,
  primary key (project_id, list_id)
);

-- ---------------------------------------------------------------------------
-- 4. Triggers
-- ---------------------------------------------------------------------------
-- Keeps project_sessions.item_count in step with transcript_items, so the
-- session history can show "N ข้อความ" without loading any transcript text.
create or replace function public.sync_session_item_count() returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    update public.project_sessions
       set item_count = item_count + 1
     where id = new.session_id;
  elsif tg_op = 'DELETE' then
    update public.project_sessions
       set item_count = greatest(item_count - 1, 0)
     where id = old.session_id;
  end if;
  return null;
end
$$;

drop trigger if exists transcript_items_count on public.transcript_items;
create trigger transcript_items_count
  after insert or delete on public.transcript_items
  for each row execute function public.sync_session_item_count();

-- Every project owns exactly one glossary list, and starts subscribed to
-- every default shared list. Done in the database, not as a second client
-- call, so there is no window in which a project exists without its own list
-- and a client that forgets the call cannot create one.
create or replace function public.setup_project_glossary() returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  insert into public.glossary_lists (name, scope, owner_id, project_id)
  values ('ศัพท์เฉพาะของโปรเจกต์นี้', 'project', new.owner_id, new.id);

  insert into public.project_glossary_lists (project_id, list_id)
  select new.id, l.id
    from public.glossary_lists l
   where l.scope = 'shared' and l.is_default;

  return null;
end
$$;

drop trigger if exists projects_setup_glossary on public.projects;
create trigger projects_setup_glossary
  after insert on public.projects
  for each row execute function public.setup_project_glossary();

-- ---------------------------------------------------------------------------
-- 5. Row-level security
-- ---------------------------------------------------------------------------
alter table public.projects              enable row level security;
alter table public.project_sessions      enable row level security;
alter table public.transcript_items      enable row level security;
alter table public.glossary_lists        enable row level security;
alter table public.glossary_terms        enable row level security;
alter table public.project_glossary_lists enable row level security;

grant select, insert, update, delete on
  public.projects,
  public.project_sessions,
  public.transcript_items,
  public.glossary_lists,
  public.glossary_terms,
  public.project_glossary_lists
  to authenticated;

-- ── projects ───────────────────────────────────────────────────────────────
drop policy if exists "read own projects" on public.projects;
create policy "read own projects" on public.projects
  for select to authenticated using (owner_id = auth.uid());

drop policy if exists "create own projects" on public.projects;
create policy "create own projects" on public.projects
  for insert to authenticated
  with check (owner_id = auth.uid() and public.is_approved());

drop policy if exists "update own projects" on public.projects;
create policy "update own projects" on public.projects
  for update to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid() and public.is_approved());

drop policy if exists "delete own projects" on public.projects;
create policy "delete own projects" on public.projects
  for delete to authenticated using (owner_id = auth.uid());

-- ── project_sessions ───────────────────────────────────────────────────────
drop policy if exists "read own sessions" on public.project_sessions;
create policy "read own sessions" on public.project_sessions
  for select to authenticated using (owner_id = auth.uid());

drop policy if exists "create own sessions" on public.project_sessions;
create policy "create own sessions" on public.project_sessions
  for insert to authenticated
  with check (owner_id = auth.uid() and public.is_approved());

drop policy if exists "update own sessions" on public.project_sessions;
create policy "update own sessions" on public.project_sessions
  for update to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid() and public.is_approved());

drop policy if exists "delete own sessions" on public.project_sessions;
create policy "delete own sessions" on public.project_sessions
  for delete to authenticated using (owner_id = auth.uid());

-- ── transcript_items ───────────────────────────────────────────────────────
drop policy if exists "read own transcripts" on public.transcript_items;
create policy "read own transcripts" on public.transcript_items
  for select to authenticated using (owner_id = auth.uid());

drop policy if exists "create own transcripts" on public.transcript_items;
create policy "create own transcripts" on public.transcript_items
  for insert to authenticated
  with check (owner_id = auth.uid() and public.is_approved());

drop policy if exists "update own transcripts" on public.transcript_items;
create policy "update own transcripts" on public.transcript_items
  for update to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid() and public.is_approved());

drop policy if exists "delete own transcripts" on public.transcript_items;
create policy "delete own transcripts" on public.transcript_items
  for delete to authenticated using (owner_id = auth.uid());

-- ── glossary_lists ─────────────────────────────────────────────────────────
-- Shared lists are readable by every approved account and writable by none:
-- they are maintained from the dashboard, exactly as approvals are.
drop policy if exists "read shared and own lists" on public.glossary_lists;
create policy "read shared and own lists" on public.glossary_lists
  for select to authenticated
  using ((scope = 'shared' and public.is_approved()) or owner_id = auth.uid());

drop policy if exists "create own project lists" on public.glossary_lists;
create policy "create own project lists" on public.glossary_lists
  for insert to authenticated
  with check (scope = 'project' and owner_id = auth.uid() and public.is_approved());

drop policy if exists "update own project lists" on public.glossary_lists;
create policy "update own project lists" on public.glossary_lists
  for update to authenticated
  using (scope = 'project' and owner_id = auth.uid())
  with check (scope = 'project' and owner_id = auth.uid() and public.is_approved());

drop policy if exists "delete own project lists" on public.glossary_lists;
create policy "delete own project lists" on public.glossary_lists
  for delete to authenticated
  using (scope = 'project' and owner_id = auth.uid());

-- ── glossary_terms ─────────────────────────────────────────────────────────
drop policy if exists "read terms of readable lists" on public.glossary_terms;
create policy "read terms of readable lists" on public.glossary_terms
  for select to authenticated
  using (exists (
    select 1 from public.glossary_lists l
     where l.id = list_id
       and ((l.scope = 'shared' and public.is_approved()) or l.owner_id = auth.uid())
  ));

drop policy if exists "write terms of own project lists" on public.glossary_terms;
create policy "write terms of own project lists" on public.glossary_terms
  for all to authenticated
  using (exists (
    select 1 from public.glossary_lists l
     where l.id = list_id and l.scope = 'project' and l.owner_id = auth.uid()
  ))
  with check (public.is_approved() and exists (
    select 1 from public.glossary_lists l
     where l.id = list_id and l.scope = 'project' and l.owner_id = auth.uid()
  ));

-- ── project_glossary_lists ─────────────────────────────────────────────────
drop policy if exists "manage own project subscriptions" on public.project_glossary_lists;
create policy "manage own project subscriptions" on public.project_glossary_lists
  for all to authenticated
  using (exists (
    select 1 from public.projects p where p.id = project_id and p.owner_id = auth.uid()
  ))
  with check (public.is_approved() and exists (
    select 1 from public.projects p where p.id = project_id and p.owner_id = auth.uid()
  ));

-- ---------------------------------------------------------------------------
-- 6. Seed: one default shared list
-- ---------------------------------------------------------------------------
insert into public.glossary_lists (name, description, scope, is_default)
select 'ชื่อบุคคล (อังกฤษ → ไทย)',
       'รายชื่อผู้บริหารและวิทยากรที่ใช้ร่วมกันทุกโปรเจกต์',
       'shared', true
 where not exists (
   select 1 from public.glossary_lists
    where scope = 'shared' and name = 'ชื่อบุคคล (อังกฤษ → ไทย)'
 );

-- ===========================================================================
--  Admin cheat-sheet — run these by hand in the SQL editor
-- ===========================================================================
--
--  Add a person name to the default shared list:
--    insert into public.glossary_terms (list_id, section, term, translation)
--    select id, 'en_th_corrections', 'Somchai Jaidee', 'สมชาย ใจดี'
--      from public.glossary_lists
--     where scope = 'shared' and name = 'ชื่อบุคคล (อังกฤษ → ไทย)';
--
--  Add another shared list (is_default = false ⇒ opt-in per project):
--    insert into public.glossary_lists (name, description, scope, is_default)
--    values ('ศัพท์การแพทย์', 'คำศัพท์เฉพาะทางการแพทย์', 'shared', false);
--
-- ===========================================================================
--  MANUAL VERIFICATION — run this before trusting the policies
-- ===========================================================================
--
--  RLS cannot be unit-tested from the app's test suite. Do this once, by
--  hand, with TWO approved accounts (A and B):
--
--  1. Sign in as A, create a project, record one short session.
--  2. Sign in as B in a different browser profile. B's project list must be
--     EMPTY. Not "shows an error" — empty.
--  3. In the SQL editor (service role, bypasses RLS) note A's project id.
--     Back in B's browser console:
--       await supabase.from('projects').select('*').eq('id', '<A-project-id>')
--     Must return `data: []`, not A's row.
--  4. Still as B:
--       await supabase.from('projects').update({ name: 'x' }).eq('id', '<A-project-id>')
--     Must affect zero rows.
--  5. Set B's access_requests.status to 'pending', reload, and try to create
--     a project. The INSERT must fail (is_approved() is false), while B's
--     existing projects still LOAD — reads do not require approval.
--  6. As any approved user:
--       await supabase.from('glossary_lists')
--         .update({ name: 'hacked' }).eq('scope', 'shared')
--     Must affect zero rows: shared lists have no UPDATE policy.
--
--  Only after all six behave as described is the privacy claim real.
```

- [ ] **Step 2: Apply the schema**

Open the Supabase dashboard → SQL Editor, paste the whole file, run it. Expect "Success. No rows returned". If it errors on `gen_random_uuid()`, run `create extension if not exists pgcrypto;` first and re-run.

- [ ] **Step 3: Confirm the seed and the triggers exist**

Run in the SQL editor:

```sql
select name, scope, is_default from public.glossary_lists;
select tgname from pg_trigger
 where tgname in ('transcript_items_count', 'projects_setup_glossary');
```

Expected: one shared list named `ชื่อบุคคล (อังกฤษ → ไทย)` with `is_default = true`, and both trigger names present.

- [ ] **Step 4: Run the manual verification**

Work through the six numbered checks in the file's verification block, with two approved accounts. **Do not proceed to Task 2 until all six behave as described** — every later task assumes these policies hold.

- [ ] **Step 5: Commit**

```bash
git add supabase/schema-projects.sql
git commit -m "feat(db): schema, triggers and RLS for projects and glossary"
```

---

### Task 2: Types and pure row mappers

Pure functions, no I/O — the place where every snake_case/camelCase and every unit conversion lives, so the repos stay thin and the tricky parts are cheap to test.

**Files:**
- Modify: `src/types.ts` (add `ProjectSession.itemCount`)
- Create: `src/data/rowMappers.ts`
- Test: `src/data/rowMappers.test.ts`

**Interfaces:**
- Consumes: `Project`, `ProjectSession`, `TranscriptItem`, `ProjectBill` from `src/types.ts`.
- Produces:
  - `ProjectRow`, `SessionRow`, `TranscriptRow` — the database row shapes
  - `toMillis(iso: string): number`, `toMillisOrNull(iso: string | null): number | undefined`
  - `toSession(row: SessionRow): ProjectSession`
  - `toProject(row: ProjectRow, sessions: SessionRow[]): Project`
  - `toTranscriptItem(row: TranscriptRow): TranscriptItem`
  - `fromTranscriptItem(sessionId: string, item: TranscriptItem): TranscriptRow & { session_id: string }`

- [ ] **Step 1: Add `itemCount` to `ProjectSession`**

In `src/types.ts`, inside `interface ProjectSession`, after the `transcripts?` field:

```ts
  /** How many transcript rows this session holds. Always known, because it
   *  comes from a denormalised column; `transcripts` is loaded on demand and
   *  stays undefined until something needs the text. Sessions in the ended
   *  history are listed by this number without fetching a single caption. */
  itemCount: number;
```

Also replace the `transcripts?` doc comment with:

```ts
  /** Captions recorded during this session. Loaded on demand — undefined
   *  means "not fetched yet", NOT "this session recorded nothing". Use
   *  `itemCount` to tell those apart. */
  transcripts?: TranscriptItem[];
```

- [ ] **Step 2: Write the failing test**

Create `src/data/rowMappers.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  fromTranscriptItem,
  toMillis,
  toProject,
  toSession,
  toTranscriptItem,
  type ProjectRow,
  type SessionRow,
  type TranscriptRow
} from './rowMappers';

const sessionRow: SessionRow = {
  id: 'sess-uuid',
  project_id: 'proj-uuid',
  asr_session_id: 'local_1700000000000',
  started_at: '2026-01-01T00:00:00.000Z',
  ended_at: '2026-01-01T00:30:00.000Z',
  source_lang: 'th',
  target_lang: 'en',
  summary: null,
  report_item_count: null,
  summarize_runs: 0,
  item_count: 12
};

describe('toSession', () => {
  it('maps columns to camelCase and timestamps to epoch ms', () => {
    const session = toSession(sessionRow);
    expect(session.id).toBe('sess-uuid');
    expect(session.asrSessionId).toBe('local_1700000000000');
    expect(session.startedAt).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
    expect(session.endedAt).toBe(Date.parse('2026-01-01T00:30:00.000Z'));
    expect(session.itemCount).toBe(12);
  });

  it('leaves endedAt undefined for a session still running', () => {
    expect(toSession({ ...sessionRow, ended_at: null }).endedAt).toBeUndefined();
  });

  // The three-state rule. Collapsing these is the bug that makes a failed
  // summary look like one nobody ever asked for.
  it('maps a null summary to undefined — nobody has asked', () => {
    expect(toSession({ ...sessionRow, summary: null }).summary).toBeUndefined();
  });

  it('keeps an empty summary as "" — the AI call failed', () => {
    expect(toSession({ ...sessionRow, summary: '' }).summary).toBe('');
  });

  it('keeps a real summary verbatim', () => {
    expect(toSession({ ...sessionRow, summary: 'สรุป' }).summary).toBe('สรุป');
  });
});

const projectRow: ProjectRow = {
  id: 'proj-uuid',
  name: 'ประชุมวิชาการ',
  status: 'active',
  created_at: '2026-01-01T00:00:00.000Z',
  ended_at: null,
  auto_finished: false,
  asr_session_id: null,
  bill: null
};

describe('toProject', () => {
  it('maps the row and attaches its sessions oldest first', () => {
    const older = { ...sessionRow, id: 'a', started_at: '2026-01-01T00:00:00.000Z' };
    const newer = { ...sessionRow, id: 'b', started_at: '2026-01-01T01:00:00.000Z' };
    const project = toProject(projectRow, [newer, older]);

    expect(project.name).toBe('ประชุมวิชาการ');
    expect(project.createdAt).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
    expect(project.sessions.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('starts with an empty transcript array and no bill', () => {
    const project = toProject(projectRow, []);
    expect(project.transcripts).toEqual([]);
    expect(project.bill).toBeUndefined();
  });

  it('carries a finished project bill through unchanged', () => {
    const bill = { sessionCount: 2, durationMs: 1000, wordCount: 40, estimatedCost: 0.12 };
    expect(toProject({ ...projectRow, bill }, []).bill).toEqual(bill);
  });

  it('maps a null asr_session_id to null, not undefined', () => {
    // useProjects treats null as "nothing attached"; undefined would read as
    // "this record predates the field".
    expect(toProject(projectRow, []).asrSessionId).toBeNull();
  });
});

const transcriptRow: TranscriptRow = {
  seq: 3,
  source_text: 'สวัสดีครับ',
  target_text: 'Hello',
  source_lang: 'th',
  target_lang: 'en',
  ts: '2026-01-01T00:00:10.000Z',
  latency_ms: 420,
  is_edited: false
};

describe('toTranscriptItem', () => {
  // TranscriptItem.ts is epoch SECONDS everywhere above the repo — captions.ts
  // sets it as Date.now() / 1000 — while Postgres stores timestamptz.
  it('converts the timestamp to epoch seconds, not milliseconds', () => {
    expect(toTranscriptItem(transcriptRow).ts).toBe(
      Date.parse('2026-01-01T00:00:10.000Z') / 1000
    );
  });

  it('maps the remaining columns', () => {
    const item = toTranscriptItem(transcriptRow);
    expect(item).toMatchObject({
      seq: 3,
      sourceText: 'สวัสดีครับ',
      targetText: 'Hello',
      latencyMs: 420,
      isEdited: false
    });
  });
});

describe('fromTranscriptItem', () => {
  it('round-trips an item back to its row', () => {
    const item = toTranscriptItem(transcriptRow);
    expect(fromTranscriptItem('sess-uuid', item)).toEqual({
      ...transcriptRow,
      session_id: 'sess-uuid'
    });
  });
});

describe('toMillis', () => {
  it('parses a Postgres timestamptz', () => {
    expect(toMillis('2026-01-01T00:00:00.000Z')).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/data/rowMappers.test.ts`
Expected: FAIL — cannot resolve `./rowMappers`.

- [ ] **Step 4: Write the implementation**

Create `src/data/rowMappers.ts`:

```ts
/** Database rows in, domain types out. Pure — no client, no I/O.
 *
 *  Every snake_case/camelCase rename and every unit conversion lives here and
 *  nowhere else, so the repositories stay thin and the two places this is
 *  easy to get wrong — the three-state `summary` and the seconds/milliseconds
 *  split — are covered by fast tests instead of a live database.
 */

import type { Project, ProjectBill, ProjectSession, TranscriptItem } from '../types';

export interface ProjectRow {
  id: string;
  name: string;
  status: 'active' | 'ended';
  created_at: string;
  ended_at: string | null;
  auto_finished: boolean;
  asr_session_id: string | null;
  bill: ProjectBill | null;
}

export interface SessionRow {
  id: string;
  project_id: string;
  asr_session_id: string;
  started_at: string;
  ended_at: string | null;
  source_lang: string;
  target_lang: string;
  summary: string | null;
  report_item_count: number | null;
  summarize_runs: number;
  item_count: number;
}

export interface TranscriptRow {
  seq: number;
  source_text: string;
  target_text: string;
  source_lang: string;
  target_lang: string;
  ts: string;
  latency_ms: number;
  is_edited: boolean;
}

/** Postgres timestamptz → epoch milliseconds. */
export function toMillis(iso: string): number {
  return Date.parse(iso);
}

export function toMillisOrNull(iso: string | null): number | undefined {
  return iso === null ? undefined : Date.parse(iso);
}

export function toSession(row: SessionRow): ProjectSession {
  return {
    id: row.id,
    asrSessionId: row.asr_session_id,
    startedAt: toMillis(row.started_at),
    endedAt: toMillisOrNull(row.ended_at),
    sourceLang: row.source_lang,
    targetLang: row.target_lang,
    // null means nobody asked; '' means the AI call failed. Those must not
    // collapse into one value — ProjectPanel renders them differently.
    summary: row.summary === null ? undefined : row.summary,
    reportItemCount: row.report_item_count === null ? undefined : row.report_item_count,
    summarizeRuns: row.summarize_runs,
    itemCount: row.item_count
    // `transcripts` is deliberately absent: undefined means "not fetched".
  };
}

export function toProject(row: ProjectRow, sessions: SessionRow[]): Project {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    createdAt: toMillis(row.created_at),
    endedAt: toMillisOrNull(row.ended_at),
    autoFinished: row.auto_finished,
    // Kept as null rather than undefined: useProjects reads null as "nothing
    // attached", which is a different fact from "field not present".
    asrSessionId: row.asr_session_id,
    bill: row.bill === null ? undefined : row.bill,
    sessions: sessions.map(toSession).sort((a, b) => a.startedAt - b.startedAt),
    transcripts: []
  };
}

export function toTranscriptItem(row: TranscriptRow): TranscriptItem {
  return {
    seq: row.seq,
    sourceText: row.source_text,
    targetText: row.target_text,
    sourceLang: row.source_lang,
    targetLang: row.target_lang,
    // Seconds above this line, timestamptz below it.
    ts: Date.parse(row.ts) / 1000,
    latencyMs: row.latency_ms,
    isEdited: row.is_edited
  };
}

export function fromTranscriptItem(
  sessionId: string,
  item: TranscriptItem
): TranscriptRow & { session_id: string } {
  return {
    session_id: sessionId,
    seq: item.seq,
    source_text: item.sourceText,
    target_text: item.targetText,
    source_lang: item.sourceLang,
    target_lang: item.targetLang,
    ts: new Date(item.ts * 1000).toISOString(),
    latency_ms: item.latencyMs,
    is_edited: item.isEdited
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/data/rowMappers.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 6: Typecheck**

Run: `npm run lint`
Expected: no errors. (`ProjectSession.itemCount` is required, so any construction site missing it fails here — there should be none yet outside tests.)

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/data/rowMappers.ts src/data/rowMappers.test.ts
git commit -m "feat(data): pure row mappers between Postgres rows and domain types"
```

---

### Task 3: Recording fake Supabase client

Repo tests need to assert *which statement was issued*, not just what came back. This is a chainable stand-in for the query builder that records every call and returns queued results.

**Files:**
- Create: `src/data/testing/fakeSupabase.ts`
- Test: `src/data/testing/fakeSupabase.test.ts`

**Interfaces:**
- Produces:
  - `createFakeSupabase(results?: FakeResult[])` → `{ client, calls, queueResults }`
  - `RecordedCall { table, op, payload?, columns?, filters, single }`
  - `FakeResult { data?: unknown; error?: { message: string; code?: string } | null }`
  - `client` is shaped like the subset of `SupabaseClient` the repos use, so repos take it as a constructor argument.

- [ ] **Step 1: Write the failing test**

Create `src/data/testing/fakeSupabase.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createFakeSupabase } from './fakeSupabase';

describe('createFakeSupabase', () => {
  it('records a select with its filters and returns the queued rows', async () => {
    const fake = createFakeSupabase([{ data: [{ id: 'a' }] }]);

    const { data } = await fake.client.from('projects').select('*').eq('owner_id', 'u1');

    expect(data).toEqual([{ id: 'a' }]);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({
      table: 'projects',
      op: 'select',
      columns: '*',
      filters: [{ kind: 'eq', column: 'owner_id', value: 'u1' }]
    });
  });

  // insert().select().single() must stay an insert — a trailing .select() is
  // how supabase-js asks for the inserted row back, not a second statement.
  it('keeps the operation as insert when select() follows it', async () => {
    const fake = createFakeSupabase([{ data: { id: 'new' } }]);

    const { data } = await fake.client
      .from('projects')
      .insert({ name: 'p' })
      .select()
      .single();

    expect(data).toEqual({ id: 'new' });
    expect(fake.calls[0]).toMatchObject({
      table: 'projects',
      op: 'insert',
      payload: { name: 'p' },
      single: true
    });
  });

  it('records updates with their payload and filters', async () => {
    const fake = createFakeSupabase([{ data: null }]);

    await fake.client
      .from('transcript_items')
      .update({ target_text: 'fixed', is_edited: true })
      .eq('session_id', 's1')
      .eq('seq', 4);

    expect(fake.calls[0]).toMatchObject({
      table: 'transcript_items',
      op: 'update',
      payload: { target_text: 'fixed', is_edited: true },
      filters: [
        { kind: 'eq', column: 'session_id', value: 's1' },
        { kind: 'eq', column: 'seq', value: 4 }
      ]
    });
  });

  it('records deletes', async () => {
    const fake = createFakeSupabase([{ data: null }]);
    await fake.client.from('glossary_terms').delete().eq('id', 't1');
    expect(fake.calls[0]).toMatchObject({ table: 'glossary_terms', op: 'delete' });
  });

  it('returns queued results in order, one per statement', async () => {
    const fake = createFakeSupabase([{ data: [1] }, { data: [2] }]);
    const first = await fake.client.from('a').select('*');
    const second = await fake.client.from('b').select('*');
    expect(first.data).toEqual([1]);
    expect(second.data).toEqual([2]);
  });

  it('surfaces a queued error instead of data', async () => {
    const fake = createFakeSupabase([{ error: { message: 'permission denied' } }]);
    const { data, error } = await fake.client.from('projects').select('*');
    expect(data).toBeNull();
    expect(error).toEqual({ message: 'permission denied' });
  });

  it('defaults to an empty successful result when nothing is queued', async () => {
    const fake = createFakeSupabase();
    const { data, error } = await fake.client.from('projects').select('*');
    expect(data).toBeNull();
    expect(error).toBeNull();
  });

  it('records order and limit modifiers', async () => {
    const fake = createFakeSupabase([{ data: [] }]);
    await fake.client.from('projects').select('*').order('created_at', { ascending: false }).limit(10);
    expect(fake.calls[0].filters).toEqual([
      { kind: 'order', column: 'created_at', value: { ascending: false } },
      { kind: 'limit', column: '', value: 10 }
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/data/testing/fakeSupabase.test.ts`
Expected: FAIL — cannot resolve `./fakeSupabase`.

- [ ] **Step 3: Write the implementation**

Create `src/data/testing/fakeSupabase.ts`:

```ts
/** A recording stand-in for the Supabase query builder.
 *
 *  Repo tests care about which statement was issued — table, operation,
 *  payload, filters — not about Postgres. This records exactly that and hands
 *  back queued results, so a repo can be tested in milliseconds without a
 *  database. It is a test double, never imported by application code.
 */

export interface RecordedFilter {
  kind: 'eq' | 'in' | 'order' | 'limit';
  column: string;
  value: unknown;
}

export interface RecordedCall {
  table: string;
  op: 'select' | 'insert' | 'update' | 'upsert' | 'delete';
  payload?: unknown;
  columns?: string;
  filters: RecordedFilter[];
  /** True when the caller asked for one row (.single() / .maybeSingle()). */
  single: boolean;
}

export interface FakeResult {
  data?: unknown;
  error?: { message: string; code?: string } | null;
}

export function createFakeSupabase(results: FakeResult[] = []) {
  const calls: RecordedCall[] = [];
  const queue: FakeResult[] = [...results];

  function build(call: RecordedCall) {
    const chain = {
      // Does NOT set `op`: a trailing .select() after .insert() is how
      // supabase-js asks for the written row back, not a new statement.
      select(columns?: string) {
        call.columns = columns ?? '*';
        return chain;
      },
      insert(payload: unknown) {
        call.op = 'insert';
        call.payload = payload;
        return chain;
      },
      upsert(payload: unknown) {
        call.op = 'upsert';
        call.payload = payload;
        return chain;
      },
      update(payload: unknown) {
        call.op = 'update';
        call.payload = payload;
        return chain;
      },
      delete() {
        call.op = 'delete';
        return chain;
      },
      eq(column: string, value: unknown) {
        call.filters.push({ kind: 'eq', column, value });
        return chain;
      },
      in(column: string, value: unknown) {
        call.filters.push({ kind: 'in', column, value });
        return chain;
      },
      order(column: string, options?: unknown) {
        call.filters.push({ kind: 'order', column, value: options });
        return chain;
      },
      limit(count: number) {
        call.filters.push({ kind: 'limit', column: '', value: count });
        return chain;
      },
      single() {
        call.single = true;
        return chain;
      },
      maybeSingle() {
        call.single = true;
        return chain;
      },
      // Thenable, so `await` on the chain resolves like a real query.
      then(
        onFulfilled?: (result: { data: unknown; error: unknown }) => unknown,
        onRejected?: (reason: unknown) => unknown
      ) {
        const next = queue.shift() ?? {};
        return Promise.resolve({
          data: next.data ?? null,
          error: next.error ?? null
        }).then(onFulfilled, onRejected);
      }
    };
    return chain;
  }

  return {
    client: {
      from(table: string) {
        const call: RecordedCall = { table, op: 'select', filters: [], single: false };
        calls.push(call);
        return build(call);
      }
    },
    calls,
    /** Queue more results for statements issued later in the same test. */
    queueResults(...next: FakeResult[]) {
      queue.push(...next);
    }
  };
}

/** The slice of SupabaseClient the repositories actually use. Repos take this
 *  rather than the full client, so the fake above satisfies the type. */
export type QueryClient = ReturnType<typeof createFakeSupabase>['client'];
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/data/testing/fakeSupabase.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/data/testing/fakeSupabase.ts src/data/testing/fakeSupabase.test.ts
git commit -m "test(data): recording fake for the Supabase query builder"
```

---

### Task 4: Persist-error taxonomy and the projects repo read path

Two deliverables that belong together: the error type every repo method throws, and the two queries that load data. The error type comes first because every later repo method depends on it.

**Files:**
- Create: `src/data/persistError.ts`
- Test: `src/data/persistError.test.ts`
- Create: `src/data/projectsRepo.ts`
- Test: `src/data/projectsRepo.test.ts`

**Interfaces:**
- Consumes: `createFakeSupabase`, `QueryClient` (Task 3); `toProject`, `toTranscriptItem`, `ProjectRow`, `SessionRow`, `TranscriptRow` (Task 2).
- Produces:
  - `PersistFailureReason = 'quota' | 'unavailable' | 'network' | 'auth' | 'unknown'`
  - `class PersistError extends Error { reason: PersistFailureReason }`
  - `toPersistError(error: unknown): PersistError`
  - `interface ProjectsRepo` — the full method list, implemented across Tasks 4–6
  - `createProjectsRepo(client: QueryClient): ProjectsRepo`
  - Read methods: `listProjects()`, `loadProjectTranscripts(projectId)`, `loadSessionTranscript(sessionId)`

- [ ] **Step 1: Write the failing test for the error taxonomy**

Create `src/data/persistError.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { PersistError, toPersistError } from './persistError';

describe('toPersistError', () => {
  // 42501 is Postgres "insufficient privilege" — what an RLS policy refusal
  // looks like from the client. Telling the operator to sign in again is the
  // only useful advice, so it is 'auth', not 'unknown'.
  it('maps a Postgres permission error to auth', () => {
    const error = toPersistError({ message: 'permission denied', code: '42501' });
    expect(error.reason).toBe('auth');
  });

  it('maps an expired JWT to auth', () => {
    expect(toPersistError({ message: 'JWT expired' }).reason).toBe('auth');
  });

  it('maps a fetch failure to network', () => {
    expect(toPersistError(new TypeError('Failed to fetch')).reason).toBe('network');
  });

  it('falls back to unknown, keeping the original message', () => {
    const error = toPersistError({ message: 'something odd', code: 'XX000' });
    expect(error.reason).toBe('unknown');
    expect(error.message).toBe('something odd');
  });

  it('passes an existing PersistError through unchanged', () => {
    const original = new PersistError('auth', 'already classified');
    expect(toPersistError(original)).toBe(original);
  });

  it('handles a non-object thrown value', () => {
    expect(toPersistError('boom').message).toBe('boom');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/data/persistError.test.ts`
Expected: FAIL — cannot resolve `./persistError`.

- [ ] **Step 3: Implement the error taxonomy**

Create `src/data/persistError.ts`:

```ts
/** One classification for every way a write can fail, so the banner can say
 *  something useful instead of "an error occurred".
 *
 *  'quota' and 'unavailable' survive from the localStorage era — the selected
 *  project id still lives there. 'network' and 'auth' are the database ones.
 */

export type PersistFailureReason = 'quota' | 'unavailable' | 'network' | 'auth' | 'unknown';

export type PersistResult =
  | { ok: true }
  | { ok: false; reason: PersistFailureReason; message: string };

export class PersistError extends Error {
  reason: PersistFailureReason;

  constructor(reason: PersistFailureReason, message: string) {
    super(message);
    this.name = 'PersistError';
    this.reason = reason;
  }
}

/** RLS refusals arrive as Postgres 42501, and an expired session as a JWT
 *  message. Both mean the same thing to the operator: sign in again. */
function isAuthFailure(code: string | undefined, message: string): boolean {
  if (code === '42501' || code === 'PGRST301') return true;
  return /jwt|token|not authenticated|permission denied/i.test(message);
}

export function toPersistError(error: unknown): PersistError {
  if (error instanceof PersistError) return error;

  // supabase-js surfaces a dead connection as a TypeError from fetch.
  if (error instanceof TypeError) {
    return new PersistError('network', error.message);
  }

  const asRecord = (error ?? {}) as { message?: unknown; code?: unknown };
  const message =
    typeof asRecord.message === 'string' ? asRecord.message : String(error ?? 'unknown error');
  const code = typeof asRecord.code === 'string' ? asRecord.code : undefined;

  if (/failed to fetch|network/i.test(message)) return new PersistError('network', message);
  if (isAuthFailure(code, message)) return new PersistError('auth', message);
  return new PersistError('unknown', message);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/data/persistError.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Write the failing test for the read path**

Create `src/data/projectsRepo.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createFakeSupabase } from './testing/fakeSupabase';
import { createProjectsRepo, PROJECT_SELECT } from './projectsRepo';

const projectRow = {
  id: 'proj-1',
  name: 'ประชุมวิชาการ',
  status: 'active' as const,
  created_at: '2026-01-01T00:00:00.000Z',
  ended_at: null,
  auto_finished: false,
  asr_session_id: null,
  bill: null,
  project_sessions: [
    {
      id: 'sess-1',
      project_id: 'proj-1',
      asr_session_id: 'local_1',
      started_at: '2026-01-01T00:05:00.000Z',
      ended_at: null,
      source_lang: 'th',
      target_lang: 'en',
      summary: null,
      report_item_count: null,
      summarize_runs: 0,
      item_count: 2
    }
  ]
};

describe('projectsRepo.listProjects', () => {
  it('reads projects with their sessions in one statement, newest first', async () => {
    const fake = createFakeSupabase([{ data: [projectRow] }]);
    const repo = createProjectsRepo(fake.client);

    const projects = await repo.listProjects();

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({
      table: 'projects',
      op: 'select',
      columns: PROJECT_SELECT,
      filters: [{ kind: 'order', column: 'created_at', value: { ascending: false } }]
    });
    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe('ประชุมวิชาการ');
    expect(projects[0].sessions[0].itemCount).toBe(2);
  });

  // No owner_id filter is issued on purpose: the SELECT policy already scopes
  // this to the caller. A client-side filter here would imply the client is
  // what enforces privacy, which is exactly the wrong idea to encode.
  it('does not filter by owner — RLS does that', async () => {
    const fake = createFakeSupabase([{ data: [projectRow] }]);
    await createProjectsRepo(fake.client).listProjects();
    expect(fake.calls[0].filters.some((f) => f.column === 'owner_id')).toBe(false);
  });

  it('returns an empty list when the account has no projects', async () => {
    const fake = createFakeSupabase([{ data: [] }]);
    expect(await createProjectsRepo(fake.client).listProjects()).toEqual([]);
  });

  it('throws a classified PersistError when the query fails', async () => {
    const fake = createFakeSupabase([{ error: { message: 'JWT expired' } }]);
    await expect(createProjectsRepo(fake.client).listProjects()).rejects.toMatchObject({
      reason: 'auth'
    });
  });
});

const transcriptRow = {
  session_id: 'sess-1',
  seq: 1,
  source_text: 'สวัสดี',
  target_text: 'Hello',
  source_lang: 'th',
  target_lang: 'en',
  ts: '2026-01-01T00:06:00.000Z',
  latency_ms: 300,
  is_edited: false
};

describe('projectsRepo.loadSessionTranscript', () => {
  it('reads one session ordered by seq', async () => {
    const fake = createFakeSupabase([{ data: [transcriptRow] }]);

    const items = await createProjectsRepo(fake.client).loadSessionTranscript('sess-1');

    expect(fake.calls[0]).toMatchObject({
      table: 'transcript_items',
      op: 'select',
      filters: [
        { kind: 'eq', column: 'session_id', value: 'sess-1' },
        { kind: 'order', column: 'seq', value: { ascending: true } }
      ]
    });
    expect(items).toHaveLength(1);
    expect(items[0].targetText).toBe('Hello');
    expect(items[0].ts).toBe(Date.parse('2026-01-01T00:06:00.000Z') / 1000);
  });
});

describe('projectsRepo.loadProjectTranscripts', () => {
  it('reads every session of a project in one statement, grouped by session', async () => {
    const second = { ...transcriptRow, session_id: 'sess-2', seq: 1, target_text: 'World' };
    const fake = createFakeSupabase([{ data: [transcriptRow, second] }]);

    const grouped = await createProjectsRepo(fake.client).loadProjectTranscripts('proj-1');

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({ table: 'transcript_items', op: 'select' });
    expect(Object.keys(grouped).sort()).toEqual(['sess-1', 'sess-2']);
    expect(grouped['sess-2'][0].targetText).toBe('World');
  });

  it('returns an empty map when the project has recorded nothing', async () => {
    const fake = createFakeSupabase([{ data: [] }]);
    expect(await createProjectsRepo(fake.client).loadProjectTranscripts('proj-1')).toEqual({});
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run src/data/projectsRepo.test.ts`
Expected: FAIL — cannot resolve `./projectsRepo`.

- [ ] **Step 7: Implement the read path**

Create `src/data/projectsRepo.ts`:

```ts
/** Every statement the app issues against projects, sessions and transcripts.
 *
 *  One method, roughly one statement. No filtering by owner anywhere: the RLS
 *  policies in supabase/schema-projects.sql are what scope these to the
 *  caller, and duplicating that here would suggest the client is what keeps
 *  data private. It is not.
 *
 *  Every method throws PersistError on failure. Callers turn that into the
 *  banner; nothing swallows a failed write.
 */

import type { Project, ProjectBill, ProjectSession, TranscriptItem } from '../types';
import type { QueryClient } from './testing/fakeSupabase';
import { PersistError, toPersistError } from './persistError';
import {
  fromTranscriptItem,
  toProject,
  toSession,
  toTranscriptItem,
  type ProjectRow,
  type SessionRow,
  type TranscriptRow
} from './rowMappers';

/** Projects and their sessions in one round trip. PostgREST resolves the
 *  embedded name from the foreign key on project_sessions.project_id. */
export const PROJECT_SELECT = '*, project_sessions(*)';

const SESSION_COLUMNS =
  'id, project_id, asr_session_id, started_at, ended_at, source_lang, target_lang, summary, report_item_count, summarize_runs, item_count';

const TRANSCRIPT_COLUMNS =
  'session_id, seq, source_text, target_text, source_lang, target_lang, ts, latency_ms, is_edited';

export interface ProjectsRepo {
  listProjects(): Promise<Project[]>;
  loadSessionTranscript(sessionId: string): Promise<TranscriptItem[]>;
  loadProjectTranscripts(projectId: string): Promise<Record<string, TranscriptItem[]>>;
  createProject(name: string): Promise<Project>;
  attachAsrSession(
    projectId: string,
    asrSessionId: string,
    sourceLang: string,
    targetLang: string
  ): Promise<ProjectSession>;
  endSession(sessionId: string): Promise<void>;
  detachAsrSession(projectId: string): Promise<void>;
  appendCaption(sessionId: string, item: TranscriptItem): Promise<void>;
  editCaption(sessionId: string, seq: number, targetText: string): Promise<void>;
  markSummarizing(sessionId: string, runs: number): Promise<void>;
  saveSummary(sessionId: string, summary: string, reportItemCount: number): Promise<void>;
  finishProject(
    projectId: string,
    bill: ProjectBill,
    endedAt: number,
    openSessionIds: string[]
  ): Promise<void>;
}

/** Unwraps a supabase-js result, turning its error into a PersistError. */
function unwrap<T>(result: { data: unknown; error: unknown }): T {
  if (result.error) throw toPersistError(result.error);
  return result.data as T;
}

export function createProjectsRepo(client: QueryClient): ProjectsRepo {
  return {
    async listProjects() {
      const rows = unwrap<(ProjectRow & { project_sessions: SessionRow[] })[]>(
        await client.from('projects').select(PROJECT_SELECT).order('created_at', { ascending: false })
      );
      return (rows ?? []).map((row) => toProject(row, row.project_sessions ?? []));
    },

    async loadSessionTranscript(sessionId) {
      const rows = unwrap<TranscriptRow[]>(
        await client
          .from('transcript_items')
          .select(TRANSCRIPT_COLUMNS)
          .eq('session_id', sessionId)
          .order('seq', { ascending: true })
      );
      return (rows ?? []).map(toTranscriptItem);
    },

    async loadProjectTranscripts(projectId) {
      // One statement for the whole project: the running cost badge needs
      // every session's captions, and a query per session would be N round
      // trips on every project switch.
      const rows = unwrap<(TranscriptRow & { session_id: string })[]>(
        await client
          .from('transcript_items')
          .select(`${TRANSCRIPT_COLUMNS}, project_sessions!inner(project_id)`)
          .eq('project_sessions.project_id', projectId)
          .order('seq', { ascending: true })
      );

      const grouped: Record<string, TranscriptItem[]> = {};
      for (const row of rows ?? []) {
        (grouped[row.session_id] ||= []).push(toTranscriptItem(row));
      }
      return grouped;
    },

    // Implemented in Task 5.
    async createProject() {
      throw new PersistError('unknown', 'not implemented');
    },
    async attachAsrSession() {
      throw new PersistError('unknown', 'not implemented');
    },
    async endSession() {
      throw new PersistError('unknown', 'not implemented');
    },
    async detachAsrSession() {
      throw new PersistError('unknown', 'not implemented');
    },
    async finishProject() {
      throw new PersistError('unknown', 'not implemented');
    },

    // Implemented in Task 6.
    async appendCaption() {
      throw new PersistError('unknown', 'not implemented');
    },
    async editCaption() {
      throw new PersistError('unknown', 'not implemented');
    },
    async markSummarizing() {
      throw new PersistError('unknown', 'not implemented');
    },
    async saveSummary() {
      throw new PersistError('unknown', 'not implemented');
    }
  };
}
```

Note the unused imports (`fromTranscriptItem`, `toSession`, `SESSION_COLUMNS`) are used by Tasks 5 and 6. If `npm run lint` objects to them now, add them in the task that uses them instead.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run src/data/projectsRepo.test.ts src/data/persistError.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 9: Commit**

```bash
git add src/data/persistError.ts src/data/persistError.test.ts \
        src/data/projectsRepo.ts src/data/projectsRepo.test.ts
git commit -m "feat(data): persist-error taxonomy and projects repo read path"
```

---

### Task 5: Projects repo — project and session lifecycle writes

**Files:**
- Modify: `src/data/projectsRepo.ts` (replace the Task 4 lifecycle stubs)
- Test: `src/data/projectsRepo.test.ts` (append)

**Interfaces:**
- Consumes: `unwrap`, `PROJECT_SELECT`, `SESSION_COLUMNS`, `createProjectsRepo` (Task 4); `toProject`, `toSession` (Task 2).
- Produces: working `createProject`, `attachAsrSession`, `endSession`, `detachAsrSession`, `finishProject`.

- [ ] **Step 1: Write the failing tests**

Append to `src/data/projectsRepo.test.ts`:

```ts
describe('projectsRepo.createProject', () => {
  it('inserts the project and returns the created record', async () => {
    const fake = createFakeSupabase([
      { data: { ...projectRow, id: 'proj-new', name: 'สัมมนา', project_sessions: [] } }
    ]);

    const project = await createProjectsRepo(fake.client).createProject('  สัมมนา  ');

    expect(fake.calls[0]).toMatchObject({
      table: 'projects',
      op: 'insert',
      payload: { name: 'สัมมนา', status: 'active' },
      single: true
    });
    expect(project.id).toBe('proj-new');
    expect(project.sessions).toEqual([]);
  });

  // owner_id is omitted on purpose: the column defaults to auth.uid(), so the
  // database stamps it and the client cannot claim to be someone else.
  it('does not send owner_id — the column default stamps it', async () => {
    const fake = createFakeSupabase([{ data: { ...projectRow, project_sessions: [] } }]);
    await createProjectsRepo(fake.client).createProject('x');
    expect(fake.calls[0].payload).not.toHaveProperty('owner_id');
  });

  it('throws a classified error when the insert is refused', async () => {
    const fake = createFakeSupabase([{ error: { message: 'permission denied', code: '42501' } }]);
    await expect(createProjectsRepo(fake.client).createProject('x')).rejects.toMatchObject({
      reason: 'auth'
    });
  });
});

const newSessionRow = {
  id: 'sess-new',
  project_id: 'proj-1',
  asr_session_id: 'local_2',
  started_at: '2026-01-01T01:00:00.000Z',
  ended_at: null,
  source_lang: 'th',
  target_lang: 'en',
  summary: null,
  report_item_count: null,
  summarize_runs: 0,
  item_count: 0
};

describe('projectsRepo.attachAsrSession', () => {
  it('closes any session still open, inserts the new one, and points the project at it', async () => {
    const fake = createFakeSupabase([
      { data: null },            // close open sessions
      { data: newSessionRow },   // insert the new session
      { data: null }             // point the project at it
    ]);

    const session = await createProjectsRepo(fake.client).attachAsrSession(
      'proj-1',
      'local_2',
      'th',
      'en'
    );

    // A session left open by a reconnect must be closed in the same action, or
    // startSession's "already have an open session" guard silently drops the
    // new recording.
    expect(fake.calls[0]).toMatchObject({
      table: 'project_sessions',
      op: 'update',
      filters: [
        { kind: 'eq', column: 'project_id', value: 'proj-1' },
        { kind: 'is', column: 'ended_at', value: null }
      ]
    });
    expect(fake.calls[1]).toMatchObject({
      table: 'project_sessions',
      op: 'insert',
      payload: {
        project_id: 'proj-1',
        asr_session_id: 'local_2',
        source_lang: 'th',
        target_lang: 'en'
      },
      single: true
    });
    expect(fake.calls[2]).toMatchObject({
      table: 'projects',
      op: 'update',
      payload: { asr_session_id: 'local_2' },
      filters: [{ kind: 'eq', column: 'id', value: 'proj-1' }]
    });
    expect(session.id).toBe('sess-new');
    expect(session.itemCount).toBe(0);
  });
});

describe('projectsRepo.endSession', () => {
  it('stamps ended_at on that session only', async () => {
    const fake = createFakeSupabase([{ data: null }]);
    await createProjectsRepo(fake.client).endSession('sess-1');

    expect(fake.calls[0]).toMatchObject({
      table: 'project_sessions',
      op: 'update',
      filters: [{ kind: 'eq', column: 'id', value: 'sess-1' }]
    });
    expect((fake.calls[0].payload as { ended_at: string }).ended_at).toEqual(expect.any(String));
  });
});

describe('projectsRepo.detachAsrSession', () => {
  it('clears the project pointer', async () => {
    const fake = createFakeSupabase([{ data: null }]);
    await createProjectsRepo(fake.client).detachAsrSession('proj-1');
    expect(fake.calls[0]).toMatchObject({
      table: 'projects',
      op: 'update',
      payload: { asr_session_id: null },
      filters: [{ kind: 'eq', column: 'id', value: 'proj-1' }]
    });
  });
});

describe('projectsRepo.finishProject', () => {
  const bill = { sessionCount: 1, durationMs: 60000, wordCount: 10, estimatedCost: 0.01 };

  it('closes the named open sessions first, then marks the project ended', async () => {
    const fake = createFakeSupabase([{ data: null }, { data: null }]);

    await createProjectsRepo(fake.client).finishProject('proj-1', bill, 1767225600000, ['sess-1']);

    // Sessions first: if the second statement fails the project stays active
    // with its sessions closed, which is recoverable. The reverse order would
    // leave an ended project holding a session that never stops billing.
    expect(fake.calls[0]).toMatchObject({
      table: 'project_sessions',
      op: 'update',
      filters: [{ kind: 'in', column: 'id', value: ['sess-1'] }]
    });
    expect(fake.calls[1]).toMatchObject({
      table: 'projects',
      op: 'update',
      payload: {
        status: 'ended',
        bill,
        asr_session_id: null,
        ended_at: new Date(1767225600000).toISOString()
      },
      filters: [{ kind: 'eq', column: 'id', value: 'proj-1' }]
    });
  });

  it('skips the session statement when nothing is open', async () => {
    const fake = createFakeSupabase([{ data: null }]);
    await createProjectsRepo(fake.client).finishProject('proj-1', bill, 1767225600000, []);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].table).toBe('projects');
  });
});
```

- [ ] **Step 2: Add `is` to the fake query builder**

`attachAsrSession` filters on `ended_at is null`, which the Task 3 fake does not yet record. In `src/data/testing/fakeSupabase.ts`, widen `RecordedFilter['kind']` to include `'is'` and add the method next to `eq`:

```ts
      is(column: string, value: unknown) {
        call.filters.push({ kind: 'is', column, value });
        return chain;
      },
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/data/projectsRepo.test.ts`
Expected: FAIL on the new describes with "not implemented".

- [ ] **Step 4: Implement the lifecycle writes**

In `src/data/projectsRepo.ts`, replace the five Task 4 lifecycle stubs with:

```ts
    async createProject(name) {
      // owner_id is omitted deliberately: the column defaults to auth.uid(),
      // so the database decides who owns this and the client cannot lie.
      const row = unwrap<ProjectRow & { project_sessions?: SessionRow[] }>(
        await client
          .from('projects')
          .insert({ name: name.trim(), status: 'active' })
          .select(PROJECT_SELECT)
          .single()
      );
      return toProject(row, row.project_sessions ?? []);
    },

    async attachAsrSession(projectId, asrSessionId, sourceLang, targetLang) {
      const now = new Date().toISOString();

      // Close anything left open first. A dropped websocket that reconnected
      // under a new id leaves the old session running; if it is still open
      // when the new one is inserted, the "one open session" guard upstream
      // discards the new recording.
      unwrap(
        await client
          .from('project_sessions')
          .update({ ended_at: now })
          .eq('project_id', projectId)
          .is('ended_at', null)
      );

      const row = unwrap<SessionRow>(
        await client
          .from('project_sessions')
          .insert({
            project_id: projectId,
            asr_session_id: asrSessionId,
            source_lang: sourceLang,
            target_lang: targetLang,
            started_at: now
          })
          .select(SESSION_COLUMNS)
          .single()
      );

      unwrap(
        await client.from('projects').update({ asr_session_id: asrSessionId }).eq('id', projectId)
      );

      return toSession(row);
    },

    async endSession(sessionId) {
      unwrap(
        await client
          .from('project_sessions')
          .update({ ended_at: new Date().toISOString() })
          .eq('id', sessionId)
      );
    },

    async detachAsrSession(projectId) {
      unwrap(await client.from('projects').update({ asr_session_id: null }).eq('id', projectId));
    },

    async finishProject(projectId, bill, endedAt, openSessionIds) {
      const stamp = new Date(endedAt).toISOString();

      // Sessions first. PostgREST has no transaction across statements, so
      // order is the only control available: a failure after this point
      // leaves an active project whose sessions are closed, which the next
      // finish attempt fixes. The reverse order would leave an ended project
      // holding an open session that keeps accruing time.
      if (openSessionIds.length > 0) {
        unwrap(
          await client
            .from('project_sessions')
            .update({ ended_at: stamp })
            .in('id', openSessionIds)
        );
      }

      unwrap(
        await client
          .from('projects')
          .update({ status: 'ended', ended_at: stamp, bill, asr_session_id: null })
          .eq('id', projectId)
      );
    },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/data/projectsRepo.test.ts`
Expected: PASS — the Task 4 read tests plus 8 new ones.

- [ ] **Step 6: Commit**

```bash
git add src/data/projectsRepo.ts src/data/projectsRepo.test.ts src/data/testing/fakeSupabase.ts
git commit -m "feat(data): project and session lifecycle writes"
```

---

### Task 6: Projects repo — caption and summary writes

The hot path. `appendCaption` runs once per spoken sentence for the length of a meeting.

**Files:**
- Modify: `src/data/projectsRepo.ts` (replace the Task 4 caption/summary stubs)
- Test: `src/data/projectsRepo.test.ts` (append)

**Interfaces:**
- Consumes: `fromTranscriptItem` (Task 2), `unwrap` (Task 4).
- Produces: working `appendCaption`, `editCaption`, `markSummarizing`, `saveSummary`.

- [ ] **Step 1: Write the failing tests**

Append to `src/data/projectsRepo.test.ts`:

```ts
const caption = {
  seq: 7,
  sourceText: 'สวัสดีครับ',
  targetText: 'Hello',
  sourceLang: 'th',
  targetLang: 'en',
  ts: Date.parse('2026-01-01T00:10:00.000Z') / 1000,
  latencyMs: 250,
  isEdited: false
};

describe('projectsRepo.appendCaption', () => {
  it('upserts one row keyed by (session_id, seq)', async () => {
    const fake = createFakeSupabase([{ data: null }]);

    await createProjectsRepo(fake.client).appendCaption('sess-1', caption);

    // Upsert, not insert: a retry after a timeout that actually succeeded
    // must not fail on the primary key and strand the retry queue.
    expect(fake.calls[0]).toMatchObject({
      table: 'transcript_items',
      op: 'upsert',
      payload: {
        session_id: 'sess-1',
        seq: 7,
        source_text: 'สวัสดีครับ',
        target_text: 'Hello',
        ts: '2026-01-01T00:10:00.000Z',
        latency_ms: 250,
        is_edited: false
      }
    });
  });

  it('throws a classified error when the write is refused', async () => {
    const fake = createFakeSupabase([{ error: new TypeError('Failed to fetch') }]);
    await expect(
      createProjectsRepo(fake.client).appendCaption('sess-1', caption)
    ).rejects.toMatchObject({ reason: 'network' });
  });
});

describe('projectsRepo.editCaption', () => {
  it('updates one row and marks it edited', async () => {
    const fake = createFakeSupabase([{ data: null }]);

    await createProjectsRepo(fake.client).editCaption('sess-1', 7, 'Good morning');

    expect(fake.calls[0]).toMatchObject({
      table: 'transcript_items',
      op: 'update',
      payload: { target_text: 'Good morning', is_edited: true },
      filters: [
        { kind: 'eq', column: 'session_id', value: 'sess-1' },
        { kind: 'eq', column: 'seq', value: 7 }
      ]
    });
  });
});

describe('projectsRepo.markSummarizing', () => {
  // The run counter is persisted even though the spinner is not: every
  // attempt spends tokens, so a retry that fails must still be billed.
  it('writes the caller-computed run count', async () => {
    const fake = createFakeSupabase([{ data: null }]);
    await createProjectsRepo(fake.client).markSummarizing('sess-1', 3);
    expect(fake.calls[0]).toMatchObject({
      table: 'project_sessions',
      op: 'update',
      payload: { summarize_runs: 3 },
      filters: [{ kind: 'eq', column: 'id', value: 'sess-1' }]
    });
  });
});

describe('projectsRepo.saveSummary', () => {
  it('stores a real summary with the item count sent to the summariser', async () => {
    const fake = createFakeSupabase([{ data: null }]);
    await createProjectsRepo(fake.client).saveSummary('sess-1', 'สรุปการประชุม', 42);
    expect(fake.calls[0]).toMatchObject({
      table: 'project_sessions',
      op: 'update',
      payload: { summary: 'สรุปการประชุม', report_item_count: 42 }
    });
  });

  // '' must reach the column as '', never as null: null would read back as
  // "nobody asked for a summary" and hide the failure from the operator.
  it('stores a failed summary as an empty string, not null', async () => {
    const fake = createFakeSupabase([{ data: null }]);
    await createProjectsRepo(fake.client).saveSummary('sess-1', '', 42);
    expect((fake.calls[0].payload as { summary: unknown }).summary).toBe('');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/data/projectsRepo.test.ts`
Expected: FAIL on the new describes with "not implemented".

- [ ] **Step 3: Implement the caption and summary writes**

In `src/data/projectsRepo.ts`, replace the four Task 4 stubs with:

```ts
    async appendCaption(sessionId, item) {
      // Upsert rather than insert: a caption whose write timed out may have
      // landed anyway, and the retry queue must not deadlock on a duplicate
      // key. (session_id, seq) is the primary key, so this is idempotent.
      unwrap(
        await client
          .from('transcript_items')
          .upsert(fromTranscriptItem(sessionId, item), { onConflict: 'session_id,seq' })
      );
    },

    async editCaption(sessionId, seq, targetText) {
      unwrap(
        await client
          .from('transcript_items')
          .update({ target_text: targetText, is_edited: true })
          .eq('session_id', sessionId)
          .eq('seq', seq)
      );
    },

    async markSummarizing(sessionId, runs) {
      // Counted by the caller, which knows the previous value. Postgres has no
      // "increment" through PostgREST without an RPC, and the count only has
      // to be right, not race-proof: one operator, one console.
      unwrap(
        await client.from('project_sessions').update({ summarize_runs: runs }).eq('id', sessionId)
      );
    },

    async saveSummary(sessionId, summary, reportItemCount) {
      // `summary` may legitimately be '' — that is how a failed AI call is
      // recorded. It must not become null on the way to the column.
      unwrap(
        await client
          .from('project_sessions')
          .update({ summary, report_item_count: reportItemCount })
          .eq('id', sessionId)
      );
    },
```

- [ ] **Step 4: Allow upsert options in the fake**

In `src/data/testing/fakeSupabase.ts`, widen `upsert` to accept and ignore the options argument:

```ts
      upsert(payload: unknown, _options?: unknown) {
        call.op = 'upsert';
        call.payload = payload;
        return chain;
      },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/data/projectsRepo.test.ts`
Expected: PASS — all read, lifecycle and caption tests.

- [ ] **Step 6: Typecheck**

Run: `npm run lint`
Expected: no errors. Every import added in Task 4 is now used.

- [ ] **Step 7: Commit**

```bash
git add src/data/projectsRepo.ts src/data/projectsRepo.test.ts src/data/testing/fakeSupabase.ts
git commit -m "feat(data): caption and summary writes"
```

---

### Task 7: The glossary merge rule

Pure, self-contained, and the one place the precedence rule lives.

**Files:**
- Create: `src/data/glossaryMerge.ts`
- Test: `src/data/glossaryMerge.test.ts`

**Interfaces:**
- Consumes: `GlossarySections`, `GlossarySection`, `emptyGlossary` from `src/glossary.ts`.
- Produces: `mergeGlossary(shared: GlossarySections[], own: GlossarySections): GlossarySections`

- [ ] **Step 1: Write the failing test**

Create `src/data/glossaryMerge.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { emptyGlossary, type GlossarySections } from '../glossary';
import { mergeGlossary } from './glossaryMerge';

function sections(overrides: Partial<GlossarySections>): GlossarySections {
  return { ...emptyGlossary(), ...overrides };
}

describe('mergeGlossary', () => {
  it('returns an empty glossary when there is nothing to merge', () => {
    expect(mergeGlossary([], emptyGlossary())).toEqual(emptyGlossary());
  });

  it('combines terms from several shared lists', () => {
    const names = sections({ person_names: { 'สมชาย': 'Somchai' } });
    const terms = sections({ protected_terms: { 'ภาควิชา': 'Department' } });

    const merged = mergeGlossary([names, terms], emptyGlossary());

    expect(merged.person_names).toEqual({ 'สมชาย': 'Somchai' });
    expect(merged.protected_terms).toEqual({ 'ภาควิชา': 'Department' });
  });

  it('merges sections independently — a term in one never leaks into another', () => {
    const shared = sections({ person_names: { 'ก': 'A' } });
    const own = sections({ protected_terms: { 'ข': 'B' } });

    const merged = mergeGlossary([shared], own);

    expect(merged.person_names).toEqual({ 'ก': 'A' });
    expect(merged.protected_terms).toEqual({ 'ข': 'B' });
    expect(merged.thai_corrections).toEqual({});
    expect(merged.en_th_corrections).toEqual({});
  });

  it('applies shared lists in order — a later list wins over an earlier one', () => {
    const first = sections({ person_names: { 'สมชาย': 'Somchai' } });
    const second = sections({ person_names: { 'สมชาย': 'Somchai Jaidee' } });

    expect(mergeGlossary([first, second], emptyGlossary()).person_names).toEqual({
      'สมชาย': 'Somchai Jaidee'
    });
  });

  // The rule that matters: an operator correcting a wrong shared term during a
  // live meeting must win, or the correction is useless.
  it("lets the project's own term override a shared one", () => {
    const shared = sections({ person_names: { 'สมชาย': 'Somchai' } });
    const own = sections({ person_names: { 'สมชาย': 'Dr. Somchai' } });

    expect(mergeGlossary([shared], own).person_names).toEqual({ 'สมชาย': 'Dr. Somchai' });
  });

  it('does not mutate its inputs', () => {
    const shared = sections({ person_names: { 'ก': 'A' } });
    const own = sections({ person_names: { 'ก': 'B' } });

    mergeGlossary([shared], own);

    expect(shared.person_names).toEqual({ 'ก': 'A' });
    expect(own.person_names).toEqual({ 'ก': 'B' });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/data/glossaryMerge.test.ts`
Expected: FAIL — cannot resolve `./glossaryMerge`.

- [ ] **Step 3: Implement the merge**

Create `src/data/glossaryMerge.ts`:

```ts
/** Folds the glossary lists a project uses into the single GlossarySections
 *  the capture hook and the dictionary UI already understand.
 *
 *  Precedence, lowest to highest: shared lists in the order given, then the
 *  project's own list. The project wins because an operator correcting a
 *  wrong shared term mid-meeting has to see that correction take effect —
 *  a canonical list that cannot be overridden locally is a canonical list
 *  people work around.
 */

import { emptyGlossary, type GlossarySection, type GlossarySections } from '../glossary';

export function mergeGlossary(
  shared: GlossarySections[],
  own: GlossarySections
): GlossarySections {
  const result = emptyGlossary();
  const keys = Object.keys(result) as GlossarySection[];

  for (const source of [...shared, own]) {
    for (const key of keys) {
      // Sections never mix: a person name cannot become a protected term by
      // being merged.
      Object.assign(result[key], source[key] ?? {});
    }
  }

  return result;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/data/glossaryMerge.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/data/glossaryMerge.ts src/data/glossaryMerge.test.ts
git commit -m "feat(data): glossary merge precedence rule"
```

---

### Task 8: Glossary repo

**Files:**
- Create: `src/data/glossaryRepo.ts`
- Test: `src/data/glossaryRepo.test.ts`

**Interfaces:**
- Consumes: `QueryClient`, `createFakeSupabase` (Task 3); `toPersistError` (Task 4); `GlossarySections`, `GlossarySection`, `emptyGlossary` from `src/glossary.ts`.
- Produces:
  - `interface GlossaryList { id: string; name: string; description: string | null; scope: 'shared' | 'project'; isDefault: boolean }`
  - `createGlossaryRepo(client: QueryClient): GlossaryRepo` with `listSharedLists()`, `loadProjectLists(projectId)`, `loadTerms(listIds)`, `subscribeList(projectId, listId)`, `unsubscribeList(projectId, listId)`, `addTerm(listId, section, term, translation)`, `removeTerm(listId, section, term)`

Note: term methods take the **list id**, not the project id. The hook already knows the project's own list id from `loadProjectLists`, so passing it avoids a lookup on every keystroke.

- [ ] **Step 1: Write the failing test**

Create `src/data/glossaryRepo.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createFakeSupabase } from './testing/fakeSupabase';
import { createGlossaryRepo } from './glossaryRepo';

const sharedListRow = {
  id: 'list-shared',
  name: 'ชื่อบุคคล (อังกฤษ → ไทย)',
  description: 'รายชื่อผู้บริหาร',
  scope: 'shared' as const,
  is_default: true
};

const ownListRow = {
  id: 'list-own',
  name: 'ศัพท์เฉพาะของโปรเจกต์นี้',
  description: null,
  scope: 'project' as const,
  is_default: false
};

describe('glossaryRepo.listSharedLists', () => {
  it('reads every shared list, newest name order stable by created_at', async () => {
    const fake = createFakeSupabase([{ data: [sharedListRow] }]);

    const lists = await createGlossaryRepo(fake.client).listSharedLists();

    expect(fake.calls[0]).toMatchObject({
      table: 'glossary_lists',
      op: 'select',
      filters: [
        { kind: 'eq', column: 'scope', value: 'shared' },
        { kind: 'order', column: 'created_at', value: { ascending: true } }
      ]
    });
    expect(lists).toEqual([
      {
        id: 'list-shared',
        name: 'ชื่อบุคคล (อังกฤษ → ไทย)',
        description: 'รายชื่อผู้บริหาร',
        scope: 'shared',
        isDefault: true
      }
    ]);
  });
});

describe('glossaryRepo.loadProjectLists', () => {
  it("separates the project's own list from the shared lists it subscribes to", async () => {
    const fake = createFakeSupabase([
      { data: [ownListRow] },                                   // the own list
      { data: [{ list_id: 'list-shared', glossary_lists: sharedListRow }] } // subscriptions
    ]);

    const result = await createGlossaryRepo(fake.client).loadProjectLists('proj-1');

    expect(fake.calls[0]).toMatchObject({
      table: 'glossary_lists',
      filters: [
        { kind: 'eq', column: 'project_id', value: 'proj-1' },
        { kind: 'eq', column: 'scope', value: 'project' }
      ]
    });
    expect(fake.calls[1]).toMatchObject({
      table: 'project_glossary_lists',
      filters: [{ kind: 'eq', column: 'project_id', value: 'proj-1' }]
    });
    expect(result.own?.id).toBe('list-own');
    expect(result.subscribed.map((l) => l.id)).toEqual(['list-shared']);
  });

  // The trigger creates the own list, so this should never happen — but a
  // null return is far better than a crash if it somehow does.
  it('returns a null own list rather than throwing when none exists', async () => {
    const fake = createFakeSupabase([{ data: [] }, { data: [] }]);
    const result = await createGlossaryRepo(fake.client).loadProjectLists('proj-1');
    expect(result.own).toBeNull();
    expect(result.subscribed).toEqual([]);
  });
});

describe('glossaryRepo.loadTerms', () => {
  it('reads every requested list in one statement, grouped into sections', async () => {
    const fake = createFakeSupabase([
      {
        data: [
          { list_id: 'list-shared', section: 'person_names', term: 'สมชาย', translation: 'Somchai' },
          { list_id: 'list-own', section: 'protected_terms', term: 'ภาควิชา', translation: 'Dept' }
        ]
      }
    ]);

    const byList = await createGlossaryRepo(fake.client).loadTerms(['list-shared', 'list-own']);

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({
      table: 'glossary_terms',
      op: 'select',
      filters: [{ kind: 'in', column: 'list_id', value: ['list-shared', 'list-own'] }]
    });
    expect(byList['list-shared'].person_names).toEqual({ 'สมชาย': 'Somchai' });
    expect(byList['list-own'].protected_terms).toEqual({ 'ภาควิชา': 'Dept' });
    // Every requested list gets an entry, even an empty one, so callers can
    // index without guarding.
    expect(byList['list-shared'].protected_terms).toEqual({});
  });

  it('issues no statement at all for an empty list of ids', async () => {
    const fake = createFakeSupabase();
    expect(await createGlossaryRepo(fake.client).loadTerms([])).toEqual({});
    expect(fake.calls).toHaveLength(0);
  });
});

describe('glossaryRepo subscriptions', () => {
  it('subscribes a project to a shared list', async () => {
    const fake = createFakeSupabase([{ data: null }]);
    await createGlossaryRepo(fake.client).subscribeList('proj-1', 'list-shared');
    expect(fake.calls[0]).toMatchObject({
      table: 'project_glossary_lists',
      op: 'upsert',
      payload: { project_id: 'proj-1', list_id: 'list-shared' }
    });
  });

  it('unsubscribes a project from a shared list', async () => {
    const fake = createFakeSupabase([{ data: null }]);
    await createGlossaryRepo(fake.client).unsubscribeList('proj-1', 'list-shared');
    expect(fake.calls[0]).toMatchObject({
      table: 'project_glossary_lists',
      op: 'delete',
      filters: [
        { kind: 'eq', column: 'project_id', value: 'proj-1' },
        { kind: 'eq', column: 'list_id', value: 'list-shared' }
      ]
    });
  });
});

describe('glossaryRepo terms', () => {
  it('upserts a term into the given list', async () => {
    const fake = createFakeSupabase([{ data: null }]);
    await createGlossaryRepo(fake.client).addTerm('list-own', 'person_names', ' สมชาย ', ' Somchai ');
    expect(fake.calls[0]).toMatchObject({
      table: 'glossary_terms',
      op: 'upsert',
      // Trimmed: a stray space would create a second, invisible entry that
      // never matches anything the recogniser hears.
      payload: {
        list_id: 'list-own',
        section: 'person_names',
        term: 'สมชาย',
        translation: 'Somchai'
      }
    });
  });

  it('removes a term from the given list', async () => {
    const fake = createFakeSupabase([{ data: null }]);
    await createGlossaryRepo(fake.client).removeTerm('list-own', 'person_names', 'สมชาย');
    expect(fake.calls[0]).toMatchObject({
      table: 'glossary_terms',
      op: 'delete',
      filters: [
        { kind: 'eq', column: 'list_id', value: 'list-own' },
        { kind: 'eq', column: 'section', value: 'person_names' },
        { kind: 'eq', column: 'term', value: 'สมชาย' }
      ]
    });
  });

  it('throws a classified error when a term write is refused', async () => {
    const fake = createFakeSupabase([{ error: { message: 'permission denied', code: '42501' } }]);
    await expect(
      createGlossaryRepo(fake.client).addTerm('list-shared', 'person_names', 'a', 'b')
    ).rejects.toMatchObject({ reason: 'auth' });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/data/glossaryRepo.test.ts`
Expected: FAIL — cannot resolve `./glossaryRepo`.

- [ ] **Step 3: Implement the repo**

Create `src/data/glossaryRepo.ts`:

```ts
/** Every statement against glossary lists, terms and subscriptions.
 *
 *  Shared lists are read-only here by design: they have no write policy in
 *  the database, so an addTerm against one fails with 42501 rather than
 *  silently doing nothing. Terms are addressed by LIST id, not project id —
 *  the caller already knows which list it is writing to, and a lookup on
 *  every keystroke would be waste.
 */

import { emptyGlossary, type GlossarySection, type GlossarySections } from '../glossary';
import type { QueryClient } from './testing/fakeSupabase';
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/data/glossaryRepo.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/data/glossaryRepo.ts src/data/glossaryRepo.test.ts
git commit -m "feat(data): glossary list, term and subscription repo"
```

---

### Task 9: Rewrite `useProjects` on top of the repo

The centre of the change. The hook keeps local React state as the render cache so the UI stays instant, but every action now issues one mutation instead of rewriting a blob.

**Files:**
- Rewrite: `src/storage/projectStore.ts`
- Rewrite: `src/hooks/useProjects.ts`
- Rewrite: `src/hooks/useProjects.test.ts`
- Delete: `src/storage/projectStore.test.ts` (its subject, the `Project[]` blob adapter, no longer exists)

**Interfaces:**
- Consumes: `ProjectsRepo`, `createProjectsRepo` (Tasks 4–6); `PersistError`, `PersistFailureReason` (Task 4).
- Produces: `useProjects({ repo, userId })` returning everything it returns today, minus `startSession`, plus `loading: boolean` and an async `finishProject`.

**Two API changes callers must know about:**
- `finishProject(liveTranscripts, liveAsrSessionId)` is now **async** and returns `Promise<Project | undefined>`.
- `startSession` is **removed**. No component calls it (`attachAsrSession` is the only entry point used by `src/pages/Admin.tsx:198`), and it existed only to guard against a second open session — a guard `attachAsrSession` now performs in SQL.

- [ ] **Step 1: Reduce `projectStore.ts` to the selected-project helper**

Replace the whole of `src/storage/projectStore.ts` with:

```ts
/** Which project is open, remembered per device.
 *
 *  Everything else moved to Postgres (src/data/projectsRepo.ts). This one
 *  stays local on purpose: it is UI state, not data. Two screens signed in as
 *  the same person should each keep their own open project rather than fight
 *  over one shared value.
 */

import type { PersistResult } from '../data/persistError';

export const SELECTED_KEY = 'ai_translate_selected_project';

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    // Some browsers throw on the accessor itself when site data is blocked.
    return undefined;
  }
}

export function loadSelectedId(): string | null {
  try {
    return safeStorage()?.getItem(SELECTED_KEY) ?? null;
  } catch {
    return null;
  }
}

export function saveSelectedId(id: string | null): PersistResult {
  const storage = safeStorage();
  if (!storage) {
    return {
      ok: false,
      reason: 'unavailable',
      message: 'localStorage is not available in this browser context'
    };
  }
  try {
    if (id) storage.setItem(SELECTED_KEY, id);
    else storage.removeItem(SELECTED_KEY);
    return { ok: true };
  } catch (error) {
    // Losing which project was open is a cosmetic failure — the project
    // itself is safe in the database — so this does not raise the banner.
    return { ok: false, reason: 'unknown', message: String(error) };
  }
}
```

- [ ] **Step 2: Delete the obsolete store test**

```bash
git rm src/storage/projectStore.test.ts
```

- [ ] **Step 3: Write the failing test for the new hook**

Replace the whole of `src/hooks/useProjects.test.ts` with:

```ts
// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useProjects } from './useProjects';
import { PersistError } from '../data/persistError';
import type { ProjectsRepo } from '../data/projectsRepo';
import type { Project, ProjectSession, TranscriptItem } from '../types';

const USER = 'user-1';

function session(overrides: Partial<ProjectSession> = {}): ProjectSession {
  return {
    id: 'sess-1',
    asrSessionId: 'local_1',
    startedAt: Date.parse('2026-01-01T00:00:00.000Z'),
    sourceLang: 'th',
    targetLang: 'en',
    summarizeRuns: 0,
    itemCount: 0,
    ...overrides
  };
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'ประชุม',
    status: 'active',
    sessions: [],
    transcripts: [],
    createdAt: Date.parse('2026-01-01T00:00:00.000Z'),
    asrSessionId: null,
    ...overrides
  };
}

/** A repo whose every method is a spy, seeded with one active project. */
function fakeRepo(overrides: Partial<ProjectsRepo> = {}): ProjectsRepo {
  return {
    listProjects: vi.fn().mockResolvedValue([project()]),
    loadSessionTranscript: vi.fn().mockResolvedValue([]),
    loadProjectTranscripts: vi.fn().mockResolvedValue({}),
    createProject: vi.fn().mockResolvedValue(project({ id: 'proj-new', name: 'ใหม่' })),
    attachAsrSession: vi.fn().mockResolvedValue(session({ id: 'sess-new', asrSessionId: 'local_2' })),
    endSession: vi.fn().mockResolvedValue(undefined),
    detachAsrSession: vi.fn().mockResolvedValue(undefined),
    appendCaption: vi.fn().mockResolvedValue(undefined),
    editCaption: vi.fn().mockResolvedValue(undefined),
    markSummarizing: vi.fn().mockResolvedValue(undefined),
    saveSummary: vi.fn().mockResolvedValue(undefined),
    finishProject: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

async function renderLoaded(repo: ProjectsRepo) {
  const view = renderHook(() => useProjects({ repo, userId: USER }));
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  return view;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useProjects — loading', () => {
  it('starts loading and fills in from the repo', async () => {
    const repo = fakeRepo();
    const { result } = renderHook(() => useProjects({ repo, userId: USER }));

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.activeProjects).toHaveLength(1);
  });

  // A signed-out or unapproved caller must not see the previous account's
  // projects on a shared machine.
  it('loads nothing and stays empty when there is no user', async () => {
    const repo = fakeRepo();
    const { result } = renderHook(() => useProjects({ repo, userId: null }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(repo.listProjects).not.toHaveBeenCalled();
    expect(result.current.activeProjects).toEqual([]);
  });

  it('clears the cache when the user signs out', async () => {
    const repo = fakeRepo();
    const { result, rerender } = renderHook(
      ({ userId }) => useProjects({ repo, userId }),
      { initialProps: { userId: USER as string | null } }
    );
    await waitFor(() => expect(result.current.activeProjects).toHaveLength(1));

    rerender({ userId: null });

    await waitFor(() => expect(result.current.activeProjects).toEqual([]));
  });

  it('reports a failed load through persistError', async () => {
    const repo = fakeRepo({
      listProjects: vi.fn().mockRejectedValue(new PersistError('network', 'offline'))
    });
    const { result } = await renderLoaded(repo);
    expect(result.current.persistError).toMatchObject({ reason: 'network', message: 'offline' });
  });
});

describe('useProjects — createProject', () => {
  it('adds the created project and selects it', async () => {
    const repo = fakeRepo();
    const { result } = await renderLoaded(repo);

    await act(async () => {
      await result.current.createProject('ใหม่');
    });

    expect(repo.createProject).toHaveBeenCalledWith('ใหม่');
    expect(result.current.currentProject?.id).toBe('proj-new');
    expect(localStorage.getItem('ai_translate_selected_project')).toBe('proj-new');
  });

  it('refuses past the active-project limit without calling the repo', async () => {
    const repo = fakeRepo({
      listProjects: vi
        .fn()
        .mockResolvedValue([project({ id: 'a' }), project({ id: 'b' }), project({ id: 'c' })])
    });
    const { result } = await renderLoaded(repo);

    expect(result.current.canCreateProject).toBe(false);
    await act(async () => {
      await result.current.createProject('เกินโควตา');
    });
    expect(repo.createProject).not.toHaveBeenCalled();
  });

  it('surfaces a refused create and leaves the list unchanged', async () => {
    const repo = fakeRepo({
      createProject: vi.fn().mockRejectedValue(new PersistError('auth', 'permission denied'))
    });
    const { result } = await renderLoaded(repo);

    await act(async () => {
      await result.current.createProject('ใหม่');
    });

    expect(result.current.persistError).toMatchObject({ reason: 'auth' });
    expect(result.current.activeProjects.map((p) => p.id)).toEqual(['proj-1']);
  });
});

describe('useProjects — selecting a project', () => {
  // The running cost badge prices every session in the current project, so
  // its captions have to be in memory or the number silently undercounts.
  it('loads the selected project transcripts', async () => {
    const item: TranscriptItem = {
      seq: 1,
      sourceText: 'ก',
      targetText: 'A',
      sourceLang: 'th',
      targetLang: 'en',
      ts: 1767225600,
      latencyMs: 10,
      isEdited: false
    };
    const repo = fakeRepo({
      listProjects: vi.fn().mockResolvedValue([project({ sessions: [session()] })]),
      loadProjectTranscripts: vi.fn().mockResolvedValue({ 'sess-1': [item] })
    });
    const { result } = await renderLoaded(repo);

    await act(async () => {
      await result.current.selectProject('proj-1');
    });

    expect(repo.loadProjectTranscripts).toHaveBeenCalledWith('proj-1');
    await waitFor(() =>
      expect(result.current.currentProject?.sessions[0].transcripts).toEqual([item])
    );
  });
});

describe('useProjects — attachAsrSession', () => {
  it('appends the session the repo created and points the project at it', async () => {
    const repo = fakeRepo();
    const { result } = await renderLoaded(repo);
    await act(async () => {
      await result.current.selectProject('proj-1');
    });

    await act(async () => {
      await result.current.attachAsrSession('local_2', 'th', 'en');
    });

    expect(repo.attachAsrSession).toHaveBeenCalledWith('proj-1', 'local_2', 'th', 'en');
    expect(result.current.currentProject?.sessions).toHaveLength(1);
    expect(result.current.currentProject?.asrSessionId).toBe('local_2');
    expect(result.current.activeSession?.id).toBe('sess-new');
  });
});

describe('useProjects — captions', () => {
  it('writes one caption and folds it into the session in memory', async () => {
    const repo = fakeRepo({
      listProjects: vi.fn().mockResolvedValue([project({ sessions: [session()] })])
    });
    const { result } = await renderLoaded(repo);
    const item: TranscriptItem = {
      seq: 1,
      sourceText: 'ก',
      targetText: 'A',
      sourceLang: 'th',
      targetLang: 'en',
      ts: 1767225600,
      latencyMs: 10,
      isEdited: false
    };

    await act(async () => {
      await result.current.appendCaption('local_1', item);
    });

    expect(repo.appendCaption).toHaveBeenCalledWith('sess-1', item);
  });

  it('reports a caption that never lands', async () => {
    const repo = fakeRepo({
      listProjects: vi.fn().mockResolvedValue([project({ sessions: [session()] })]),
      appendCaption: vi.fn().mockRejectedValue(new PersistError('network', 'offline'))
    });
    const { result } = await renderLoaded(repo);

    await act(async () => {
      await result.current.appendCaption('local_1', {
        seq: 1,
        sourceText: 'ก',
        targetText: 'A',
        sourceLang: 'th',
        targetLang: 'en',
        ts: 1,
        latencyMs: 1,
        isEdited: false
      });
    });

    expect(result.current.persistError).toMatchObject({ reason: 'network' });
  });

  it('does nothing for a caption whose session is not on the record', async () => {
    const repo = fakeRepo();
    const { result } = await renderLoaded(repo);

    await act(async () => {
      await result.current.appendCaption('local_missing', {
        seq: 1,
        sourceText: 'ก',
        targetText: 'A',
        sourceLang: 'th',
        targetLang: 'en',
        ts: 1,
        latencyMs: 1,
        isEdited: false
      });
    });

    expect(repo.appendCaption).not.toHaveBeenCalled();
  });
});

describe('useProjects — summaries', () => {
  it('counts every attempt, including one that fails', async () => {
    const repo = fakeRepo({
      listProjects: vi
        .fn()
        .mockResolvedValue([project({ sessions: [session({ summarizeRuns: 2 })] })])
    });
    const { result } = await renderLoaded(repo);

    await act(async () => {
      await result.current.markSessionSummarizing('local_1');
    });

    expect(repo.markSummarizing).toHaveBeenCalledWith('sess-1', 3);
    expect(result.current.summarizingIds.has('local_1')).toBe(true);
  });

  it('stores a failed summary as an empty string and clears the spinner', async () => {
    const repo = fakeRepo({
      listProjects: vi.fn().mockResolvedValue([project({ sessions: [session()] })])
    });
    const { result } = await renderLoaded(repo);
    await act(async () => {
      await result.current.markSessionSummarizing('local_1');
    });

    await act(async () => {
      await result.current.saveSessionSummary('local_1', '', 12);
    });

    expect(repo.saveSummary).toHaveBeenCalledWith('sess-1', '', 12);
    expect(result.current.summarizingIds.has('local_1')).toBe(false);
    const stored = result.current.activeProjects[0].sessions[0];
    expect(stored.summary).toBe('');
    expect(stored.reportItemCount).toBe(12);
  });
});

describe('useProjects — finishProject', () => {
  it('closes open sessions, bills the project and clears the selection', async () => {
    const repo = fakeRepo({
      listProjects: vi.fn().mockResolvedValue([project({ sessions: [session()] })])
    });
    const { result } = await renderLoaded(repo);
    await act(async () => {
      await result.current.selectProject('proj-1');
    });

    let finished: Project | undefined;
    await act(async () => {
      finished = await result.current.finishProject([], 'local_1');
    });

    expect(repo.finishProject).toHaveBeenCalledWith(
      'proj-1',
      expect.objectContaining({ sessionCount: 1 }),
      expect.any(Number),
      ['sess-1']
    );
    expect(finished?.status).toBe('ended');
    expect(finished?.bill?.sessionCount).toBe(1);
    expect(result.current.currentProject).toBeUndefined();
  });

  it('returns undefined and writes nothing when no project is selected', async () => {
    const repo = fakeRepo();
    const { result } = await renderLoaded(repo);

    let finished: Project | undefined = project();
    await act(async () => {
      finished = await result.current.finishProject([], null);
    });

    expect(finished).toBeUndefined();
    expect(repo.finishProject).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run src/hooks/useProjects.test.ts`
Expected: FAIL — `useProjects` does not accept an options object and has no `loading`.

- [ ] **Step 5: Rewrite the hook**

Replace the whole of `src/hooks/useProjects.ts` with:

```ts
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Project, ProjectBill, ProjectSession, TranscriptItem } from '../types';
import { loadSelectedId, saveSelectedId } from '../storage/projectStore';
import { toPersistError, type PersistFailureReason } from '../data/persistError';
import { createProjectsRepo, type ProjectsRepo } from '../data/projectsRepo';
import { supabase } from '../lib/supabase';
import { ceilCents } from '../billing/geminiCost';
import { projectCost, projectTranscripts, type LiveBuffer } from '../billing/projectCost';

export const MAX_ACTIVE_PROJECTS = 3;
export const PROJECT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const EXPIRY_SWEEP_INTERVAL_MS = 60 * 1000;

export function projectExpiresAt(project: Project): number {
  return project.createdAt + PROJECT_TTL_MS;
}

export function projectDaysLeft(project: Project): number {
  return Math.max(0, Math.ceil((projectExpiresAt(project) - Date.now()) / (24 * 60 * 60 * 1000)));
}

/** Words are no longer what a project is priced on — Gemini bills audio
 *  minutes and tokens — but the bill still reports a word count, and the
 *  meaning of "word" has to stay the same wherever it is shown. */
export function countWords(transcripts: TranscriptItem[]): number {
  return transcripts.reduce((total, t) => {
    const text = `${t.sourceText} ${t.targetText}`.trim();
    return total + (text ? text.split(/\s+/).length : 0);
  }, 0);
}

/** Closes the books on a project. `live` describes the session still holding
 *  its captions in memory, if any — the caller names it explicitly rather
 *  than letting this read a project record that may not have been written
 *  yet (see finishProject). */
function buildBill(project: Project, live: LiveBuffer) {
  const now = live.now;
  const closedSessions = project.sessions.map((s) => (s.endedAt ? s : { ...s, endedAt: now }));
  const durationMs = closedSessions.reduce((sum, s) => sum + (s.endedAt! - s.startedAt), 0);
  const transcripts = projectTranscripts(project, live);
  const cost = projectCost(project, live);
  const bill: ProjectBill = {
    sessionCount: closedSessions.length,
    durationMs,
    wordCount: countWords(transcripts),
    estimatedCost: ceilCents(cost.total),
    costBreakdown: {
      liveMinutes: cost.liveMinutes,
      liveAudioCost: cost.liveAudioCost,
      liveTextCost: cost.liveTextCost,
      summaryCost: cost.summaryCost,
      summaryRuns: cost.summaryRuns
    }
  };
  return { closedSessions, bill, transcripts };
}

export interface UseProjectsOptions {
  /** Injected in tests. Defaults to the live Supabase-backed repo. */
  repo?: ProjectsRepo;
  /** The signed-in, approved account. Null means "load nothing and hold
   *  nothing" — a signed-out console on a shared machine must not still be
   *  showing the last person's meetings. */
  userId?: string | null;
}

const defaultRepo = () => createProjectsRepo(supabase as never);

export function useProjects({ repo, userId = null }: UseProjectsOptions = {}) {
  const activeRepo = useMemo(() => repo ?? defaultRepo(), [repo]);

  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(() => loadSelectedId());
  const [summarizingIds, setSummarizingIds] = useState<Set<string>>(() => new Set());
  // A write that fails is the operator's problem, not something to hide: with
  // no signal here a refused write looks exactly like a working recording.
  const [persistError, setPersistError] = useState<{
    reason: PersistFailureReason;
    message: string;
    at: number;
  } | null>(null);

  const fail = useCallback((error: unknown) => {
    const persist = toPersistError(error);
    setPersistError({ reason: persist.reason, message: persist.message, at: Date.now() });
  }, []);

  // ── Loading ───────────────────────────────────────────────────────────────
  const loadSeq = useRef(0);

  const reload = useCallback(async () => {
    const seq = ++loadSeq.current;
    if (!userId) {
      setProjects([]);
      setLoading(false);
      return;
    }
    try {
      const loaded = await activeRepo.listProjects();
      if (seq !== loadSeq.current) return; // a newer load superseded this one
      setProjects(loaded);
      setPersistError(null);
    } catch (error) {
      if (seq === loadSeq.current) fail(error);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [activeRepo, userId, fail]);

  useEffect(() => {
    setLoading(true);
    void reload();
  }, [reload]);

  /** Runs a mutation, and on failure raises the banner and resyncs from the
   *  server rather than leaving an optimistic edit the database never took. */
  const run = useCallback(
    async (mutate: () => Promise<void>) => {
      try {
        await mutate();
        return true;
      } catch (error) {
        fail(error);
        void reload();
        return false;
      }
    },
    [fail, reload]
  );

  useEffect(() => {
    saveSelectedId(selectedProjectId);
  }, [selectedProjectId]);

  // ── Expiry sweep ──────────────────────────────────────────────────────────
  // A project must be finished within 7 days; past that the system closes it
  // and bills it from whatever it recorded, rather than letting it run forever.
  // Still client-side, so it only runs while someone has the console open —
  // see the follow-ups in the design doc.
  const sweepExpired = useCallback(() => {
    const now = Date.now();
    setProjects((prev) => {
      let changed = false;
      const swept = prev.map((p) => {
        if (p.status !== 'active' || now < projectExpiresAt(p)) return p;
        changed = true;
        // Nothing is holding a live buffer here — a sweep runs on a timer,
        // not off the console — so every session bills from its own record.
        const { closedSessions, bill } = buildBill(p, { transcripts: [], asrSessionId: null, now });
        const openIds = p.sessions.filter((s) => !s.endedAt).map((s) => s.id);
        void run(() => activeRepo.finishProject(p.id, bill, now, openIds));
        return { ...p, status: 'ended' as const, sessions: closedSessions, endedAt: now, bill, autoFinished: true };
      });
      return changed ? swept : prev;
    });
  }, [activeRepo, run]);

  useEffect(() => {
    sweepExpired();
    const timer = setInterval(sweepExpired, EXPIRY_SWEEP_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [sweepExpired]);

  // ── Derived ───────────────────────────────────────────────────────────────
  const activeProjects = projects.filter((p) => p.status === 'active');
  const endedProjects = projects
    .filter((p) => p.status === 'ended')
    .sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0));

  const currentProject = activeProjects.find((p) => p.id === selectedProjectId);
  const activeSession = currentProject?.sessions.find((s) => !s.endedAt);
  const canCreateProject = activeProjects.length < MAX_ACTIVE_PROJECTS;

  /** Applies `change` to whichever session recorded `asrSessionId`, wherever
   *  it lives. Searched inside the updater rather than gated on
   *  currentProject, so it stays correct if the selection moved on while a
   *  request was in flight. */
  const updateSessionBy = (
    asrSessionId: string,
    change: (session: ProjectSession) => ProjectSession
  ) => {
    setProjects((prev) =>
      prev.map((p) => {
        const idx = p.sessions.findIndex((s) => s.asrSessionId === asrSessionId);
        if (idx === -1) return p;
        const sessions = p.sessions.slice();
        sessions[idx] = change(sessions[idx]);
        return { ...p, sessions };
      })
    );
  };

  const findSession = (asrSessionId: string): ProjectSession | undefined =>
    projects.flatMap((p) => p.sessions).find((s) => s.asrSessionId === asrSessionId);

  // ── Actions ───────────────────────────────────────────────────────────────
  const createProject = async (name: string) => {
    if (!canCreateProject) return;
    await run(async () => {
      const created = await activeRepo.createProject(name);
      setProjects((prev) => [created, ...prev]);
      setSelectedProjectId(created.id);
    });
  };

  /** Selecting a project pulls its transcripts in. The running cost badge
   *  prices every session in the current project, so leaving them lazy would
   *  make that number silently undercount. Ended projects in the history list
   *  stay lazy — they are read one summary at a time. */
  const selectProject = async (id: string) => {
    setSelectedProjectId(id);
    await run(async () => {
      const bySession = await activeRepo.loadProjectTranscripts(id);
      setProjects((prev) =>
        prev.map((p) =>
          p.id === id
            ? { ...p, sessions: p.sessions.map((s) => ({ ...s, transcripts: bySession[s.id] ?? [] })) }
            : p
        )
      );
    });
  };

  const clearSelection = () => setSelectedProjectId(null);

  // A project outlives many capture sessions: a dropped websocket reconnects
  // under a new id. Any session left open by the old id is closed by the same
  // statement that inserts the new one, so this cannot collide with the "one
  // open session" rule and silently drop the new recording.
  const attachAsrSession = async (asrSessionId: string, sourceLang: string, targetLang: string) => {
    if (!currentProject) return;
    const projectId = currentProject.id;
    await run(async () => {
      const created = await activeRepo.attachAsrSession(
        projectId,
        asrSessionId,
        sourceLang,
        targetLang
      );
      const now = Date.now();
      setProjects((prev) =>
        prev.map((p) =>
          p.id === projectId
            ? {
                ...p,
                asrSessionId,
                sessions: [...p.sessions.map((s) => (s.endedAt ? s : { ...s, endedAt: now })), created]
              }
            : p
        )
      );
    });
  };

  const endSession = async () => {
    if (!currentProject || !activeSession) return;
    const sessionId = activeSession.id;
    await run(async () => {
      await activeRepo.endSession(sessionId);
      updateSessionBy(activeSession.asrSessionId, (s) => ({ ...s, endedAt: Date.now() }));
    });
  };

  const detachAsrSession = async () => {
    if (!currentProject) return;
    const projectId = currentProject.id;
    await endSession();
    await run(async () => {
      await activeRepo.detachAsrSession(projectId);
      setProjects((prev) => prev.map((p) => (p.id === projectId ? { ...p, asrSessionId: null } : p)));
    });
  };

  /** One closed caption, written as it happens. A crashed tab now loses at
   *  most the sentence in flight instead of the whole meeting. */
  const appendCaption = useCallback(
    async (asrSessionId: string, item: TranscriptItem) => {
      const target = findSession(asrSessionId);
      if (!target) return;
      await run(async () => {
        await activeRepo.appendCaption(target.id, item);
        updateSessionBy(asrSessionId, (s) => ({
          ...s,
          transcripts: [...(s.transcripts ?? []).filter((t) => t.seq !== item.seq), item],
          itemCount: Math.max(s.itemCount, item.seq)
        }));
      });
    },
    [activeRepo, run, projects]
  );

  const editCaption = useCallback(
    async (asrSessionId: string, seq: number, targetText: string) => {
      const target = findSession(asrSessionId);
      if (!target) return;
      await run(async () => {
        await activeRepo.editCaption(target.id, seq, targetText);
        updateSessionBy(asrSessionId, (s) => ({
          ...s,
          transcripts: (s.transcripts ?? []).map((t) =>
            t.seq === seq ? { ...t, targetText, isEdited: true } : t
          )
        }));
      });
    },
    [activeRepo, run, projects]
  );

  /** Fetches one ended session's captions on demand, so the history list can
   *  stay cheap until a summary is actually asked for. */
  const loadSessionTranscript = useCallback(
    async (asrSessionId: string): Promise<TranscriptItem[]> => {
      const target = findSession(asrSessionId);
      if (!target) return [];
      if (target.transcripts) return target.transcripts;
      let items: TranscriptItem[] = [];
      await run(async () => {
        items = await activeRepo.loadSessionTranscript(target.id);
        updateSessionBy(asrSessionId, (s) => ({ ...s, transcripts: items }));
      });
      return items;
    },
    [activeRepo, run, projects]
  );

  // Summarising is a request that can take many seconds, so the history view
  // needs to tell "still working on it" apart from "not summarised yet". The
  // spinner is deliberately NOT persisted — a reload kills the in-flight
  // request, and a stored flag would spin forever. The run COUNTER is
  // persisted: every attempt spends tokens whether or not a summary comes
  // back, and the estimate would understate the bill if a retry cost nothing.
  const markSessionSummarizing = useCallback(
    async (asrSessionId: string) => {
      const target = findSession(asrSessionId);
      if (!target) return;
      const runs = (target.summarizeRuns ?? 0) + 1;
      setSummarizingIds((prev) => new Set(prev).add(asrSessionId));
      await run(async () => {
        await activeRepo.markSummarizing(target.id, runs);
        updateSessionBy(asrSessionId, (s) => ({ ...s, summarizeRuns: runs }));
      });
    },
    [activeRepo, run, projects]
  );

  const saveSessionSummary = useCallback(
    async (asrSessionId: string, summary: string, reportItemCount: number) => {
      const target = findSession(asrSessionId);
      setSummarizingIds((prev) => {
        if (!prev.has(asrSessionId)) return prev;
        const next = new Set(prev);
        next.delete(asrSessionId);
        return next;
      });
      if (!target) return;
      await run(async () => {
        // '' is a real value here — it records that the AI call failed, which
        // is different from nobody having asked.
        await activeRepo.saveSummary(target.id, summary, reportItemCount);
        updateSessionBy(asrSessionId, (s) => ({ ...s, summary, reportItemCount }));
      });
    },
    [activeRepo, run, projects]
  );

  /** `liveTranscripts` are the captions of the session that was just stopped,
   *  and `liveAsrSessionId` names which session they belong to. Naming it
   *  matters: the bill is priced per session, and whether that session's own
   *  transcript has reached the record yet is a race this must not depend on. */
  const finishProject = async (
    liveTranscripts: TranscriptItem[],
    liveAsrSessionId: string | null
  ): Promise<Project | undefined> => {
    if (!currentProject) return undefined;

    const now = Date.now();
    const live: LiveBuffer = { transcripts: liveTranscripts, asrSessionId: liveAsrSessionId, now };
    const { closedSessions, bill, transcripts } = buildBill(currentProject, live);
    const openIds = currentProject.sessions.filter((s) => !s.endedAt).map((s) => s.id);
    const projectId = currentProject.id;

    const ok = await run(() => activeRepo.finishProject(projectId, bill, now, openIds));
    if (!ok) return undefined;

    setProjects((prev) =>
      prev.map((p) =>
        p.id === projectId
          ? { ...p, status: 'ended' as const, sessions: closedSessions, transcripts, endedAt: now, bill, asrSessionId: null }
          : p
      )
    );
    setSelectedProjectId(null);

    // What the bill modal shows — the same numbers just written.
    return { ...currentProject, status: 'ended', sessions: closedSessions, transcripts, endedAt: now, bill };
  };

  return {
    loading,
    activeProjects,
    endedProjects,
    currentProject,
    activeSession,
    canCreateProject,
    createProject,
    selectProject,
    clearSelection,
    attachAsrSession,
    detachAsrSession,
    endSession,
    appendCaption,
    editCaption,
    loadSessionTranscript,
    saveSessionSummary,
    markSessionSummarizing,
    summarizingIds,
    persistError,
    reload,
    finishProject
  };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/hooks/useProjects.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 7: Commit**

```bash
git add src/hooks/useProjects.ts src/hooks/useProjects.test.ts src/storage/projectStore.ts
git commit -m "feat(hooks): useProjects issues mutations instead of writing a blob"
```

Note: `npm run lint` will fail after this task because `src/pages/Admin.tsx` still calls the old API. Task 11 fixes it — that is expected, and the plan's tasks are ordered so it is only broken in between.

---

### Task 10: `useGlossary` and the glossary.ts cleanup

Per-project glossary state, kept out of `Admin.tsx` — that file is already 1110 lines.

**Files:**
- Modify: `src/glossary.ts` (delete `loadGlossary` / `saveGlossary`, keep everything else)
- Create: `src/hooks/useGlossary.ts`
- Test: `src/hooks/useGlossary.test.ts`

**Interfaces:**
- Consumes: `GlossaryRepo`, `createGlossaryRepo`, `GlossaryList` (Task 8); `mergeGlossary` (Task 7).
- Produces: `useGlossary({ repo, projectId })` returning
  `{ sections: GlossarySections | null, sharedLists: GlossaryList[], subscribedIds: Set<string>, loading, addTerm, removeTerm, toggleList, error }`.
  `sections` is `null` when no project is selected — `DictionaryManager` already accepts `null`.

- [ ] **Step 1: Remove the localStorage functions from `src/glossary.ts`**

Delete `GLOSSARY_STORAGE_KEY`, `loadGlossary`, `isValidSection` and `saveGlossary`. Keep `GlossarySection`, `GlossarySections`, `emptyGlossary`, `glossaryToVocabulary`, `GlossaryPair`, `glossaryToPairs`, `escapeRegExp` and `applyEnThCorrections` exactly as they are — `src/glossary.test.ts` covers them and must keep passing untouched.

Then update the file's opening comment to say the glossary now comes from the database per project.

- [ ] **Step 2: Confirm the surviving glossary tests still pass**

Run: `npx vitest run src/glossary.test.ts`
Expected: PASS. If any test referenced `loadGlossary`/`saveGlossary`, delete just those tests — the pure transforms are the subject worth keeping.

- [ ] **Step 3: Write the failing test for the hook**

Create `src/hooks/useGlossary.test.ts`:

```ts
// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useGlossary } from './useGlossary';
import { emptyGlossary } from '../glossary';
import type { GlossaryList, GlossaryRepo } from '../data/glossaryRepo';

const sharedList: GlossaryList = {
  id: 'list-shared',
  name: 'ชื่อบุคคล',
  description: null,
  scope: 'shared',
  isDefault: true
};

const ownList: GlossaryList = {
  id: 'list-own',
  name: 'ศัพท์เฉพาะของโปรเจกต์นี้',
  description: null,
  scope: 'project',
  isDefault: false
};

function fakeRepo(overrides: Partial<GlossaryRepo> = {}): GlossaryRepo {
  return {
    listSharedLists: vi.fn().mockResolvedValue([sharedList]),
    loadProjectLists: vi.fn().mockResolvedValue({ own: ownList, subscribed: [sharedList] }),
    loadTerms: vi.fn().mockResolvedValue({
      'list-shared': { ...emptyGlossary(), person_names: { 'สมชาย': 'Somchai' } },
      'list-own': emptyGlossary()
    }),
    subscribeList: vi.fn().mockResolvedValue(undefined),
    unsubscribeList: vi.fn().mockResolvedValue(undefined),
    addTerm: vi.fn().mockResolvedValue(undefined),
    removeTerm: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

async function renderLoaded(repo: GlossaryRepo, projectId: string | null = 'proj-1') {
  const view = renderHook(() => useGlossary({ repo, projectId }));
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  return view;
}

describe('useGlossary', () => {
  it('gives null sections and loads nothing when no project is selected', async () => {
    const repo = fakeRepo();
    const { result } = await renderLoaded(repo, null);

    expect(result.current.sections).toBeNull();
    expect(repo.loadProjectLists).not.toHaveBeenCalled();
  });

  it('merges the subscribed shared lists with the project list', async () => {
    const { result } = await renderLoaded(fakeRepo());

    expect(result.current.sections?.person_names).toEqual({ 'สมชาย': 'Somchai' });
    expect(result.current.subscribedIds.has('list-shared')).toBe(true);
    expect(result.current.sharedLists).toEqual([sharedList]);
  });

  // The rule from the design: a project term beats the shared one.
  it("lets the project's own term win over the shared list", async () => {
    const repo = fakeRepo({
      loadTerms: vi.fn().mockResolvedValue({
        'list-shared': { ...emptyGlossary(), person_names: { 'สมชาย': 'Somchai' } },
        'list-own': { ...emptyGlossary(), person_names: { 'สมชาย': 'Dr. Somchai' } }
      })
    });
    const { result } = await renderLoaded(repo);

    expect(result.current.sections?.person_names).toEqual({ 'สมชาย': 'Dr. Somchai' });
  });

  it("writes a new term to the project's own list and shows it immediately", async () => {
    const repo = fakeRepo();
    const { result } = await renderLoaded(repo);

    await act(async () => {
      await result.current.addTerm('protected_terms', 'ภาควิชา', 'Department');
    });

    expect(repo.addTerm).toHaveBeenCalledWith('list-own', 'protected_terms', 'ภาควิชา', 'Department');
    expect(result.current.sections?.protected_terms).toEqual({ 'ภาควิชา': 'Department' });
  });

  it('removes a term from the project list', async () => {
    const repo = fakeRepo({
      loadTerms: vi.fn().mockResolvedValue({
        'list-shared': emptyGlossary(),
        'list-own': { ...emptyGlossary(), protected_terms: { 'ภาควิชา': 'Department' } }
      })
    });
    const { result } = await renderLoaded(repo);

    await act(async () => {
      await result.current.removeTerm('protected_terms', 'ภาควิชา');
    });

    expect(repo.removeTerm).toHaveBeenCalledWith('list-own', 'protected_terms', 'ภาควิชา');
    expect(result.current.sections?.protected_terms).toEqual({});
  });

  it('unsubscribes a list that is currently on, and drops its terms', async () => {
    const repo = fakeRepo();
    const { result } = await renderLoaded(repo);

    await act(async () => {
      await result.current.toggleList('list-shared');
    });

    expect(repo.unsubscribeList).toHaveBeenCalledWith('proj-1', 'list-shared');
    await waitFor(() => expect(result.current.subscribedIds.has('list-shared')).toBe(false));
    expect(result.current.sections?.person_names).toEqual({});
  });

  it('subscribes a list that is currently off', async () => {
    const repo = fakeRepo({
      loadProjectLists: vi.fn().mockResolvedValue({ own: ownList, subscribed: [] })
    });
    const { result } = await renderLoaded(repo);

    await act(async () => {
      await result.current.toggleList('list-shared');
    });

    expect(repo.subscribeList).toHaveBeenCalledWith('proj-1', 'list-shared');
    await waitFor(() => expect(result.current.subscribedIds.has('list-shared')).toBe(true));
  });

  it('reports a failed term write instead of silently dropping it', async () => {
    const repo = fakeRepo({ addTerm: vi.fn().mockRejectedValue(new Error('permission denied')) });
    const { result } = await renderLoaded(repo);

    await act(async () => {
      await result.current.addTerm('person_names', 'ก', 'A');
    });

    expect(result.current.error).not.toBeNull();
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npx vitest run src/hooks/useGlossary.test.ts`
Expected: FAIL — cannot resolve `./useGlossary`.

- [ ] **Step 5: Implement the hook**

Create `src/hooks/useGlossary.ts`:

```ts
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

  return { sections, sharedLists, subscribedIds, ownList, loading, error, addTerm, removeTerm, toggleList, reload: load };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/hooks/useGlossary.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 7: Commit**

```bash
git add src/glossary.ts src/hooks/useGlossary.ts src/hooks/useGlossary.test.ts
git commit -m "feat(hooks): per-project glossary composed from shared lists"
```

---

### Task 11: Wire `Admin.tsx` to the new hooks

Restores a compiling app. Every edit below is in `src/pages/Admin.tsx`.

**Files:**
- Modify: `src/pages/Admin.tsx`

**Interfaces:**
- Consumes: `useProjects({ repo, userId })` with async `finishProject`, `appendCaption`, `editCaption`, `loadSessionTranscript`, `loading` (Task 9); `useGlossary({ projectId })` (Task 10); `useAuth()` from `src/auth/AuthProvider.tsx`.

- [ ] **Step 1: Update the imports**

Replace the glossary import:

```ts
import { type GlossarySection, type GlossarySections } from '../glossary';
import { useGlossary } from '../hooks/useGlossary';
```

- [ ] **Step 2: Pass the signed-in account into `useProjects`, and derive the glossary from the selected project**

`useAuth()` is currently called further down the component (line ~133). Move that call above the `useProjects` call, then replace line 104 and line 111:

```ts
  // Session + approval state. Both are needed before any project loads:
  // an unapproved account must hold nothing, so a shared machine never shows
  // the previous operator's meetings.
  const { user, session, status, signOut } = useAuth();
  const navigate = useNavigate();

  const projects = useProjects({ userId: status === 'approved' ? user?.id ?? null : null });
  const glossaryState = useGlossary({ projectId: projects.currentProject?.id ?? null });
  const glossary: GlossarySections | null = glossaryState.sections;
```

Delete the old `const [glossary, setGlossary] = useState<GlossarySections>(() => loadGlossary());` line and the now-duplicated `const { user, session, signOut } = useAuth();` / `const navigate = useNavigate();` pair lower down.

- [ ] **Step 3: Replace the three glossary handlers**

Replace `persistGlossary`, `handleGlossaryAdd` and `handleGlossaryRemove` (lines ~306-319) with:

```ts
  // ── Glossary ──────────────────────────────────────────────────────────────
  // Terms go into the project's own list; shared lists are read-only here and
  // are maintained from the Supabase dashboard.
  const handleGlossaryAdd = (section: GlossarySection, term: string, equivalent: string) => {
    void glossaryState.addTerm(section, term, equivalent);
  };

  const handleGlossaryRemove = (section: GlossarySection, term: string) => {
    void glossaryState.removeTerm(section, term);
  };
```

- [ ] **Step 4: Pass the merged glossary to the capture hook**

`useGeminiLiveCapture` expects `GlossarySections`, and `glossary` can now be null (no project selected). At the `capture` call site (line ~184):

```ts
    glossary: glossary ?? emptyGlossary(),
```

and add `emptyGlossary` to the glossary import. A session cannot start without a selected project, so this fallback is never the live path — it just keeps the type honest.

- [ ] **Step 5: Stream each closed caption to the database**

Replace `handleCaptureResult` (line ~167):

```ts
  // ── Gemini capture result → captions ─────────────────────────────────────
  const handleCaptureResult = useCallback(
    (result: CaptionResult) => {
      const item: TranscriptItem = {
        seq: result.seq,
        sourceText: result.sourceText,
        targetText: result.targetText,
        sourceLang: result.sourceLang,
        targetLang: result.targetLang,
        ts: Date.now() / 1000,
        latencyMs: result.latencyMs,
        isEdited: false
      };
      // Spelled out rather than spread: CaptionAction's 'add' has no `ts` or
      // `isEdited` — the reducer stamps its own timestamp — so spreading the
      // item would not typecheck.
      dispatchCaption({
        kind: 'add',
        seq: item.seq,
        sourceText: item.sourceText,
        targetText: item.targetText,
        sourceLang: item.sourceLang,
        targetLang: item.targetLang,
        latencyMs: item.latencyMs
      });
      // Written as it closes rather than at the end of the session: a crashed
      // tab now loses the sentence in flight, not the whole meeting. Not
      // awaited — the subtitle must never wait on a round trip.
      if (sessionId) void projects.appendCaption(sessionId, item);
    },
    [sessionId, projects]
  );
```

Add `TranscriptItem` to the `../types` import if it is not already there.

- [ ] **Step 6: Persist caption edits**

At line ~335, after the `dispatchCaption({ kind: 'edit', ... })` call:

```ts
    const nextText = editDraft.trim();
    dispatchCaption({ kind: 'edit', seq: editingSeq, targetText: nextText });
    if (sessionId) void projects.editCaption(sessionId, editingSeq, nextText);
    setEditingSeq(null);
```

- [ ] **Step 7: Drop the now-redundant session-end transcript write**

In `stopSessionAndMic`, delete the line `if (sessionId) projects.saveSessionTranscript(sessionId, sessionCaptions);` — every caption is already on the record, and `saveSessionTranscript` no longer exists. Make the surrounding call site await the detach:

```ts
    setEndingSession(false);
    setSessionId(null);
    setPaused(false);
    await projects.detachAsrSession();
    return sessionCaptions;
```

- [ ] **Step 8: Await the now-async project actions**

- `startSessionAndMic`: `await projects.attachAsrSession(id, sourceLang, targetLang);` and mark the function `async`.
- `handleRequestFinishProject`: `const finished = await projects.finishProject(captionsForProject, lastAsrSessionId);`
- The `ProjectPanel` props at lines ~437-438: `onSelect={(id) => void projects.selectProject(id)}` and `onCreate={(name) => void projects.createProject(name)}`.

- [ ] **Step 9: Load a session's captions before summarising it**

In `summarizeSession`, replace the first two lines:

```ts
  const summarizeSession = async (session: ProjectSession) => {
    if (!session.endedAt) return;
    if (projects.summarizingIds.has(session.asrSessionId)) return;
    // Captions for an ended session are fetched on demand — the history list
    // holds only counts, so a project with fifty meetings still opens fast.
    const transcripts = await projects.loadSessionTranscript(session.asrSessionId);
    if (transcripts.length === 0) return;

    setSummarySessionId(session.id);
    setSummarizingSince(Date.now());
    await projects.markSessionSummarizing(session.asrSessionId);
```

and change the two `projects.saveSessionSummary(...)` calls to `await projects.saveSessionSummary(...)`.

- [ ] **Step 10: Show a loading state instead of an empty project picker**

Immediately before the `return` that renders the project picker (the branch taken when `!projects.currentProject`), add:

```ts
  if (projects.loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 text-slate-500 text-sm">
        กำลังโหลดโปรเจกต์…
      </div>
    );
  }
```

Without this the picker flashes "no projects yet" on every reload before the query returns, and an operator could create a duplicate project in that gap.

- [ ] **Step 11: Extend the persistence banner copy**

Replace the banner's message block (lines ~729-735) with:

```ts
                  {projects.persistError.reason === 'auth'
                    ? 'เซสชันหมดอายุหรือไม่มีสิทธิ์บันทึก กรุณาเข้าสู่ระบบอีกครั้ง'
                    : projects.persistError.reason === 'network'
                    ? 'เชื่อมต่อฐานข้อมูลไม่ได้ กรุณาตรวจสอบอินเทอร์เน็ต แล้วดาวน์โหลดสำรองไว้ก่อน'
                    : projects.persistError.reason === 'quota'
                    ? 'พื้นที่จัดเก็บในเบราว์เซอร์เต็ม กรุณาดาวน์โหลดสำรองไว้'
                    : projects.persistError.reason === 'unavailable'
                    ? 'เบราว์เซอร์นี้ปิดการจัดเก็บข้อมูลไว้ กรุณาดาวน์โหลดสำรองก่อนปิดหน้านี้'
                    : 'เกิดข้อผิดพลาดที่ไม่รู้จัก กรุณาดาวน์โหลดสำรองก่อนปิดหน้านี้'}
```

- [ ] **Step 12: Typecheck**

Run: `npm run lint`
Expected: no errors. Task 12 handles `ProjectPanel`; if the only remaining errors are in that file, continue to Task 12 and re-run there.

- [ ] **Step 13: Run the whole suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 14: Commit**

```bash
git add src/pages/Admin.tsx
git commit -m "feat(admin): stream captions to the database and use the project glossary"
```

---

### Task 11b: Caption retry queue

The spec (§4.4) promises that a transient network blip does not cost a caption. Without this, one failed write drops a sentence and raises the banner for a hiccup that would have resolved by itself. The upsert in Task 6 is idempotent, which is what makes retrying safe.

**Files:**
- Create: `src/data/captionQueue.ts`
- Test: `src/data/captionQueue.test.ts`
- Modify: `src/hooks/useProjects.ts` (route `appendCaption` through the queue, expose `flushCaptions`)
- Modify: `src/pages/Admin.tsx` (flush at session end)

**Interfaces:**
- Consumes: `TranscriptItem` from `src/types.ts`.
- Produces: `createCaptionQueue({ send, onFailure, delaysMs? })` → `{ enqueue(sessionId, item), flush(): Promise<void>, pending(): number }`. `useProjects` gains `flushCaptions(): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Create `src/data/captionQueue.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCaptionQueue } from './captionQueue';
import type { TranscriptItem } from '../types';

function item(seq: number): TranscriptItem {
  return {
    seq,
    sourceText: 'ก',
    targetText: 'A',
    sourceLang: 'th',
    targetLang: 'en',
    ts: 1767225600,
    latencyMs: 10,
    isEdited: false
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('createCaptionQueue', () => {
  it('sends one caption and empties', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const queue = createCaptionQueue({ send, onFailure: vi.fn() });

    queue.enqueue('sess-1', item(1));
    await queue.flush();

    expect(send).toHaveBeenCalledWith('sess-1', item(1));
    expect(queue.pending()).toBe(0);
  });

  // Order matters: captions are numbered, and a summary built from them out
  // of order reads as nonsense.
  it('sends captions in the order they were enqueued', async () => {
    const seen: number[] = [];
    const send = vi.fn().mockImplementation(async (_id: string, i: TranscriptItem) => {
      seen.push(i.seq);
    });
    const queue = createCaptionQueue({ send, onFailure: vi.fn() });

    queue.enqueue('sess-1', item(1));
    queue.enqueue('sess-1', item(2));
    queue.enqueue('sess-1', item(3));
    await queue.flush();

    expect(seen).toEqual([1, 2, 3]);
  });

  it('retries after a failure and succeeds without reporting anything', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(undefined);
    const onFailure = vi.fn();
    const queue = createCaptionQueue({ send, onFailure, delaysMs: [10, 20] });

    queue.enqueue('sess-1', item(1));
    const flushed = queue.flush();
    await vi.advanceTimersByTimeAsync(10);
    await flushed;

    expect(send).toHaveBeenCalledTimes(2);
    // A blip that resolved is not the operator's problem.
    expect(onFailure).not.toHaveBeenCalled();
    expect(queue.pending()).toBe(0);
  });

  it('reports once and drops the caption when every attempt fails', async () => {
    const send = vi.fn().mockRejectedValue(new Error('offline'));
    const onFailure = vi.fn();
    const queue = createCaptionQueue({ send, onFailure, delaysMs: [10, 20] });

    queue.enqueue('sess-1', item(1));
    const flushed = queue.flush();
    await vi.advanceTimersByTimeAsync(30);
    await flushed;

    expect(send).toHaveBeenCalledTimes(3); // initial + two retries
    expect(onFailure).toHaveBeenCalledTimes(1);
    // Dropped rather than retried forever, so the captions behind it still
    // get through. onFailure has already told the operator.
    expect(queue.pending()).toBe(0);
  });

  it('keeps delivering later captions after one is given up on', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('a'))
      .mockRejectedValueOnce(new Error('a'))
      .mockRejectedValueOnce(new Error('a'))
      .mockResolvedValue(undefined);
    const onFailure = vi.fn();
    const queue = createCaptionQueue({ send, onFailure, delaysMs: [10, 20] });

    queue.enqueue('sess-1', item(1));
    queue.enqueue('sess-1', item(2));
    const flushed = queue.flush();
    await vi.advanceTimersByTimeAsync(30);
    await flushed;

    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith('sess-1', item(2));
    expect(queue.pending()).toBe(0);
  });

  it('flush resolves immediately when there is nothing queued', async () => {
    const queue = createCaptionQueue({ send: vi.fn(), onFailure: vi.fn() });
    await expect(queue.flush()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/data/captionQueue.test.ts`
Expected: FAIL — cannot resolve `./captionQueue`.

- [ ] **Step 3: Implement the queue**

Create `src/data/captionQueue.ts`:

```ts
/** A serial, retrying outbox for closed captions.
 *
 *  A caption is written the moment it closes, so a dropped connection during
 *  a meeting would otherwise cost a sentence and raise the banner for a blip
 *  that fixes itself a second later. The write is an upsert keyed by
 *  (session_id, seq), so retrying is safe: a send that timed out but actually
 *  landed does not produce a duplicate.
 *
 *  Serial on purpose. Captions are numbered and read back in order, and
 *  parallel sends would let a later sentence overtake an earlier one.
 */

import type { TranscriptItem } from '../types';

export interface CaptionQueueOptions {
  send: (sessionId: string, item: TranscriptItem) => Promise<void>;
  /** Called once per caption that never landed, after every retry failed. */
  onFailure: (error: unknown) => void;
  /** Waits between attempts. Its length is how many retries there are. */
  delaysMs?: number[];
}

const DEFAULT_DELAYS = [500, 2000, 5000];

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createCaptionQueue({ send, onFailure, delaysMs = DEFAULT_DELAYS }: CaptionQueueOptions) {
  const queue: Array<{ sessionId: string; item: TranscriptItem }> = [];
  let draining: Promise<void> | null = null;

  async function deliver(entry: { sessionId: string; item: TranscriptItem }) {
    for (let attempt = 0; ; attempt++) {
      try {
        await send(entry.sessionId, entry.item);
        return;
      } catch (error) {
        if (attempt >= delaysMs.length) {
          // Give up on this one rather than blocking every caption behind it.
          // onFailure raises the banner, so this is a reported loss, never a
          // silent one.
          onFailure(error);
          return;
        }
        await wait(delaysMs[attempt]);
      }
    }
  }

  async function drain() {
    while (queue.length > 0) {
      await deliver(queue[0]);
      queue.shift();
    }
    draining = null;
  }

  return {
    enqueue(sessionId: string, item: TranscriptItem) {
      queue.push({ sessionId, item });
      draining ||= drain();
    },
    /** Waits for everything queued so far. Called when a session ends, so the
     *  last sentences are on the record before the operator moves on. */
    async flush() {
      while (draining) await draining;
    },
    pending() {
      return queue.length;
    }
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/data/captionQueue.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Route `useProjects.appendCaption` through the queue**

In `src/hooks/useProjects.ts`, add the import:

```ts
import { createCaptionQueue } from '../data/captionQueue';
```

Hold one queue for the life of the hook, created after `fail` is defined:

```ts
  // One outbox for the whole console. `send` closes over the repo rather than
  // over React state, so a retry that fires seconds later still writes to the
  // right session.
  const captionQueue = useRef<ReturnType<typeof createCaptionQueue>>();
  if (!captionQueue.current) {
    captionQueue.current = createCaptionQueue({
      send: (sessionId, item) => activeRepo.appendCaption(sessionId, item),
      onFailure: fail
    });
  }
```

Replace the `appendCaption` implementation from Task 9 with:

```ts
  /** One closed caption. The optimistic state update happens now; the write
   *  goes through the retry queue, so a blip costs nothing and only a caption
   *  that never lands reaches the banner. */
  const appendCaption = useCallback(
    async (asrSessionId: string, item: TranscriptItem) => {
      const target = findSession(asrSessionId);
      if (!target) return;
      updateSessionBy(asrSessionId, (s) => ({
        ...s,
        transcripts: [...(s.transcripts ?? []).filter((t) => t.seq !== item.seq), item],
        itemCount: Math.max(s.itemCount, item.seq)
      }));
      captionQueue.current!.enqueue(target.id, item);
    },
    [projects]
  );
```

and add to the returned object:

```ts
    flushCaptions: () => captionQueue.current!.flush(),
```

- [ ] **Step 6: Flush at session end in `Admin.tsx`**

In `stopSessionAndMic`, after `const flushed = await capture.flush();` and before returning, wait for the outbox to empty:

```ts
    // The last sentences must be on the record before the operator moves on —
    // finishing a project prices what the database holds.
    await projects.flushCaptions();
```

- [ ] **Step 7: Update the Task 9 caption tests**

`useProjects.test.ts` asserted that `appendCaption` reports a failure synchronously. It now goes through the queue with real timers. Replace the test "reports a caption that never lands" with:

```ts
  it('reports a caption that never lands, after the retries are exhausted', async () => {
    const repo = fakeRepo({
      listProjects: vi.fn().mockResolvedValue([project({ sessions: [session()] })]),
      appendCaption: vi.fn().mockRejectedValue(new PersistError('network', 'offline'))
    });
    const { result } = await renderLoaded(repo);

    await act(async () => {
      await result.current.appendCaption('local_1', {
        seq: 1,
        sourceText: 'ก',
        targetText: 'A',
        sourceLang: 'th',
        targetLang: 'en',
        ts: 1,
        latencyMs: 1,
        isEdited: false
      });
      await result.current.flushCaptions();
    });

    await waitFor(() => expect(result.current.persistError).toMatchObject({ reason: 'network' }));
  }, 20000);
```

The default delays total 7.5 seconds, hence the raised timeout.

- [ ] **Step 8: Run the suite and typecheck**

Run: `npm run lint && npm test`
Expected: both clean.

- [ ] **Step 9: Commit**

```bash
git add src/data/captionQueue.ts src/data/captionQueue.test.ts \
        src/hooks/useProjects.ts src/hooks/useProjects.test.ts src/pages/Admin.tsx
git commit -m "feat(data): retry queue so a network blip never costs a caption"
```

---

### Task 12: `ProjectPanel` — counts from the column, transcripts on demand

The session history must show how many captions a session holds without fetching a single one.

**Files:**
- Modify: `src/components/ProjectPanel.tsx`
- Modify: `src/pages/Admin.tsx` (one new prop)

**Interfaces:**
- Consumes: `ProjectSession.itemCount` (Task 2); `projects.loadSessionTranscript` (Task 9).
- Produces: `SessionSummaryModal` gains an `onOpen: (session: ProjectSession) => void` prop.

- [ ] **Step 1: Read counts from the column in the history list**

At line ~543 in `SessionHistoryModal`, replace:

```ts
              const itemCount = s.transcripts?.length ?? 0;
```

with:

```ts
              // From the denormalised column, not the captions: the history
              // list holds counts only, so a project with fifty meetings
              // still opens in one query.
              const itemCount = s.itemCount;
```

- [ ] **Step 2: Do the same in the summary popup**

At line ~642 in `SessionSummaryModal`, replace:

```ts
  const itemCount = session.transcripts?.length ?? session.reportItemCount ?? 0;
```

with:

```ts
  // reportItemCount is what was SENT to the summariser and can differ from
  // what the session holds now, so it only wins once a summary exists.
  const itemCount = session.summary !== undefined
    ? session.reportItemCount ?? session.itemCount
    : session.itemCount;
```

- [ ] **Step 3: Fetch the transcript when the summary popup opens**

Add `onOpen` to the `SessionSummaryModal` props type (line ~637):

```ts
  /** Called once when the popup mounts, so the captions this session holds
   *  can be fetched — the history list carries counts only. */
  onOpen: (session: ProjectSession) => void;
```

and inside the component body, before the first `return`:

```ts
  useEffect(() => {
    onOpen(session);
    // Only on mount, and only for this session: re-running on every render
    // would refetch the transcript continuously.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);
```

Add `useEffect` to the React import at the top of the file.

- [ ] **Step 4: Pass the fetch down from `Admin.tsx`**

At the `SessionSummaryModal` call site, add:

```tsx
          onOpen={(s) => void projects.loadSessionTranscript(s.asrSessionId)}
```

- [ ] **Step 5: Typecheck and run the suite**

Run: `npm run lint && npm test`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/components/ProjectPanel.tsx src/pages/Admin.tsx
git commit -m "feat(history): session counts from the column, transcripts on demand"
```

---

### Task 13: `DictionaryManager` — the shared-list picker

**Files:**
- Modify: `src/components/DictionaryManager.tsx`
- Modify: `src/pages/Admin.tsx` (pass the new props)

**Interfaces:**
- Consumes: `GlossaryList`, `subscribedIds`, `toggleList` from `useGlossary` (Task 10).
- Produces: `DictionaryManager` gains `sharedLists: GlossaryList[]`, `subscribedIds: Set<string>`, `onToggleList: (listId: string) => void`.

- [ ] **Step 1: Extend the props**

In the props interface (line ~32):

```ts
  sections: GlossarySections | null;
  /** Reusable lists maintained by an admin. Selecting one merges its terms
   *  into this project; its contents cannot be edited here. */
  sharedLists: GlossaryList[];
  subscribedIds: Set<string>;
  onToggleList: (listId: string) => void;
  onAdd: (section: GlossarySection, abbr: string, full: string) => void;
  onRemove: (section: GlossarySection, abbr: string) => void;
```

Add `import type { GlossaryList } from '../data/glossaryRepo';`.

- [ ] **Step 2: Render the picker above the section tabs**

Insert immediately inside the component's outermost element, before the existing section tabs:

```tsx
      {sharedLists.length > 0 && (
        <div className="mb-3 pb-3 border-b border-slate-200">
          <p className="text-[11px] font-semibold text-slate-500 mb-1.5">คลังคำศัพท์ที่ใช้ร่วมกัน</p>
          <div className="flex flex-col gap-1">
            {sharedLists.map((list) => (
              <label
                key={list.id}
                className="flex items-start gap-2 text-xs text-slate-700 cursor-pointer"
              >
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={subscribedIds.has(list.id)}
                  disabled={disabled}
                  onChange={() => onToggleList(list.id)}
                />
                <span className="min-w-0">
                  <span className="font-medium">{list.name}</span>
                  {list.description && (
                    <span className="block text-[11px] text-slate-500">{list.description}</span>
                  )}
                </span>
              </label>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] text-slate-400">
            แก้ไขคลังที่ใช้ร่วมกันได้จากผู้ดูแลระบบเท่านั้น — คำที่เพิ่มด้านล่างจะอยู่กับโปรเจกต์นี้
            และจะทับคำในคลังที่ชื่อซ้ำกัน
          </p>
        </div>
      )}
```

- [ ] **Step 3: Replace the stale localStorage comment**

Replace the comment at line ~15 and the note at line ~102 ("The glossary is stored locally in this browser and shared by every…") with wording that matches reality: the glossary belongs to this project, is stored in the database, and follows the operator to any device.

- [ ] **Step 4: Pass the new props from `Admin.tsx`**

At line ~702:

```tsx
              <DictionaryManager
                sections={glossary}
                sharedLists={glossaryState.sharedLists}
                subscribedIds={glossaryState.subscribedIds}
                onToggleList={(id) => void glossaryState.toggleList(id)}
                disabled={!projects.currentProject}
                onAdd={handleGlossaryAdd}
                onRemove={handleGlossaryRemove}
              />
```

- [ ] **Step 5: Typecheck and run the suite**

Run: `npm run lint && npm test`
Expected: both clean.

- [ ] **Step 6: Verify by hand in the running app**

Run `npm run dev`, sign in with an approved account, and confirm:
1. A new project already has the default person-name list ticked (the trigger did it).
2. Unticking it removes those terms from the dictionary view; re-ticking restores them.
3. A term added by hand survives a page reload — it is in Postgres, not localStorage.
4. Adding a term with the same key as a shared one shows the project's value.

- [ ] **Step 7: Commit**

```bash
git add src/components/DictionaryManager.tsx src/pages/Admin.tsx
git commit -m "feat(glossary): select shared term lists per project"
```

---

### Task 14: End-to-end verification and documentation

**Files:**
- Modify: `SYSTEM_OVERVIEW.md`
- Modify: `.env.example` (if it mentions localStorage storage)

- [ ] **Step 1: Run a full meeting end to end**

With `npm run dev` and an approved account:
1. Create a project, start a session, speak several sentences.
2. **Mid-session, reload the page.** The captions spoken so far must still be in the session — this is the durability change, and it is the one thing that cannot be verified by any unit test.
3. Edit a caption, reload, confirm the edit survived and shows as edited.
4. End the session, ask for a summary from the history, confirm it stores.
5. Finish the project and confirm the bill matches the running badge.
6. Sign in as a **different** approved account and confirm none of the above is visible.

- [ ] **Step 2: Update `SYSTEM_OVERVIEW.md`**

- §1.3 file table: replace the `src/hooks/useProjects.ts` row's "(localStorage)" with "(Supabase)", and add rows for `src/data/projectsRepo.ts`, `src/data/glossaryRepo.ts` and `supabase/schema-projects.sql`.
- §2.4: the glossary is per project, composed from admin-maintained shared lists, stored in the database — not "เก็บใน localStorage ของเบราว์เซอร์". Keep the tested caveat about best-effort translation forcing; that is still true.
- §2.6: delete "ยังไม่มี database จริง เก็บใน localStorage".
- §4: replace "เซิร์ฟเวอร์ไม่มีระบบยืนยันตัวตน" — `server/auth.ts` has existed since the auth work — and note that captions are written as they close, so a crashed tab loses at most one sentence.
- §5 roadmap: strike "ย้ายข้อมูลโปรเจกต์/ประวัติ session จาก localStorage ไปเป็น database จริง" (done) and add the four follow-ups from §9 of the design doc: `pg_cron` expiry sweep, in-app admin UI for shared lists, database-enforced `MAX_ACTIVE_PROJECTS`, and Realtime sync between tabs.

- [ ] **Step 3: Confirm the full suite and typecheck are clean**

Run: `npm run lint && npm test`
Expected: both pass. Report the actual output — do not claim success without it.

- [ ] **Step 4: Commit**

```bash
git add SYSTEM_OVERVIEW.md .env.example
git commit -m "docs: system overview reflects Supabase-backed projects and glossary"
```

---

## Done when

- [ ] `npm run lint` and `npm test` both pass
- [ ] The six RLS checks in `supabase/schema-projects.sql` have been run by hand and behave as described
- [ ] A mid-session page reload keeps the captions spoken so far
- [ ] A second approved account sees none of the first account's projects
- [ ] No file under `src/` reads or writes `ai_translate_projects` or `ai_translate_glossary`
