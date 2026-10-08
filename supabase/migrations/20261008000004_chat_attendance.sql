-- =====================================================================
-- Chats (group rooms + direct chats) and HQ attendance
-- =====================================================================

-- ---------------------------------------------------------------- chat rooms
-- Rooms this account belongs to (same rules as the Apps Script):
--   Admin  : Everyone · Admin & HQs · Admin & RNS · direct chat with each HQ, RNS and Finance
--   RNS    : Everyone · <RNS> & branches · <HQ> & branches · direct chat with each HQ it covers · Admin & RNS · Admin
--   HQ     : Everyone · <HQ> & branches · Admin & HQs · Admin · each RNS of the HQ · Finance
--   Branch : Everyone · <HQ> & branches · <RNS> & branches
--   Finance: Admin · each HQ
create or replace function public.dm_room(a text, b text) returns text
language sql immutable as $$
  select 'dm:' || least(norm_key(a), norm_key(b)) || '~' || greatest(norm_key(a), norm_key(b))
$$;

create or replace function public.my_chat_rooms()
returns table (id text, name text, kind text, hint text, sort int)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare u app_users; v_b branches; v_rns app_users; h text; x record;
begin
  select * into u from app_users where app_users.id = auth.uid() and active;
  if u.id is null then return; end if;
  if u.type <> 'Finance' then
    return query select 'all'::text, 'Everyone'::text, 'group'::text, 'Message everyone…'::text, 0;
  end if;

  if u.type = 'Branch' then
    select * into v_b from branches where branches.id = u.branch_id;
    if v_b.id is not null then
      return query select 'hq:' || v_b.hq_code, hq.name || ' & branches', 'group'::text,
                          'Message ' || hq.name || ', its branches and RNS…', 1 from hqs hq where hq.code = v_b.hq_code;
      select * into v_rns from app_users where app_users.id = v_b.rns_user_id and active;
      if v_rns.id is not null then
        return query select 'rns:' || norm_key(v_rns.username), coalesce(v_rns.full_name, v_rns.display_name) || ' & branches',
                            'group'::text, 'Message your RNS and the assigned branches…', 2;
      end if;
    end if;
  elsif u.type = 'HQ' then
    foreach h in array u.hq_codes loop
      return query select 'hq:' || hq.code, hq.name || ' & branches', 'group'::text, 'Message ' || hq.name || ', its branches and RNS…', 1
        from hqs hq where hq.code = h;
    end loop;
    return query select 'admin'::text, 'Admin & HQs'::text, 'group'::text, 'Message the Supply Office and all HQs…'::text, 3;
    return query select dm_room('ADMIN', u.username), 'Supply Office (Admin)'::text, 'direct'::text, 'Message the Supply Office…'::text, 10;
    for x in select r.username, coalesce(r.full_name, r.display_name) nm from app_users r
             where r.type = 'RNS' and r.active and r.hq_codes && u.hq_codes order by 2 loop
      return query select dm_room(u.username, x.username), x.nm || ' (RNS)', 'direct'::text, 'Message ' || x.nm || '…', 11;
    end loop;
    for x in select r.username, coalesce(r.full_name, r.display_name) nm from app_users r where r.type = 'Finance' and r.active order by 2 loop
      return query select dm_room(u.username, x.username), x.nm || ' (Finance)', 'direct'::text, 'Message ' || x.nm || '…', 12;
    end loop;
  elsif u.type = 'RNS' then
    return query select 'rns:' || norm_key(u.username), coalesce(u.full_name, u.display_name) || ' & branches', 'group'::text,
                        'Message your assigned branches…', 1;
    foreach h in array u.hq_codes loop
      return query select 'hq:' || hq.code, hq.name || ' & branches', 'group'::text, 'Message ' || hq.name || ', its branches and RNS…', 2
        from hqs hq where hq.code = h;
    end loop;
    for x in select r.username, coalesce(r.full_name, r.display_name) nm from app_users r
             where r.type = 'HQ' and r.active and r.hq_codes && u.hq_codes order by 2 loop
      return query select dm_room(x.username, u.username), x.nm || ' (HQ)', 'direct'::text, 'Message ' || x.nm || '…', 11;
    end loop;
    return query select 'adminrns'::text, 'Admin & RNS'::text, 'group'::text, 'Message the Supply Office and all RNS…'::text, 3;
    return query select dm_room('ADMIN', u.username), 'Supply Office (Admin)'::text, 'direct'::text, 'Message the Supply Office…'::text, 10;
  elsif u.type = 'Admin' then
    return query select 'admin'::text, 'Admin & HQs'::text, 'group'::text, 'Message the Supply Office and all HQs…'::text, 3;
    return query select 'adminrns'::text, 'Admin & RNS'::text, 'group'::text, 'Message the Supply Office and all RNS…'::text, 4;
    for x in select r.username, coalesce(r.full_name, r.display_name) nm, r.type t from app_users r
             where r.type in ('HQ', 'RNS', 'Finance') and r.active order by r.type, 2 loop
      return query select dm_room('ADMIN', x.username), x.nm || ' (' || x.t || ')', 'direct'::text, 'Message ' || x.nm || '…', 11;
    end loop;
  elsif u.type = 'Finance' then
    return query select dm_room('ADMIN', u.username), 'Supply Office (Admin)'::text, 'direct'::text, 'Message the Supply Office…'::text, 10;
    for x in select r.username, coalesce(r.full_name, r.display_name) nm from app_users r where r.type = 'HQ' and r.active order by 2 loop
      return query select dm_room(x.username, u.username), x.nm || ' (HQ)', 'direct'::text, 'Message ' || x.nm || '…', 11;
    end loop;
  end if;
