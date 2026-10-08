-- =====================================================================
-- Purchase Requisition Slips (PRS)
-- Branch logs (Submitted) → RNS edits (Under Review) → Approve & send to HQ (Approved)
-- or Return for Correction → Branch fixes & resubmits (Submitted again).
-- HQ sees a PRS only once the RNS approved it.
-- =====================================================================
create type public.prs_status as enum
  ('Submitted', 'Under Review', 'Approved', 'Returned for Correction', 'Partially Served', 'Served', 'Cancelled');

create table public.prs (
  id             uuid primary key default gen_random_uuid(),
  control_no     text not null unique,
  prs_date       date not null,
  submitted_at   timestamptz not null default now(),
  branch_id      uuid not null references public.branches(id),
  hq_code        text not null references public.hqs(code),
  department     text,
  prepared_by    text,
  reviewed_by    text,
  approved_by    text,
  status         public.prs_status not null default 'Submitted',
  date_approved  timestamptz,
  date_served    date,
  dn_numbers     text[] not null default '{}',
  remarks        text,
  photo_path     text,
  rns_user_id    uuid references public.app_users(id) on delete set null,
  rns_action     text,
  sent_to_hq_at  timestamptz,
  rns_note       text,
  created_by     uuid references public.app_users(id) on delete set null,
  updated_at     timestamptz not null default now()
);
create index on public.prs (branch_id);
create index on public.prs (hq_code, status);

create table public.prs_items (
  id          bigserial primary key,
  prs_id      uuid not null references public.prs(id) on delete cascade,
  line_no     int not null,
  qty         numeric not null check (qty >= 0),
  unit        text,
  description text not null,
  remarks     text
);
create index on public.prs_items (prs_id);

create or replace function public.can_see_prs(p_branch uuid, p_status public.prs_status, p_sent timestamptz) returns boolean
language sql stable security definer set search_path = public as $$
  select can_see_branch(p_branch)
     and (me_type() <> 'HQ' or p_status in ('Approved', 'Partially Served', 'Served') or p_sent is not null)
$$;

alter table public.prs enable row level security;
alter table public.prs_items enable row level security;
create policy prs_read on public.prs for select to authenticated using (can_see_prs(branch_id, status, sent_to_hq_at));
create policy prs_items_read on public.prs_items for select to authenticated using (
  exists (select 1 from public.prs p where p.id = prs_id and can_see_prs(p.branch_id, p.status, p.sent_to_hq_at)));

-- list view: branch name, item count, days open
create or replace view public.prs_v with (security_invoker = true) as
  select p.*, b.name as branch_name, b.short_name as branch_short, h.name as hq_name,
         (select count(*) from public.prs_items i where i.prs_id = p.id)::int as item_count,
         case when p.status in ('Served', 'Cancelled') then null else (mnl_today() - p.prs_date) end as days_open
  from public.prs p join public.branches b on b.id = p.branch_id join public.hqs h on h.code = p.hq_code;

-- ---------------------------------------------------------------- items helper
create or replace function public.prs_clean_items(p_items jsonb) returns jsonb
language plpgsql immutable as $$
declare it jsonb; out jsonb := '[]'; q text; d text;
begin
  for it in select * from jsonb_array_elements(coalesce(p_items, '[]')) loop
    q := trim(coalesce(it->>'qty', ''));
    d := trim(coalesce(it->>'desc', it->>'description', ''));
    if q = '' and d = '' then continue; end if;
    if d = '' then raise exception 'Every item needs a description.'; end if;
    if q !~ '^\d+(\.\d+)?$' or q::numeric <= 0 then
      raise exception 'Every item needs a quantity greater than 0 (%).', d;
    end if;
    out := out || jsonb_build_object('qty', q::numeric, 'unit', left(trim(coalesce(it->>'unit', '')), 30),
                                     'desc', left(d, 200), 'remarks', left(trim(coalesce(it->>'remarks', '')), 200));
  end loop;
  return out;
end $$;

