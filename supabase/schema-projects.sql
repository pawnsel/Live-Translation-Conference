-- ===========================================================================
--  Live Translation — project, session, transcript and glossary schema
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

-- One meaning per term per section. Plain columns, NOT lower(term): a later
-- task upserts with onConflict: 'list_id,section,term', and Postgres
-- ON CONFLICT only matches a unique index over the same plain column list —
-- an expression index (e.g. lower(term)) will NOT match it and the upsert
-- will fail. Do not "improve" this back to a case-insensitive/lower() index.
create unique index if not exists glossary_terms_unique
  on public.glossary_terms (list_id, section, term);

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

-- WITH CHECK also verifies project_id belongs to this user: FK checks bypass
-- RLS, so without this an approved user could attach a session to someone
-- else's project by naming their own owner_id but another user's project_id.
drop policy if exists "create own sessions" on public.project_sessions;
create policy "create own sessions" on public.project_sessions
  for insert to authenticated
  with check (
    owner_id = auth.uid() and public.is_approved() and exists (
      select 1 from public.projects p where p.id = project_id and p.owner_id = auth.uid()
    )
  );

drop policy if exists "update own sessions" on public.project_sessions;
create policy "update own sessions" on public.project_sessions
  for update to authenticated
  using (owner_id = auth.uid())
  with check (
    owner_id = auth.uid() and public.is_approved() and exists (
      select 1 from public.projects p where p.id = project_id and p.owner_id = auth.uid()
    )
  );

drop policy if exists "delete own sessions" on public.project_sessions;
create policy "delete own sessions" on public.project_sessions
  for delete to authenticated using (owner_id = auth.uid());

-- ── transcript_items ───────────────────────────────────────────────────────
drop policy if exists "read own transcripts" on public.transcript_items;
create policy "read own transcripts" on public.transcript_items
  for select to authenticated using (owner_id = auth.uid());

-- WITH CHECK also verifies session_id belongs to this user: FK checks bypass
-- RLS, so without this an approved user could attach a transcript row to
-- someone else's session by naming their own owner_id but another user's
-- session_id — and the security definer count trigger would then write to
-- that other user's project_sessions.item_count.
drop policy if exists "create own transcripts" on public.transcript_items;
create policy "create own transcripts" on public.transcript_items
  for insert to authenticated
  with check (
    owner_id = auth.uid() and public.is_approved() and exists (
      select 1 from public.project_sessions s where s.id = session_id and s.owner_id = auth.uid()
    )
  );

drop policy if exists "update own transcripts" on public.transcript_items;
create policy "update own transcripts" on public.transcript_items
  for update to authenticated
  using (owner_id = auth.uid())
  with check (
    owner_id = auth.uid() and public.is_approved() and exists (
      select 1 from public.project_sessions s where s.id = session_id and s.owner_id = auth.uid()
    )
  );

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
  with check (
    scope = 'project' and owner_id = auth.uid() and public.is_approved() and exists (
      select 1 from public.projects p where p.id = project_id and p.owner_id = auth.uid()
    )
  );

drop policy if exists "update own project lists" on public.glossary_lists;
create policy "update own project lists" on public.glossary_lists
  for update to authenticated
  using (scope = 'project' and owner_id = auth.uid())
  with check (
    scope = 'project' and owner_id = auth.uid() and public.is_approved() and exists (
      select 1 from public.projects p where p.id = project_id and p.owner_id = auth.uid()
    )
  );

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