end $$;

create or replace function public.my_chat_room_ids() returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct id), '{}') from my_chat_rooms()
$$;

create or replace function public.chat_room_folder(r text) returns text
language sql immutable as $$ select regexp_replace(r, '[^A-Za-z0-9]', '_', 'g') $$;

create table public.chat_messages (
  id          bigserial primary key,
  room_id     text not null,
  user_id     uuid references public.app_users(id) on delete set null,
  author      text not null,
  author_type text,
  place       text,
  body        text not null default '' check (length(body) <= 500),
  attachment  jsonb,
  created_at  timestamptz not null default now()
);
create index on public.chat_messages (room_id, id);

alter table public.chat_messages enable row level security;
create policy chat_read on public.chat_messages for select to authenticated
  using (room_id in (select unnest(my_chat_room_ids())));

-- p_attach: null · {kind:'file'|'image', path, name, mime, size} (already uploaded to the "chat" bucket) · {kind:'call'}
create or replace function public.chat_post(p_room text, p_body text, p_attach jsonb default null) returns bigint
language plpgsql security definer set search_path = public as $$
declare u app_users; v_body text := trim(coalesce(p_body, '')); v_att jsonb; v_id bigint; v_place text; v_last timestamptz;
begin
  select * into u from app_users where id = auth.uid() and active;
  if u.id is null then raise exception 'Session expired. Please log in again.'; end if;
  if not (p_room = any (my_chat_room_ids())) then raise exception 'You are not a member of this chat.'; end if;
  if length(v_body) > 500 then raise exception 'Messages can be up to 500 characters.'; end if;
  select max(created_at) into v_last from chat_messages where user_id = u.id;
  if v_last > now() - interval '1 second' then raise exception 'You are sending too fast. Wait a moment.'; end if;

  if p_attach is not null and p_attach->>'kind' = 'call' then
    v_att := jsonb_build_object('kind', 'call', 'url', 'https://meet.jit.si/RBABC-' ||
             left(regexp_replace(p_room, '[^A-Za-z0-9]', '', 'g'), 24) || '-' || left(gen_random_uuid()::text, 8));
    if v_body = '' then v_body := '📹 Video call started — tap Join to enter.'; end if;
  elsif p_attach is not null and p_attach->>'kind' in ('file', 'image') then
    if coalesce(p_attach->>'path', '') not like chat_room_folder(p_room) || '/%' then raise exception 'Attachment not found.'; end if;
    if coalesce((p_attach->>'size')::bigint, 0) > 10 * 1024 * 1024 then raise exception 'Files can be up to 10 MB.'; end if;
    v_att := jsonb_build_object('kind', p_attach->>'kind', 'path', p_attach->>'path', 'name', left(p_attach->>'name', 120),
                                'mime', left(p_attach->>'mime', 100), 'size', (p_attach->>'size')::bigint);
  end if;
  if v_body = '' and v_att is null then raise exception 'Type a message first.'; end if;

  v_place := case u.type when 'Branch' then (select name from branches where id = u.branch_id)
                         when 'Admin' then 'Supply Office' else array_to_string(u.hq_codes, ', ') end;
  insert into chat_messages (room_id, user_id, author, author_type, place, body, attachment)
  values (p_room, u.id, coalesce(nullif(u.full_name, ''), u.display_name), u.type::text, v_place, v_body, v_att)
  returning id into v_id;
  return v_id;
