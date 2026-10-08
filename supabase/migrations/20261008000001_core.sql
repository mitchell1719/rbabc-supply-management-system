-- =====================================================================
-- RB ABC Supply Office Portal — core: HQs, branches, users, settings,
-- helper functions, quick links, login log, e-mail outbox.
-- =====================================================================
create extension if not exists pgcrypto;

create type public.user_type as enum ('Branch', 'HQ', 'RNS', 'Admin', 'Finance');

-- ---------------------------------------------------------------- time
-- The portal works on Manila time (the Apps Script used Asia/Manila).
create or replace function public.mnl_now() returns timestamp
language sql stable as $$ select (now() at time zone 'Asia/Manila') $$;

create or replace function public.mnl_today() returns date
language sql stable as $$ select (now() at time zone 'Asia/Manila')::date $$;

-- "Danao" / "RB ABC Lapu-lapu Inc." → "LAPULAPU" (same as norm_ in Code.gs)
create or replace function public.norm_key(s text) returns text
language sql immutable as $$
  select regexp_replace(
           regexp_replace(regexp_replace(upper(coalesce(s, '')), '^\s*(RB|BR)\s*ABC\s*', ''), '\s*INC\.?\s*$', ''),
           '[^A-Z0-9]', '', 'g')
$$;

-- description key used to match PRS items and delivery lines
create or replace function public.item_key(s text) returns text
language sql immutable as $$ select lower(regexp_replace(coalesce(s, ''), '[^a-zA-Z0-9]', '', 'g')) $$;

-- ---------------------------------------------------------------- HQs & branches
create table public.hqs (
  code   text primary key,                 -- PASIG / CEBU / CDO / DAVAO
  name   text not null,                    -- 'Pasig City HQ'
  region text not null,                    -- Luzon / Visayas / Mindanao
  email  text,                             -- Supply Officer notification e-mail
  sort   int not null default 0
);

create table public.branches (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,        -- 'RB ABC Danao Inc.'
  short_name  text not null,               -- 'DANAO'
  code        text,                        -- official code, e.g. DAN / LPSG / MCDO
  hq_code     text not null references public.hqs(code),
  region      text,
  rns_user_id uuid,                        -- assigned Regional Nurse Supervisor
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
create index on public.branches (hq_code);

-- ---------------------------------------------------------------- users
create table public.app_users (
  id            uuid primary key references auth.users(id) on delete cascade,
  username      text not null,
  display_name  text not null,
  type          public.user_type not null,
  hq_codes      text[] not null default '{}',    -- HQ: its HQ · RNS: HQs it covers
  branch_id     uuid references public.branches(id) on delete set null,   -- Branch accounts
  region        text,
  active        boolean not null default true,
  email         text,                             -- notification e-mail (RNS / HQ / Finance / Admin)
  full_name     text,
  position      text,
  contact       text,
  photo_path    text,                             -- storage: avatars/<id>/...
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index app_users_username_uq on public.app_users (upper(username));

alter table public.branches
  add constraint branches_rns_fk foreign key (rns_user_id) references public.app_users(id) on delete set null;

-- ---------------------------------------------------------------- helpers
create or replace function public.me_type() returns public.user_type
language sql stable security definer set search_path = public as $$
  select type from app_users where id = auth.uid() and active
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select type = 'Admin' from app_users where id = auth.uid() and active), false)
$$;

create or replace function public.my_branch() returns uuid
language sql stable security definer set search_path = public as $$
  select branch_id from app_users where id = auth.uid() and active and type = 'Branch'
$$;

-- HQ codes the user belongs to (a Branch belongs to the HQ of its branch)
create or replace function public.my_hqs() returns text[]
language sql stable security definer set search_path = public as $$
  select case when u.type = 'Branch' then coalesce(array[b.hq_code], '{}') else u.hq_codes end
  from app_users u left join branches b on b.id = u.branch_id
  where u.id = auth.uid() and u.active
$$;

create or replace function public.my_name() returns text
language sql stable security definer set search_path = public as $$
  select coalesce(nullif(full_name, ''), display_name) from app_users where id = auth.uid()
$$;

-- Who can see a branch's data:
--   Admin all · Branch its own · HQ its HQ's branches ·
--   RNS its assigned branches (branches.rns_user_id), else every branch under its HQs.
create or replace function public.can_see_branch(p_branch uuid) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare t user_type := me_type();
begin
  if t is null or p_branch is null then return false; end if;
  if t = 'Admin' then return true; end if;
  if t = 'Branch' then return p_branch = my_branch(); end if;
  if t = 'HQ' then
    return exists (select 1 from branches where id = p_branch and hq_code = any (my_hqs()));
  end if;
  if t = 'RNS' then
    if exists (select 1 from branches where rns_user_id = auth.uid()) then
      return exists (select 1 from branches where id = p_branch and rns_user_id = auth.uid());
    end if;
    return exists (select 1 from branches where id = p_branch and hq_code = any (my_hqs()));
  end if;
  return false;
