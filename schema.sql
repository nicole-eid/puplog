-- Puppy logbook: a shared household record.
-- One household, many people, one or more dogs, an append-only stream of events.
--
-- Access rule throughout: you can see and write a row only if you are a member
-- of the household that owns it. Membership is the single source of truth, and
-- every policy below routes through is_member().

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- households

create table if not exists households (
  id          uuid primary key default gen_random_uuid(),
  name        text not null default 'Our household',
  invite_code text not null unique default encode(gen_random_bytes(5), 'hex'),
  created_by  uuid not null references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now()
);

create table if not exists household_members (
  household_id uuid not null references households (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  display_name text not null default '',
  role         text not null default 'member' check (role in ('owner','member')),
  joined_at    timestamptz not null default now(),
  primary key (household_id, user_id)
);

-- Membership check used by every policy. SECURITY DEFINER so that reading
-- household_members inside a household_members policy cannot recurse.
create or replace function is_member(h uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from household_members m
    where m.household_id = h and m.user_id = auth.uid()
  );
$$;

-- ---------------------------------------------------------------------- dogs

create table if not exists dogs (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id) on delete cascade,
  name         text not null default '',
  birthday     date,
  breed        text not null default '',
  size         text not null default 'toy' check (size in ('toy','small','medium','large')),
  unit         text not null default 'lb' check (unit in ('lb','kg')),
  created_at   timestamptz not null default now()
);
create index if not exists dogs_household_idx on dogs (household_id);

-- -------------------------------------------------------------------- events
-- One row per logged thing. The type-specific fields (meal amount, crate
-- outcome, symptom list) live in `data` as jsonb so a new event type is a
-- client change, not a migration. `at` and `ended_at` are real columns
-- because everything queries and sorts on them.

create table if not exists events (
  id         uuid primary key default gen_random_uuid(),
  dog_id     uuid not null references dogs (id) on delete cascade,
  type       text not null,
  at         timestamptz not null default now(),
  ended_at   timestamptz,
  data       jsonb not null default '{}'::jsonb,
  by_user    uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists events_dog_at_idx on events (dog_id, at desc);
-- Finding the currently-running walk/crate/nap is the hottest lookup in the app.
create index if not exists events_open_idx on events (dog_id, type) where ended_at is null;

-- -------------------------------------------------------------- pantry items

create table if not exists pantry_items (
  id         uuid primary key default gen_random_uuid(),
  dog_id     uuid not null references dogs (id) on delete cascade,
  kind       text not null default 'treat' check (kind in ('food','treat','chew')),
  brand      text not null default '',
  name       text not null default '',
  rating     int  not null default 4 check (rating between 1 and 5),
  note       text not null default '',
  added_by   uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists pantry_dog_idx on pantry_items (dog_id);

-- Resolve a dog to its household, for the policies below.
create or replace function dog_household(d uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select household_id from dogs where id = d;
$$;

-- ------------------------------------------------------------ row-level security

alter table households        enable row level security;
alter table household_members enable row level security;
alter table dogs              enable row level security;
alter table events            enable row level security;
alter table pantry_items      enable row level security;

drop policy if exists households_read   on households;
drop policy if exists households_insert on households;
drop policy if exists households_update on households;

create policy households_read on households
  for select using (is_member(id));
create policy households_insert on households
  for insert with check (created_by = auth.uid());
create policy households_update on households
  for update using (is_member(id)) with check (is_member(id));

drop policy if exists members_read   on household_members;
drop policy if exists members_insert on household_members;
drop policy if exists members_update on household_members;
drop policy if exists members_delete on household_members;

-- You can see everyone in a household you belong to.
create policy members_read on household_members
  for select using (is_member(household_id));
-- You may only ever add yourself. Joining is gated by knowing the invite code,
-- which the client exchanges through join_household() below.
create policy members_insert on household_members
  for insert with check (user_id = auth.uid());
create policy members_update on household_members
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy members_delete on household_members
  for delete using (user_id = auth.uid());

drop policy if exists dogs_all on dogs;
create policy dogs_all on dogs
  for all using (is_member(household_id)) with check (is_member(household_id));

drop policy if exists events_all on events;
create policy events_all on events
  for all using (is_member(dog_household(dog_id)))
  with check (is_member(dog_household(dog_id)));

drop policy if exists pantry_all on pantry_items;
create policy pantry_all on pantry_items
  for all using (is_member(dog_household(dog_id)))
  with check (is_member(dog_household(dog_id)));

-- ------------------------------------------------------------------- joining
-- Swapping an invite code for membership. SECURITY DEFINER because the joiner
-- cannot yet read the households row they are about to join.

create or replace function join_household(code text, who text default '')
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare h uuid;
begin
  select id into h from households where invite_code = lower(trim(code));
  if h is null then
    raise exception 'That invite code does not match a household.';
  end if;
  insert into household_members (household_id, user_id, display_name)
  values (h, auth.uid(), coalesce(nullif(who, ''), ''))
  on conflict (household_id, user_id)
  do update set display_name = coalesce(nullif(excluded.display_name, ''), household_members.display_name);
  return h;
end;
$$;

revoke all on function join_household(text, text) from public;
grant execute on function join_household(text, text) to authenticated;

-- Creating a household and joining it as owner, in one call.
create or replace function create_household(hname text, who text default '')
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare h uuid;
begin
  insert into households (name, created_by)
  values (coalesce(nullif(trim(hname), ''), 'Our household'), auth.uid())
  returning id into h;
  insert into household_members (household_id, user_id, display_name, role)
  values (h, auth.uid(), coalesce(who, ''), 'owner');
  return h;
end;
$$;

revoke all on function create_household(text, text) from public;
grant execute on function create_household(text, text) to authenticated;

-- ------------------------------------------------------------------ realtime
-- So every open phone sees a new entry the moment someone taps it.

alter publication supabase_realtime add table events;
alter publication supabase_realtime add table pantry_items;
alter publication supabase_realtime add table dogs;