end $$;

-- ---------------------------------------------------------------- attendance
create table public.employees (
  id      text primary key,          -- e.g. RBSO-001
  name    text not null,
  hq_code text references public.hqs(code),
  active  boolean not null default true
);

create table public.attendance_sites (
  name   text primary key,           -- e.g. 'CEBU HQ'
  hq_code text references public.hqs(code),
  lat    double precision,
  lng    double precision,
  radius int not null default 100,
  active boolean not null default true
);

create table public.attendance (
  id          bigserial primary key,
  work_date   date not null,
  employee_id text not null references public.employees(id),
  employee_name text not null,
  time_in     timestamptz not null,
  in_photo    text,
  time_out    timestamptz,
  out_photo   text,
  hours       numeric(6, 2),
  status      text not null check (status in ('TIMED IN', 'COMPLETE', 'NO TIME OUT')),
  site        text not null,
  in_lat double precision, in_lng double precision, in_dist int,
  out_lat double precision, out_lng double precision, out_dist int,
  remarks     text,
  logged_by   uuid references public.app_users(id) on delete set null
);
create index on public.attendance (work_date);
create index on public.attendance (employee_id, work_date);

alter table public.employees enable row level security;
alter table public.attendance_sites enable row level security;
alter table public.attendance enable row level security;
create policy emp_read on public.employees for select to authenticated using (me_type() in ('HQ', 'Admin'));
create policy emp_admin on public.employees for all to authenticated using (is_admin()) with check (is_admin());
create policy site_read on public.attendance_sites for select to authenticated using (me_type() in ('HQ', 'Admin'));
create policy site_admin on public.attendance_sites for all to authenticated using (is_admin()) with check (is_admin());
-- HQ loggers see one employee's own log through attendance_for(); the full list is for Admin
create policy att_admin on public.attendance for select to authenticated using (is_admin());

-- After 12:00 AM a TIME IN of an earlier day is closed as NO TIME OUT
create or replace function public.attendance_autoclose() returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update attendance set status = 'NO TIME OUT',
         remarks = concat_ws(' · ', nullif(remarks, ''), 'No TIME OUT — reset at 12:00 AM')
   where status = 'TIMED IN' and work_date < mnl_today();
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.geo_distance(lat1 float8, lng1 float8, lat2 float8, lng2 float8) returns int
language sql immutable as $$
  select round(2 * 6371000 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2))))::int
$$;