end $$;

create or replace function public.require_type(variadic p_types public.user_type[]) returns public.user_type
language plpgsql stable security definer set search_path = public as $$
declare t user_type := me_type();
begin
  if t is null then raise exception 'Session expired. Please log in again.'; end if;
  if not (t = any (p_types)) then raise exception 'This action is not available for % accounts.', t; end if;
  return t;
end $$;

-- ---------------------------------------------------------------- settings
create table public.app_settings (
  key   text primary key,
  value jsonb not null,
  note  text
);

create or replace function public.setting(p_key text) returns jsonb
language sql stable security definer set search_path = public as $$
  select value from app_settings where key = p_key
$$;

create or replace function public.setting_text(p_key text, p_default text default '') returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select value #>> '{}' from app_settings where key = p_key), p_default)
$$;

-- ---------------------------------------------------------------- numbering
create table public.doc_counters (
  prefix text not null,
  year   int  not null,
  last   int  not null default 0,
  primary key (prefix, year)
);

-- 'CEBU HQ', 2026 → 'CEBU HQ 001-2026' style numbers; atomic under concurrency
create or replace function public.next_seq(p_prefix text, p_year int) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into doc_counters (prefix, year, last) values (p_prefix, p_year, 1)
  on conflict (prefix, year) do update set last = doc_counters.last + 1
  returning last into n;
  return n;
end $$;

create or replace function public.next_doc_no(p_prefix text) returns text
language plpgsql security definer set search_path = public as $$
declare y int := extract(year from mnl_today());
begin
  return p_prefix || ' ' || lpad(next_seq(p_prefix, y)::text, 3, '0') || '-' || y;
end $$;

-- ---------------------------------------------------------------- e-mail outbox
-- Filled by the workflow functions; sent by the "send-emails" Edge Function.
create table public.email_outbox (
  id         bigserial primary key,
  to_addr    text[] not null,
  cc_addr    text[] not null default '{}',
  subject    text not null,
  html       text not null,
  created_at timestamptz not null default now(),
  sent_at    timestamptz,
  attempts   int not null default 0,
  error      text
);

create or replace function public.queue_email(p_to text[], p_cc text[], p_subject text, p_html text) returns void
language plpgsql security definer set search_path = public as $$
declare t text[]; c text[];
begin
  select coalesce(array_agg(distinct x), '{}') into t from unnest(p_to) x where x ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$';
  select coalesce(array_agg(distinct x), '{}') into c from unnest(coalesce(p_cc, '{}')) x
    where x ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and not (x = any (t));
  if cardinality(t) = 0 then return; end if;
  insert into email_outbox (to_addr, cc_addr, subject, html) values (t, c, p_subject, p_html);
end $$;

