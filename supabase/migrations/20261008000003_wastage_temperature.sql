-- =====================================================================
-- ARV vial wastage (daily per branch) and refrigerator temperature log
-- =====================================================================

-- ---------------------------------------------------------------- wastage
-- Vial wastage by volume: ID dose = 0.2 mL, booster = 0.1 mL (given ID), IM dose = 1 whole vial.
-- Vial size (mL) = "ID doses per vial" × 0.2 → Abhayrab 2.5 = 0.5 mL, Speeda 3 = 0.6 mL.
create table public.wastage_reports (
  id          bigserial primary key,
  report_date date not null,
  branch_id   uuid not null references public.branches(id),
  hq_code     text not null references public.hqs(code),
  prepared_by text not null,
  abh_opened  int not null default 0 check (abh_opened between 0 and 9999),
  abh_id      int not null default 0 check (abh_id between 0 and 9999),
  abh_im      int not null default 0 check (abh_im between 0 and 9999),
  abh_booster int not null default 0 check (abh_booster between 0 and 9999),
  spd_opened  int not null default 0 check (spd_opened between 0 and 9999),
  spd_id      int not null default 0 check (spd_id between 0 and 9999),
  spd_im      int not null default 0 check (spd_im between 0 and 9999),
  spd_booster int not null default 0 check (spd_booster between 0 and 9999),
  reason      text,
  logged_at   timestamptz not null default now(),
  logged_by   uuid references public.app_users(id) on delete set null,
  unique (branch_id, report_date)
);

alter table public.wastage_reports enable row level security;
create policy wastage_read on public.wastage_reports for select to authenticated using (can_see_branch(branch_id));

create or replace function public.vials_used(p_id int, p_im int, p_b int, p_per_vial numeric) returns numeric
language sql immutable as $$
  select round(((p_id * 0.2 + p_b * 0.1) / (coalesce(nullif(p_per_vial, 0), 2.5) * 0.2)) + p_im, 4)
$$;

