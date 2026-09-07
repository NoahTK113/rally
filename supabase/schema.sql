-- =========================================================================
-- BANJOBALL — profiles, gauntlet runs, and a leaderboard
--
-- Paste this whole file into the Supabase SQL Editor and run it. It is
-- idempotent: running it again is safe.
--
-- THE SHAPE, and why it is this shape.
--
-- The client never writes a score. It cannot: row-level security grants it
-- SELECT and nothing else on both tables, so an INSERT or UPDATE from the
-- browser is refused however it is issued. The only way in is three functions
-- marked SECURITY DEFINER, which run with the owner's rights and apply their
-- own checks first.
--
-- So the client does not say "my best is 47". It says "I scored", and is told
-- what level it is now on. There is no number to forge, only an event to
-- claim, and claims are checked.
--
-- THE CHECK is derived from the game rather than guessed. After a goal the
-- phase machine forces ANNOUNCE (2s) then COUNT (3s) before play resumes —
-- five seconds of dead time, before any rally. A goal cannot legitimately
-- follow another in under six. A run that claims fifty levels must therefore
-- have spent at least five minutes doing it, in correctly spaced steps.
--
-- That also means no heartbeat is needed: the gaps between goals are the
-- heartbeat.
--
-- WHAT THIS DOES NOT DO is stop a determined person from scripting a
-- plausibly-paced fake session. Nothing running in a browser can. The bar it
-- sets is "write a bot that plays slowly and convincingly", which is a great
-- deal more work than editing a number, and more than anyone is going to do
-- for a paddle game among friends.
-- =========================================================================


-- -------------------------------------------------------------------------
-- PROFILES
--
-- One row per player, created automatically on sign-up. Readable by everyone,
-- because the leaderboard is the point; writable by nobody through the API.
-- -------------------------------------------------------------------------
create table if not exists public.profiles (
  id         uuid primary key references auth.users on delete cascade,
  username   text not null unique,
  best_level int  not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

/* Usernames have to survive being turned into <username>@banjoball.invalid,
   which is how they reach an auth system that only understands email
   addresses. Lowercase, 3-20, letters digits hyphen underscore. */
do $$
begin
  alter table public.profiles
    add constraint profiles_username_shape
    check (username ~ '^[a-z0-9_-]{3,20}$');
exception when duplicate_object then null;
end $$;


-- -------------------------------------------------------------------------
-- RUNS
--
-- One row per gauntlet attempt. The level lives here, on the server, and is
-- only ever moved by record_goal.
-- -------------------------------------------------------------------------
create table if not exists public.runs (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users on delete cascade,
  level        int  not null default 1,
  started_at   timestamptz not null default now(),
  last_goal_at timestamptz not null default now(),
  ended_at     timestamptz,
  -- cleared the moment a run does something impossible; it may finish, but it
  -- can no longer touch the record
  ranked       boolean not null default true
);

create index if not exists runs_user_started_idx
  on public.runs (user_id, started_at desc);


-- -------------------------------------------------------------------------
-- ROW LEVEL SECURITY
--
-- Read-only for the client, on both tables. There are deliberately NO insert,
-- update or delete policies: their absence is the security, not an oversight.
-- -------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.runs     enable row level security;

drop policy if exists "profiles readable by all" on public.profiles;
create policy "profiles readable by all"
  on public.profiles for select
  using (true);

drop policy if exists "own runs readable" on public.runs;
create policy "own runs readable"
  on public.runs for select
  using (auth.uid() = user_id);


-- -------------------------------------------------------------------------
-- SIGN-UP
--
-- The username travels in the sign-up metadata and lands here. Doing it in a
-- trigger rather than a second call from the client means an account can never
-- exist without its profile.
-- -------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, username)
  values (new.id, lower(new.raw_user_meta_data->>'username'));
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- -------------------------------------------------------------------------
-- THE THREE CALLS
-- -------------------------------------------------------------------------

/* Open a run. Any run still open is closed first, so a client that vanished
   mid-game cannot come back an hour later and carry on from where it was. */
create or replace function public.start_run()
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_id     uuid;
  v_recent int;
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;

  -- a light brake on churn; nothing is gained by it, but nothing needs it either
  select count(*) into v_recent
    from public.runs
   where user_id = auth.uid()
     and started_at > now() - interval '1 minute';
  if v_recent >= 10 then
    raise exception 'too many runs started';
  end if;

  update public.runs
     set ended_at = now()
   where user_id = auth.uid()
     and ended_at is null;

  insert into public.runs (user_id) values (auth.uid())
  returning id into v_id;

  return v_id;
end;
$$;


/* A goal. Returns the level the run is now on — the client is told, never
   asked.

   Six seconds is the floor the game itself imposes: two of announcement and
   three of countdown after every goal, plus a rally. Anything faster did not
   happen, so the run stops being ranked and is closed. It is not an error the
   player can retry past. */
create or replace function public.record_goal(p_run uuid)
returns int
language plpgsql
security definer set search_path = public
as $$
declare
  v_run   public.runs;
  v_level int;
begin
  select * into v_run
    from public.runs
   where id = p_run
     and user_id = auth.uid()
     and ended_at is null
   for update;

  if not found then
    raise exception 'no open run';
  end if;

  if now() - v_run.last_goal_at < interval '6 seconds' then
    update public.runs
       set ranked = false, ended_at = now()
     where id = p_run;
    raise exception 'goal too soon';
  end if;

  update public.runs
     set level = level + 1,
         last_goal_at = now()
   where id = p_run
  returning level into v_level;

  if v_run.ranked then
    update public.profiles
       set best_level = greatest(best_level, v_level),
           updated_at = now()
     where id = auth.uid();
  end if;

  return v_level;
end;
$$;


/* Close a run. Losing, quitting and leaving all end here. */
create or replace function public.end_run(p_run uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  update public.runs
     set ended_at = now()
   where id = p_run
     and user_id = auth.uid()
     and ended_at is null;
end;
$$;


-- Only signed-in players may call these at all.
revoke execute on function public.start_run()            from anon, public;
revoke execute on function public.record_goal(uuid)      from anon, public;
revoke execute on function public.end_run(uuid)          from anon, public;
grant  execute on function public.start_run()            to authenticated;
grant  execute on function public.record_goal(uuid)      to authenticated;
grant  execute on function public.end_run(uuid)          to authenticated;


-- -------------------------------------------------------------------------
-- THE LEADERBOARD
--
-- security_invoker so the view is read under the caller's rights and obeys the
-- policy on profiles, rather than quietly bypassing it as views otherwise can.
-- -------------------------------------------------------------------------
create or replace view public.leaderboard
with (security_invoker = true) as
  select username, best_level
    from public.profiles
   where best_level > 0
   order by best_level desc, updated_at asc
   limit 100;

grant select on public.leaderboard to anon, authenticated;
