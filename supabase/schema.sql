-- ===========================================================================
--  AI Live Translator — account approval schema
--  Run once in Supabase → SQL Editor (or `supabase db push`).
--  Safe to re-run: every statement is guarded.
-- ===========================================================================
--
--  How access works
--  ----------------
--  1. A person signs in with their Google account. Supabase Auth creates the
--     row in auth.users — that alone grants NOTHING.
--  2. The registration form inserts one row here with status 'pending'.
--  3. An admin flips that row to 'approved' by hand (see the bottom of this
--     file). Only then does the app let the person in.
--
--  The browser holds the anon key, so the rules below — not the client — are
--  what actually enforce this. Users may read and create only their own row;
--  nobody can update a status through the anon key, so approval can only come
--  from the dashboard / service role.

-- ---------------------------------------------------------------------------
-- 1. Status enum
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'access_status') then
    create type public.access_status as enum ('pending', 'approved', 'rejected');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. The requests table — one row per person, keyed by their auth user id
-- ---------------------------------------------------------------------------
create table if not exists public.access_requests (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text        not null,
  first_name  text        not null,
  last_name   text        not null,
  phone       text        not null,
  status      public.access_status not null default 'pending',
  created_at  timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by text,
  review_note text,

  -- The client refuses non-Chula addresses too, but the client can be
  -- bypassed; this is the rule that actually holds. Covers chula.ac.th and
  -- every subdomain (student.chula.ac.th, eng.chula.ac.th, …).
  --
  -- NOTE: if you change VITE_ALLOWED_EMAIL_DOMAIN in .env, change this
  -- constraint to match, or approved-domain sign-ups will fail on insert.
  constraint access_requests_allowed_domain
    check (lower(email) ~ '@([a-z0-9-]+\.)*chula\.ac\.th$')
);

-- One request per address, case-insensitively.
create unique index if not exists access_requests_email_key
  on public.access_requests (lower(email));

create index if not exists access_requests_status_idx
  on public.access_requests (status, created_at desc);

comment on table public.access_requests is
  'Account approval queue. A person can use the app only while status = approved.';

-- ---------------------------------------------------------------------------
-- 3. Row-level security
-- ---------------------------------------------------------------------------
alter table public.access_requests enable row level security;

-- Read your own row (the app reads its own status on every page load).
drop policy if exists "read own access request" on public.access_requests;
create policy "read own access request"
  on public.access_requests
  for select
  to authenticated
  using (auth.uid() = id);

-- Create your own row, pending only. `status = 'pending'` in the CHECK is what
-- stops someone from inserting themselves as 'approved' with the anon key.
drop policy if exists "create own pending request" on public.access_requests;
create policy "create own pending request"
  on public.access_requests
  for insert
  to authenticated
  with check (auth.uid() = id and status = 'pending');

-- Deliberately no UPDATE and no DELETE policy: approval is an admin action
-- performed with the service role / dashboard, never by the account itself.

-- ---------------------------------------------------------------------------
-- 4. Status lookup for the sign-in dialog
-- ---------------------------------------------------------------------------
-- The login page must tell "never registered" from "waiting for approval"
-- BEFORE a session exists (a wrong password never produces one), and RLS
-- rightly hides other people's rows. This definer function exposes exactly one
-- thing — the status of one address — and nothing else about the row.
create or replace function public.get_account_status(p_email text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select status::text
       from public.access_requests
      where lower(email) = lower(trim(p_email))
      limit 1),
    'none'
  );
$$;

revoke all on function public.get_account_status(text) from public;
grant execute on function public.get_account_status(text) to anon, authenticated;

comment on function public.get_account_status(text) is
  'Returns none | pending | approved | rejected for an email address. Used by the sign-in status dialog.';

-- ===========================================================================
--  Admin cheat-sheet — run these by hand in the SQL editor
-- ===========================================================================
--
--  Pending queue:
--    select email, first_name, last_name, phone, created_at
--      from public.access_requests
--     where status = 'pending'
--     order by created_at;
--
--  Approve:
--    update public.access_requests
--       set status = 'approved', reviewed_at = now(), reviewed_by = 'you@chula.ac.th'
--     where lower(email) = lower('somchai.j@chula.ac.th');
--
--  Reject:
--    update public.access_requests
--       set status = 'rejected', reviewed_at = now(), reviewed_by = 'you@chula.ac.th',
--           review_note = 'ไม่ใช่บุคลากรในโครงการ'
--     where lower(email) = lower('somchai.j@chula.ac.th');
--
--  Revoke an approved account: set status back to 'pending' or 'rejected'.
--  The person is blocked at their next page load; to end an already-open
--  session immediately, also delete the user in Authentication → Users.