-- p: { date, preparedBy, abh:{opened,id,im,booster}, spd:{...}, reason }
create or replace function public.wastage_submit(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_b branches; v_date date; v_today date := mnl_today(); st jsonb := setting('wastage');
        a int[]; s int[]; k text; v text; i int; au numeric; su numeric; v_reason text := left(trim(coalesce(p->>'reason', '')), 300);
        v_exists boolean;
begin
  perform require_type('Branch');
  select * into v_b from branches where id = my_branch();
  if v_b.id is null then raise exception 'Your account is not linked to a branch.'; end if;
  begin v_date := (p->>'date')::date; exception when others then raise exception 'Choose the report date.'; end;
  if v_date is null then raise exception 'Choose the report date.'; end if;
  if v_date > v_today then raise exception 'The report date cannot be in the future.'; end if;
  if v_date < v_today - 31 then raise exception 'You can only report or correct the last 31 days.'; end if;
  if trim(coalesce(p->>'preparedBy', '')) = '' then raise exception 'Enter who prepared the report.'; end if;

  a := array[0, 0, 0, 0]; s := array[0, 0, 0, 0];
  i := 0;
  foreach k in array array['opened', 'id', 'im', 'booster'] loop
    i := i + 1;
    v := trim(coalesce(p->'abh'->>k, ''));
    if v <> '' then
      if v !~ '^\d{1,4}$' then raise exception 'Abhayrab % must be a whole number from 0 to 9999.', k; end if;
      a[i] := v::int;
    end if;
    v := trim(coalesce(p->'spd'->>k, ''));
    if v <> '' then
      if v !~ '^\d{1,4}$' then raise exception 'Speeda % must be a whole number from 0 to 9999.', k; end if;
      s[i] := v::int;
    end if;
  end loop;
  au := vials_used(a[2], a[3], a[4], coalesce((st->>'abh')::numeric, 2.5));
  su := vials_used(s[2], s[3], s[4], coalesce((st->>'spd')::numeric, 3));
  if a[1] = 0 and (a[2] + a[3] + a[4]) > 0 then raise exception 'Abhayrab has doses but 0 vials opened.'; end if;
  if s[1] = 0 and (s[2] + s[3] + s[4]) > 0 then raise exception 'Speeda has doses but 0 vials opened.'; end if;
  if au > a[1] + 0.001 then raise exception 'Abhayrab doses need % vials but only % were opened. Please check the numbers.', round(au, 2), a[1]; end if;
  if su > s[1] + 0.001 then raise exception 'Speeda doses need % vials but only % were opened. Please check the numbers.', round(su, 2), s[1]; end if;
  if (a[1] - au > 0.001 or s[1] - su > 0.001) and v_reason = '' then raise exception 'There is wastage — please enter the reason of wastage.'; end if;

  select exists (select 1 from wastage_reports where branch_id = v_b.id and report_date = v_date) into v_exists;
  insert into wastage_reports (report_date, branch_id, hq_code, prepared_by, abh_opened, abh_id, abh_im, abh_booster,
                               spd_opened, spd_id, spd_im, spd_booster, reason, logged_at, logged_by)
  values (v_date, v_b.id, v_b.hq_code, left(trim(p->>'preparedBy'), 80), a[1], a[2], a[3], a[4], s[1], s[2], s[3], s[4],
          nullif(v_reason, ''), now(), auth.uid())
  on conflict (branch_id, report_date) do update set
    prepared_by = excluded.prepared_by, abh_opened = excluded.abh_opened, abh_id = excluded.abh_id, abh_im = excluded.abh_im,
    abh_booster = excluded.abh_booster, spd_opened = excluded.spd_opened, spd_id = excluded.spd_id, spd_im = excluded.spd_im,
    spd_booster = excluded.spd_booster, reason = excluded.reason, logged_at = now(), logged_by = auth.uid();
  perform log_event('ARV WASTAGE ' || case when v_exists then 'UPDATED ' else 'SUBMITTED ' end || v_date);
  return jsonb_build_object('ok', true, 'updated', v_exists,
    'msg', case when v_exists then 'Report for ' else 'Report submitted for ' end || to_char(v_date, 'Mon FMDD, YYYY') ||
           case when v_exists then ' updated.' else '.' end ||
           ' Wastage: Abhayrab ' || round(a[1] - au, 2) || ' vial(s), Speeda ' || round(s[1] - su, 2) || ' vial(s).');
end $$;

-- ---------------------------------------------------------------- refrigerator temperature
create table public.fridge_locations (
  id        bigserial primary key,
  name      text not null unique,
  kind      text not null check (kind in ('HQ', 'Branch')),
  hq_code   text not null references public.hqs(code),
  branch_id uuid unique references public.branches(id) on delete cascade,
  ref_count int not null default 1 check (ref_count between 1 and 6),
  ref_names text[] not null default '{}',
  check ((kind = 'Branch') = (branch_id is not null))
);

create table public.temp_readings (
  id           bigserial primary key,
  location_id  bigint not null references public.fridge_locations(id) on delete cascade,
  reading_date date not null,
  logged_at    timestamptz not null default now(),
  session      text not null check (session in ('AM', 'PM', 'RECHECK')),
  ref_no       int not null check (ref_no between 1 and 6),
  temp         numeric(4, 1) not null check (temp between -40 and 60),
  min_temp     numeric(4, 1) check (min_temp between -40 and 60),
  max_temp     numeric(4, 1) check (max_temp between -40 and 60),
  status       text not null,
  action_taken text,
  recorded_by  text not null,
  remarks      text,
  account      text
);
create unique index temp_one_per_session on public.temp_readings (location_id, reading_date, session, ref_no) where session <> 'RECHECK';
create index on public.temp_readings (reading_date);

-- RNS: assigned branches (else branches of its HQs) · HQ: its HQ fridges + its branches · Branch: own · Admin: all
create or replace function public.can_see_fridge(p_loc bigint) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare l fridge_locations; t user_type := me_type();
begin
  select * into l from fridge_locations where id = p_loc;
  if l.id is null or t is null then return false; end if;
  if t = 'Admin' then return true; end if;
  if l.kind = 'Branch' then return can_see_branch(l.branch_id); end if;
  return t = 'HQ' and l.hq_code = any (my_hqs());
end $$;

create or replace function public.my_fridge() returns bigint
language sql stable security definer set search_path = public as $$
  select case me_type()
    when 'Branch' then (select id from fridge_locations where branch_id = my_branch())
    when 'HQ' then (select id from fridge_locations where kind = 'HQ' and hq_code = any (my_hqs()) order by id limit 1)
  end
$$;

alter table public.fridge_locations enable row level security;
alter table public.temp_readings enable row level security;
create policy fridge_read on public.fridge_locations for select to authenticated using (can_see_fridge(id));
create policy fridge_admin on public.fridge_locations for all to authenticated using (is_admin()) with check (is_admin());
create policy temp_read on public.temp_readings for select to authenticated using (can_see_fridge(location_id));

-- Branch / HQ logs a reading. The time comes from the server clock.
-- p: { ref, recheck, temp, min, max, recordedBy, action, remarks }
create or replace function public.temp_submit(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare l fridge_locations; st jsonb := setting('temperature'); v_min numeric := coalesce((st->>'min')::numeric, 2);
        v_max numeric := coalesce((st->>'max')::numeric, 8); v_am_end int := coalesce((st->>'amEnd')::int, 12);
        v_ref int; v_temp numeric; v_lo numeric; v_hi numeric; v_session text; v_status text; v_by text; v_action text;
        v_now timestamp := mnl_now(); v_prev temp_readings; v_maxref int;
begin
  perform require_type('Branch', 'HQ');
  select * into l from fridge_locations where id = my_fridge();
  if l.id is null then raise exception 'Your location is not set up for refrigerator monitoring. Ask the Supply Office.'; end if;
  v_maxref := case when l.kind = 'HQ' then 6 else l.ref_count end;
  begin v_ref := (p->>'ref')::int; exception when others then v_ref := null; end;
  if v_ref is null or v_ref < 1 or v_ref > v_maxref then
    raise exception '%', case when l.kind = 'HQ' then 'Choose refrigerator 1 to 6.' else 'Choose your refrigerator.' end;
  end if;
  begin
    v_temp := nullif(trim(coalesce(p->>'temp', '')), '')::numeric;
    v_lo := nullif(trim(coalesce(p->>'min', '')), '')::numeric;
    v_hi := nullif(trim(coalesce(p->>'max', '')), '')::numeric;
  exception when others then raise exception 'Temperatures must be numbers between -40 and 60 °C.'; end;
  if v_temp is null then raise exception 'Enter the temperature reading.'; end if;
  if v_temp not between -40 and 60 or coalesce(v_lo, 0) not between -40 and 60 or coalesce(v_hi, 0) not between -40 and 60 then
    raise exception 'Temperatures must be numbers between -40 and 60 °C.';
  end if;
  if v_lo is not null and v_hi is not null and v_lo > v_hi then raise exception 'Min cannot be higher than Max.'; end if;
  v_by := left(trim(coalesce(p->>'recordedBy', '')), 80);
  if v_by = '' then raise exception 'Enter who recorded the reading.'; end if;
  v_temp := round(v_temp, 1);
  v_status := case when v_temp between v_min and v_max then 'OK' else 'OUT OF RANGE' end;
  v_action := left(trim(coalesce(p->>'action', '')), 300);
  if v_status <> 'OK' and v_action = '' then
    raise exception '% °C is outside %–% °C. Write the action taken, then save and do a recheck.', v_temp, v_min, v_max;
  end if;
  v_session := case when coalesce((p->>'recheck')::boolean, false) then 'RECHECK'
                    when extract(hour from v_now) < v_am_end then 'AM' else 'PM' end;
  if v_session <> 'RECHECK' then
    select * into v_prev from temp_readings
     where location_id = l.id and reading_date = v_now::date and session = v_session and ref_no = v_ref;
    if v_prev.id is not null then
      raise exception 'The % reading for Ref % was already logged today at %. Use Recheck for another reading.',
        v_session, v_ref, to_char(v_prev.logged_at at time zone 'Asia/Manila', 'FMHH12:MI AM');
    end if;
  end if;
  insert into temp_readings (location_id, reading_date, session, ref_no, temp, min_temp, max_temp, status, action_taken, recorded_by, remarks, account)
  values (l.id, v_now::date, v_session, v_ref, v_temp, round(v_lo, 1), round(v_hi, 1), v_status, nullif(v_action, ''), v_by,
          nullif(left(trim(coalesce(p->>'remarks', '')), 300), ''), 'Portal · ' || (select username from app_users where id = auth.uid()));
  if l.kind = 'HQ' and v_ref > l.ref_count then update fridge_locations set ref_count = v_ref where id = l.id; end if;
  perform log_event('REF TEMP ' || v_session || ' Ref ' || v_ref || ' ' || v_temp || '°C ' || v_status);
  return jsonb_build_object('ok', true, 'status', v_status,
    'msg', case when v_session = 'RECHECK' then 'Recheck' else v_session || ' reading' end || ' saved for Ref ' || v_ref || ': ' ||
           v_temp || ' °C at ' || to_char(v_now, 'FMHH12:MI AM') || ' — ' ||
           case when v_status = 'OK' then 'within range.' else 'OUT OF RANGE. Please recheck after the action taken.' end);
end $$;