-- HQ logger: one employee's status and last 7 days
create or replace function public.attendance_for(p_emp text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare e employees; v_today date := mnl_today();
begin
  perform require_type('HQ', 'Admin');
  perform attendance_autoclose();
  select * into e from employees where upper(id) = upper(trim(p_emp)) and active;
  if e.id is null then raise exception 'Employee ID % not found.', p_emp; end if;
  return jsonb_build_object('id', e.id, 'name', e.name, 'today', v_today,
    'open', (select to_jsonb(a) from attendance a where a.employee_id = e.id and a.status = 'TIMED IN' and a.work_date = v_today
             order by a.id desc limit 1),
    'recent', (select coalesce(jsonb_agg(to_jsonb(a) order by a.work_date desc, a.id desc), '[]') from attendance a
               where a.employee_id = e.id and a.work_date >= v_today - 6));
end $$;

-- HQ logs TIME IN / TIME OUT. The selfie is uploaded to the "attendance" bucket first.
-- p: { action:'IN'|'OUT', id, site, lat, lng, accuracy, photoPath }
create or replace function public.attendance_log(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare e employees; s attendance_sites; v_action text := upper(coalesce(p->>'action', ''));
        v_lat float8; v_lng float8; v_acc float8; v_dist int; v_open attendance; v_now timestamptz := now();
        v_hours numeric; v_ot numeric; v_ot_after numeric := coalesce(setting_text('attendance_ot_hours', '10')::numeric, 10);
        v_photo text := trim(coalesce(p->>'photoPath', ''));
begin
  perform require_type('HQ');
  if v_action not in ('IN', 'OUT') then raise exception 'Choose TIME IN or TIME OUT.'; end if;
  select * into e from employees where upper(id) = upper(trim(coalesce(p->>'id', ''))) and active;
  if e.id is null then raise exception 'Employee ID not found. Check the ID, or ask Admin to add it.'; end if;
  begin v_lat := (p->>'lat')::float8; v_lng := (p->>'lng')::float8; v_acc := nullif(p->>'accuracy', '')::float8;
  exception when others then v_lat := null; end;
  if v_lat is null or v_lng is null or (v_lat = 0 and v_lng = 0) then
    raise exception 'Cannot get your location. Turn on GPS and allow location, then try again.';
  end if;
  if v_acc is not null and v_acc > 150 then
    raise exception 'GPS signal too weak (±% m). Go near a window or door, turn on Precise Location, and try again.', round(v_acc);
  end if;
  if v_photo = '' or v_photo !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}/' then raise exception 'Take a selfie first.'; end if;
  select * into s from attendance_sites where upper(name) = upper(trim(coalesce(p->>'site', ''))) and active;
  if s.name is null then raise exception 'Choose the headquarters you are reporting to.'; end if;
  if s.lat is null or s.lng is null then raise exception 'The location of % is not set yet. Inform Admin.', s.name; end if;
  v_dist := geo_distance(v_lat, v_lng, s.lat, s.lng);
  if v_dist > s.radius then
    raise exception 'Too far from % (% m away, must be within % m). Make sure you are inside and the correct HQ is selected.', s.name, v_dist, s.radius;
  end if;

  perform attendance_autoclose();
  select * into v_open from attendance where employee_id = e.id and status = 'TIMED IN' and work_date = mnl_today()
   order by id desc limit 1 for update;
  if v_action = 'IN' then
    if v_open.id is not null then
      raise exception '% already timed in at % today. Use TIME OUT.', e.name, to_char(v_open.time_in at time zone 'Asia/Manila', 'HH12:MI AM');
    end if;
    insert into attendance (work_date, employee_id, employee_name, time_in, in_photo, status, site, in_lat, in_lng, in_dist, logged_by)
    values (mnl_today(), e.id, e.name, v_now, v_photo, 'TIMED IN', s.name, v_lat, v_lng, v_dist, auth.uid());
    perform log_event('ATTENDANCE IN ' || e.id);
    return jsonb_build_object('ok', true, 'msg', 'TIME IN recorded for ' || e.name || ' at ' || to_char(v_now at time zone 'Asia/Manila', 'HH12:MI AM') || '.');
  end if;
  if v_open.id is null then raise exception 'No TIME IN today for %. Use TIME IN first, or inform Admin.', e.name; end if;
  v_hours := round(extract(epoch from (v_now - v_open.time_in)) / 3600.0, 2);
  v_ot := case when v_hours > v_ot_after then round(v_hours - v_ot_after, 2) else 0 end;
  update attendance set time_out = v_now, out_photo = v_photo, hours = v_hours, status = 'COMPLETE',
         out_lat = v_lat, out_lng = v_lng, out_dist = v_dist,
         remarks = nullif(concat_ws(' · ', nullif(remarks, ''),
                     case when v_ot > 0 then 'Overtime: ' || v_ot || ' hrs beyond ' || v_ot_after || ' hrs' end,
                     case when s.name <> v_open.site then 'Time out at ' || s.name end), '')
   where id = v_open.id;
  perform log_event('ATTENDANCE OUT ' || e.id);
  return jsonb_build_object('ok', true, 'msg', 'TIME OUT recorded for ' || e.name || ' at ' ||
    to_char(v_now at time zone 'Asia/Manila', 'HH12:MI AM') || ' (' || v_hours || ' hours' ||
    case when v_ot > 0 then ', overtime ' || v_ot || ' hrs' else '' end || ').');
end $$;