create or replace function public.prs_write_items(p_id uuid, p_items jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare n int := 0; it jsonb;
begin
  delete from prs_items where prs_id = p_id;
  for it in select * from jsonb_array_elements(p_items) loop
    n := n + 1;
    insert into prs_items (prs_id, line_no, qty, unit, description, remarks)
    values (p_id, n, (it->>'qty')::numeric, it->>'unit', it->>'desc', nullif(it->>'remarks', ''));
  end loop;
  return n;
end $$;

create or replace function public.prs_items_html(p_id uuid) returns text
language sql stable security definer set search_path = public as $$
  select '<table cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-family:Arial;font-size:13px">' ||
         '<tr style="background:#1E3A8A;color:#fff"><th>#</th><th>Qty</th><th>Unit</th><th align="left">Description</th><th align="left">Remarks</th></tr>' ||
         coalesce(string_agg('<tr style="border-bottom:1px solid #ddd"><td>' || line_no || '</td><td align="center">' || qty ||
           '</td><td>' || esc(unit) || '</td><td>' || esc(description) || '</td><td>' || esc(remarks) || '</td></tr>', '' order by line_no), '') ||
         '</table>'
  from prs_items where prs_id = p_id
$$;

-- ---------------------------------------------------------------- Branch logs a new PRS
-- p: { prsDate, department, preparedBy, remarks, items:[{qty, unit, desc, remarks}] }
create or replace function public.prs_create(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_b branches; v_items jsonb; v_no text; v_id uuid; v_date date; v_code text; v_rns app_users;
begin
  perform require_type('Branch');
  select * into v_b from branches where id = my_branch();
  if v_b.id is null then raise exception 'Your account is not linked to a branch. Ask the Supply Office.'; end if;
  v_date := coalesce(nullif(p->>'prsDate', '')::date, mnl_today());
  if v_date > mnl_today() then raise exception 'The PRS date cannot be in the future.'; end if;
  if trim(coalesce(p->>'preparedBy', '')) = '' then raise exception 'Enter who prepared the PRS.'; end if;
  v_items := prs_clean_items(p->'items');
  if jsonb_array_length(v_items) = 0 then raise exception 'Add at least one item.'; end if;

  v_code := coalesce(nullif(v_b.code, ''), left(regexp_replace(upper(v_b.short_name), '[^A-Z]', '', 'g'), 3));
  v_no := v_code || '-' || lpad(next_seq('PRS ' || v_code, extract(year from v_date)::int)::text, 3, '0') || '-' || extract(year from v_date);

  insert into prs (control_no, prs_date, branch_id, hq_code, department, prepared_by, remarks, rns_user_id, created_by, photo_path)
  values (v_no, v_date, v_b.id, v_b.hq_code, left(trim(coalesce(p->>'department', '')), 80),
          left(trim(p->>'preparedBy'), 80), left(trim(coalesce(p->>'remarks', '')), 500), v_b.rns_user_id, auth.uid(),
          case when coalesce(p->>'photoPath', '') like v_b.id::text || '/%' then p->>'photoPath' end)
  returning id into v_id;
  perform prs_write_items(v_id, v_items);

  select * into v_rns from app_users where id = v_b.rns_user_id;
  if v_rns.email is not null then
    perform queue_email(array[v_rns.email], '{}', 'New PRS for your review — ' || v_b.name,
      mail_wrap('New PRS for your review',
        '<p><b>' || esc(v_no) || '</b> from <b>' || esc(v_b.name) || '</b> · ' || jsonb_array_length(v_items) ||
        ' item(s) · prepared by ' || esc(p->>'preparedBy') || '</p>' || prs_items_html(v_id)));
  end if;
  perform log_event('PRS ' || v_no || ' → SUBMITTED');
  return jsonb_build_object('ok', true, 'id', v_id, 'no', v_no, 'msg', 'PRS ' || v_no || ' submitted to your RNS for review.');
end $$;

-- ---------------------------------------------------------------- RNS review
-- p_action: save (Under Review) · approve (Approved + sent to HQ + email) · return (Returned for Correction)
-- p: { dept, remarks, note, items:[...] }
create or replace function public.prs_review(p_id uuid, p_action text, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r prs; v_items jsonb; v_note text := trim(coalesce(p->>'note', '')); v_me text; v_stamp text; v_b branches; v_to text;
begin
  perform require_type('RNS', 'Admin');
  if p_action not in ('save', 'approve', 'return') then raise exception 'Unknown action.'; end if;
  select * into r from prs where id = p_id for update;
  if r.id is null then raise exception 'PRS not found.'; end if;
  if not can_see_branch(r.branch_id) then raise exception 'This PRS is not assigned to you.'; end if;
  if r.status not in ('Submitted', 'Under Review', 'Returned for Correction') then
    raise exception 'This PRS is already % and can no longer be edited.', r.status;
  end if;
  v_items := prs_clean_items(p->'items');
  if p_action = 'approve' and jsonb_array_length(v_items) = 0 then raise exception 'Add at least one item before approving.'; end if;
  if p_action = 'return' and v_note = '' then raise exception 'Write a note telling the branch what to correct.'; end if;

  perform prs_write_items(p_id, v_items);
  select display_name into v_me from app_users where id = auth.uid();
  v_stamp := to_char(mnl_now(), 'Mon FMDD, YYYY FMHH12:MI AM');
  update prs set department = coalesce(nullif(trim(p->>'dept'), ''), department),
                 remarks = case when p ? 'remarks' then left(trim(p->>'remarks'), 500) else remarks end,
                 reviewed_by = v_me, rns_user_id = coalesce(rns_user_id, auth.uid()), updated_at = now()
   where id = p_id;

  if p_action = 'approve' then
    update prs set status = 'Approved', approved_by = v_me, date_approved = now(), sent_to_hq_at = now(),
                   rns_action = 'Approved by ' || v_me || ' · ' || v_stamp, rns_note = v_note
     where id = p_id;
    select * into v_b from branches where id = r.branch_id;
    v_to := hq_email(r.hq_code);
    if v_to is not null then
      perform queue_email(array[v_to], array[director_email()],
        'PRS ' || r.control_no || ' approved by RNS — ' || v_b.name || ' (for ' || r.hq_code || ')',
        mail_wrap('RB ABC Supply Office — PRS approved by RNS',
          '<p><b>' || esc(r.control_no) || '</b> from <b>' || esc(v_b.name) || '</b> was approved by <b>' || esc(v_me) ||
          '</b> and sent to <b>' || esc(r.hq_code) || '</b> for serving.</p>' ||
          '<p>PRS date: ' || to_char(r.prs_date, 'Mon FMDD, YYYY') || ' · Department: ' || esc(r.department) ||
          ' · Prepared by: ' || esc(r.prepared_by) || '</p>' || prs_items_html(p_id) ||
          case when v_note <> '' then '<p><b>Note from RNS:</b> ' || esc(v_note) || '</p>' else '' end));
    end if;
    perform log_event('PRS ' || r.control_no || ' → APPROVED');
    return jsonb_build_object('ok', true, 'status', 'Approved',
      'msg', 'PRS ' || r.control_no || ' approved and sent to ' || r.hq_code ||
             case when v_to is null then '. No HQ email is set, so no email was sent.' else ' (emailed ' || v_to || ').' end);
  elsif p_action = 'return' then
    update prs set status = 'Returned for Correction', rns_action = 'Returned by ' || v_me || ' · ' || v_stamp, rns_note = v_note
     where id = p_id;
    perform log_event('PRS ' || r.control_no || ' → RETURNED');
    return jsonb_build_object('ok', true, 'status', 'Returned for Correction', 'msg', 'PRS ' || r.control_no || ' returned to the branch with your note.');
  else
    update prs set status = 'Under Review', rns_action = 'Edited by ' || v_me || ' · ' || v_stamp,
                   rns_note = case when v_note <> '' then v_note else rns_note end
     where id = p_id;
    return jsonb_build_object('ok', true, 'status', 'Under Review', 'msg', 'Changes saved. PRS ' || r.control_no || ' is now Under Review.');
  end if;
end $$;

-- ---------------------------------------------------------------- Branch fixes a returned PRS
-- p: { dept, remarks, reply, items }
create or replace function public.prs_resubmit(p_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r prs; v_items jsonb; v_reply text := trim(coalesce(p->>'reply', '')); v_me text; v_rns app_users;
begin
  perform require_type('Branch');
  select * into r from prs where id = p_id for update;
  if r.id is null or r.branch_id <> my_branch() then raise exception 'This PRS belongs to another branch.'; end if;
  if r.status <> 'Returned for Correction' then raise exception 'This PRS is % — only returned PRS can be resubmitted.', r.status; end if;
  v_items := prs_clean_items(p->'items');
  if jsonb_array_length(v_items) = 0 then raise exception 'Add at least one item before resubmitting.'; end if;
  if v_reply = '' then raise exception 'Tell your RNS what you corrected.'; end if;
  perform prs_write_items(p_id, v_items);
  select display_name into v_me from app_users where id = auth.uid();
  update prs set department = coalesce(nullif(trim(p->>'dept'), ''), department),
                 remarks = case when p ? 'remarks' then left(trim(p->>'remarks'), 500) else remarks end,
                 rns_action = 'Resubmitted by ' || v_me || ' · ' || to_char(mnl_now(), 'Mon FMDD, YYYY FMHH12:MI AM') || ' — ' || left(v_reply, 300),
                 status = 'Submitted', updated_at = now()
   where id = p_id;
  select * into v_rns from app_users where id = r.rns_user_id;
  if v_rns.email is not null then
    perform queue_email(array[v_rns.email], '{}', 'PRS ' || r.control_no || ' resubmitted for your review',
      mail_wrap('PRS resubmitted after correction',
        '<p><b>' || esc(r.control_no) || '</b> was corrected and resubmitted.</p><p style="color:#C62828"><b>Branch reply:</b> ' ||
        esc(v_reply) || '</p>' || prs_items_html(p_id)));
  end if;
  perform log_event('PRS ' || r.control_no || ' → RESUBMITTED');
  return jsonb_build_object('ok', true, 'status', 'Submitted', 'msg', 'PRS ' || r.control_no || ' resubmitted to your RNS for review.');
end $$;