create or replace function public.esc(s text) returns text
language sql immutable as $$
  select replace(replace(replace(replace(coalesce(s, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;')
$$;

create or replace function public.mail_wrap(p_title text, p_body text) returns text
language sql stable as $$
  select '<div style="font-family:Arial;font-size:14px;color:#1B2133">' ||
         '<div style="background:#C62828;color:#fff;padding:12px 16px;font-weight:bold">' || esc(p_title) || '</div>' ||
         p_body ||
         case when setting_text('portal_url') <> '' then
           '<p><a href="' || esc(setting_text('portal_url')) || '" style="color:#1E3A8A;font-weight:bold">Open the Supply Office portal</a></p>'
         else '' end || '</div>'
$$;

create or replace function public.director_email() returns text
language sql stable as $$ select setting_text('supply_director_email') $$;

create or replace function public.hq_email(p_hq text) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select email from app_users where type = 'HQ' and active and p_hq = any (hq_codes) and email is not null limit 1),
    (select email from hqs where code = p_hq))
$$;

create or replace function public.admin_emails() returns text[]
language sql stable security definer set search_path = public as $$
  select array_remove(array_agg(distinct e), null) from (
    select email e from app_users where type = 'Admin' and active
    union select nullif(setting_text('supply_director_email'), '')) s
$$;

create or replace function public.finance_emails() returns text[]
language sql stable security definer set search_path = public as $$
  select array_remove(array_agg(distinct e), null) from (
    select email e from app_users where type = 'Finance' and active
    union select nullif(setting_text('finance_email'), '')) s
$$;

-- ---------------------------------------------------------------- login: username → auth e-mail
-- Lets people log in with their username (DANAO, CEBU HQ, RNS DALAPO). Returns the
-- Supabase Auth e-mail of the account, 'INACTIVE', or null when the username is unknown.
create or replace function public.login_email(p_username text) returns text
language sql stable security definer set search_path = public, auth as $$
  select case when u.active then au.email else 'INACTIVE' end
  from app_users u join auth.users au on au.id = u.id
  where upper(trim(u.username)) = upper(trim(p_username))
     or norm_key(u.display_name) = norm_key(p_username)
  order by (upper(trim(u.username)) = upper(trim(p_username))) desc
  limit 1
$$;

-- ---------------------------------------------------------------- login log
create table public.login_log (
  id       bigserial primary key,
  at       timestamptz not null default now(),
  user_id  uuid,
  username text,
  type     text,
  result   text not null
);

create or replace function public.log_event(p_result text) returns void
language sql security definer set search_path = public as $$
  insert into login_log (user_id, username, type, result)
  select id, username, type::text, left(p_result, 300) from app_users where id = auth.uid()
$$;

-- ---------------------------------------------------------------- profile (current user)
create or replace function public.my_profile() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', u.id, 'username', u.username, 'displayName', u.display_name, 'type', u.type,
    'hqs', case when u.type = 'Branch' then coalesce(array[b.hq_code], '{}') else u.hq_codes end,
    'hqNames', (select coalesce(array_agg(h.name order by h.sort), '{}') from hqs h
                where h.code = any (case when u.type = 'Branch' then array[b.hq_code] else u.hq_codes end)),
    'branchId', u.branch_id, 'branchName', b.name, 'region', u.region,
    'email', u.email, 'fullName', u.full_name, 'position', u.position, 'contact', u.contact,
    'photoPath', u.photo_path,
    'rns', (select jsonb_build_object('name', coalesce(r.full_name, r.display_name), 'email', r.email)
            from app_users r where r.id = b.rns_user_id),
    'title', setting_text('portal_title', 'RB ABC Supply Office'))
  from app_users u left join branches b on b.id = u.branch_id
  where u.id = auth.uid() and u.active
$$;

create or replace function public.profile_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_name text := left(trim(coalesce(p->>'fullName', '')), 120);
        v_email text := left(trim(coalesce(p->>'email', '')), 120);
        v_contact text := left(trim(coalesce(p->>'contact', '')), 20);
begin
  if me_type() is null then raise exception 'Session expired. Please log in again.'; end if;
  if v_name = '' then raise exception 'Enter your full name.'; end if;
  if v_email <> '' and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Enter a valid email address.'; end if;
  if v_contact <> '' and v_contact !~ '^[0-9+()\-\s]{7,20}$' then raise exception 'Enter a valid contact number (digits, +, - only).'; end if;
  update app_users set full_name = v_name, position = left(trim(coalesce(p->>'position', '')), 120),
         contact = nullif(v_contact, ''), email = nullif(v_email, ''),
         photo_path = case when p ? 'photoPath' then nullif(p->>'photoPath', '') else photo_path end,
         updated_at = now()
   where id = auth.uid();
  perform log_event('PROFILE UPDATED');
  return my_profile();
end $$;

-- directory of active users (names / photos for chat, contacts)
create or replace view public.user_directory with (security_invoker = false) as
  select id, username, display_name, type, hq_codes, branch_id,
         coalesce(nullif(full_name, ''), display_name) as name, position, photo_path
  from public.app_users where active;

-- ---------------------------------------------------------------- quick links
create table public.links (
  id          bigserial primary key,
  name        text not null,
  url         text not null check (url ~* '^https?://'),
  show_to     text[] not null default '{All}',    -- All / Branch / HQ / RNS / Admin / Finance
  hq_only     text references public.hqs(code),
  description text,
  highlight   boolean not null default false,
  active      boolean not null default true,
  sort        int not null default 0
);

-- ---------------------------------------------------------------- RLS
alter table public.hqs           enable row level security;
alter table public.branches      enable row level security;
alter table public.app_users     enable row level security;
alter table public.app_settings  enable row level security;
alter table public.doc_counters  enable row level security;
alter table public.email_outbox  enable row level security;
alter table public.login_log     enable row level security;
alter table public.links         enable row level security;

create policy hqs_read on public.hqs for select to authenticated using (true);
create policy hqs_admin on public.hqs for all to authenticated using (is_admin()) with check (is_admin());

create policy branches_read on public.branches for select to authenticated using (me_type() is not null);
create policy branches_admin on public.branches for all to authenticated using (is_admin()) with check (is_admin());

create policy users_read_self on public.app_users for select to authenticated using (id = auth.uid() or is_admin());
create policy users_admin on public.app_users for update to authenticated using (is_admin()) with check (is_admin());

create policy settings_read on public.app_settings for select to authenticated using (true);
create policy settings_admin on public.app_settings for all to authenticated using (is_admin()) with check (is_admin());

create policy outbox_admin on public.email_outbox for select to authenticated using (is_admin());
create policy log_admin on public.login_log for select to authenticated using (is_admin());

create policy links_read on public.links for select to authenticated using (
  active and (is_admin()
    or ('All' = any (show_to) or me_type()::text = any (show_to))
       and (hq_only is null or hq_only = any (my_hqs()))));
create policy links_admin on public.links for all to authenticated using (is_admin()) with check (is_admin());

revoke all on public.user_directory from anon;
grant select on public.user_directory to authenticated;
grant execute on function public.login_email(text) to anon, authenticated;
