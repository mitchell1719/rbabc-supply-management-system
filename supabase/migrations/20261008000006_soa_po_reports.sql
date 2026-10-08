-- =====================================================================
-- Statement of Account (HQ prepares · Admin approves · Finance processes),
-- Purchase Orders (Admin → Finance), Monday Report, Ordered items,
-- Admin report data and data export.
-- =====================================================================

-- ---------------------------------------------------------------- DSM / Branch Manager groups
create table public.dsm_groups (
  key           text primary key,
  role          text not null default 'District Sales Manager',
  manager_name  text,
  manager_email text,
  oic           text,
  oic_email     text,
  rns_name      text,
  area          text,
  phone         text,
  branch_ids    uuid[] not null default '{}',
  active        boolean not null default true
);

create or replace function public.dsm_label(g public.dsm_groups) returns text
language sql immutable as $$
  select case when g.role ilike '%branch%' then 'BM' else 'DSM' end ||
         coalesce(' ' || nullif(g.manager_name, ''), '') ||
         case when coalesce(g.oic, '') <> '' then case when coalesce(g.manager_name, '') <> '' then ' · ' else ' — ' end || 'OIC ' || g.oic else '' end
$$;

-- ---------------------------------------------------------------- SOA
create table public.soas (
  id           uuid primary key default gen_random_uuid(),
  soa_no       text not null unique,
  soa_date     date not null default mnl_today(),
  hq_code      text not null references public.hqs(code),
  dsm_key      text not null references public.dsm_groups(key),
  dsm_label    text,
  dsm_name     text,
  area         text,
  period_from  date,
  period_to    date,
  prs_count    int not null default 0,
  dn_count     int not null default 0,
  total        numeric(14, 2) not null default 0,
  status       text not null default 'Draft' check (status in ('Draft', 'For Approval', 'Returned to HQ', 'Sent to Finance',
                 'Received by Finance', 'Returned by Finance', 'Processed by Finance', 'Cancelled')),
  prepared_by  text,
  prepared_user uuid references public.app_users(id) on delete set null,
  prepared_at  timestamptz not null default now(),
  submitted_at timestamptz,
  approved_by  text,
  approved_at  timestamptz,
  admin_note   text,
  finance_by   text,
  finance_at   timestamptz,
  finance_ref  text,
  finance_note text,
  hq_note      text,
  view_key     text not null default replace(gen_random_uuid()::text, '-', ''),
  dsm_sent_at  timestamptz,
  history      jsonb not null default '[]',
  updated_at   timestamptz not null default now()
);

create table public.soa_lines (
  id          bigserial primary key,
  soa_id      uuid not null references public.soas(id) on delete cascade,
  line_no     int not null,
  dn_id       uuid not null references public.delivery_notes(id),
  dn_item_id  bigint references public.dn_items(id) on delete set null,
  dn_no       text, prs_no text, prs_date date, branch text, dn_date date, rr_no text,
  qty         numeric not null,
  unit        text,
  description text,
  batch       text,
  unit_cost   numeric(12, 2) not null default 0,
  total_cost  numeric(14, 2) not null default 0,
  cost_source text
);
create index on public.soa_lines (soa_id);
create index on public.soa_lines (dn_id);

create table public.soa_attachments (
  id         bigserial primary key,
  soa_id     uuid not null references public.soas(id) on delete cascade,
  path       text not null,           -- storage: soa/<soa id>/<file>
  name       text not null,
  mime       text,
  size       bigint,
  label      text,
  added_by   text,
  added_at   timestamptz not null default now()
);

create or replace function public.can_see_soa(p_hq text, p_status text, p_approved timestamptz) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare t user_type := me_type();
begin
  if t = 'Admin' then return true; end if;
  if t = 'HQ' then return p_hq = any (my_hqs()); end if;
  if t = 'Finance' then
    return p_status in ('Sent to Finance', 'Received by Finance', 'Returned by Finance', 'Processed by Finance')
        or (p_status = 'Cancelled' and p_approved is not null);
  end if;
  return false;
end $$;

alter table public.dsm_groups enable row level security;
alter table public.soas enable row level security;
alter table public.soa_lines enable row level security;
alter table public.soa_attachments enable row level security;
create policy dsm_read on public.dsm_groups for select to authenticated using (me_type() in ('HQ', 'Admin', 'Finance'));
create policy dsm_admin on public.dsm_groups for all to authenticated using (is_admin()) with check (is_admin());
create policy soa_read on public.soas for select to authenticated using (can_see_soa(hq_code, status, approved_at));
create policy soa_lines_read on public.soa_lines for select to authenticated using (
  exists (select 1 from public.soas s where s.id = soa_id and can_see_soa(s.hq_code, s.status, s.approved_at)));
create policy soa_att_read on public.soa_attachments for select to authenticated using (
  exists (select 1 from public.soas s where s.id = soa_id and can_see_soa(s.hq_code, s.status, s.approved_at)));

-- Unit cost: HQ "Price per Unit" → latest CW purchase order of the batch → CW product cost
create or replace function public.soa_cost(p_batch text, p_desc text, p_hq text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_sku text; v numeric; v_po purchase_order_lines;
begin
  select sku into v_sku from batches where batch_no = upper(coalesce(p_batch, ''));
  if v_sku is null then select sku into v_sku from products where item_key(name) = item_key(p_desc) limit 1; end if;
  if v_sku is not null then
    select price into v from hq_prices where hq_code = p_hq and sku = v_sku;
    if v > 0 then return jsonb_build_object('cost', v, 'src', 'HQ price per unit (' || (select name from hqs where code = p_hq) || ')'); end if;
  end if;
  select * into v_po from purchase_order_lines where batch_no = upper(coalesce(p_batch, '')) and unit_cost > 0 order by id desc limit 1;
  if v_po.id is not null then return jsonb_build_object('cost', v_po.unit_cost, 'src', 'PO ' || coalesce(nullif(v_po.po_no, ''), '#' || v_po.id) || ' (batch ' || v_po.batch_no || ')'); end if;
  if v_sku is not null then
    select unit_cost into v from products where sku = v_sku;
    if v > 0 then return jsonb_build_object('cost', v, 'src', 'CW product list'); end if;
  end if;
  return jsonb_build_object('cost', 0, 'src', '');
end $$;

create or replace function public.soa_dn_lines(p_dn uuid, p_hq text) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'line', i.line_no, 'itemId', i.id,
           'qty', case when coalesce(i.condition, '') in ('', 'Good', 'Short') then greatest(coalesce(i.r_qty, i.qty), 0) else 0 end,
           'sent', i.qty, 'unit', i.unit, 'desc', i.description, 'batch', coalesce(i.r_batch, i.batch_no),
           'condition', coalesce(i.condition, 'Good'),
           'excluded', not (coalesce(i.condition, '') in ('', 'Good', 'Short')) or coalesce(i.r_qty, i.qty) <= 0)
         || soa_cost(coalesce(i.r_batch, i.batch_no), i.description, p_hq) order by i.line_no), '[]')
  from dn_items i where i.dn_id = p_dn
$$;

-- HQ: validated deliveries of one DSM group's branches that are not on an SOA yet
create or replace function public.soa_candidates(p_dsm text, p_from date, p_to date, p_editing uuid default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g dsm_groups; v_hqs text[] := my_hqs();
begin
  perform require_type('HQ');
  select * into g from dsm_groups where key = upper(p_dsm) and active;
  if g.key is null then raise exception 'Choose a District Sales Manager.'; end if;
  return (
    with dn as (
      select d.*, b.name as branch_name,
             (select s.soa_no from soa_lines l join soas s on s.id = l.soa_id
               where l.dn_id = d.id and s.status <> 'Cancelled' and s.id is distinct from p_editing limit 1) as billed
      from delivery_notes d join branches b on b.id = d.branch_id
      where d.hq_code = any (v_hqs) and d.branch_id = any (g.branch_ids)
        and (p_from is null or d.delivery_date >= p_from) and (p_to is null or d.delivery_date <= p_to))
    select jsonb_build_object(
      'dsm', jsonb_build_object('key', g.key, 'label', dsm_label(g), 'area', g.area,
             'branches', (select coalesce(jsonb_agg(name order by name), '[]') from branches where id = any (g.branch_ids))),
      'ready', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'no', dn_no, 'date', delivery_date, 'branch', branch_name,
                  'prs', prs_no, 'prsDate', prs_date, 'rr', rr_no, 'rDate', received_date, 'validatedBy', validated_by,
                  'discrepancy', discrepancy, 'lines', soa_dn_lines(id, hq_code)) order by delivery_date, dn_no), '[]')
                from dn where billed is null and status = 'Validated'),
      'waiting', (select coalesce(jsonb_agg(jsonb_build_object('no', dn_no, 'branch', branch_name, 'status', status) order by dn_no), '[]')
                  from dn where billed is null and status not in ('Validated', 'Prepared')),
      'onSoa', (select coalesce(jsonb_agg(jsonb_build_object('no', dn_no, 'branch', branch_name, 'soa', billed) order by dn_no), '[]')
                from dn where billed is not null)));
end $$;

create or replace function public.soa_hist(p_hist jsonb, p_action text, p_note text) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(p_hist, '[]') || jsonb_build_array(jsonb_build_object(
    'at', to_char(mnl_now(), 'Mon FMDD, YYYY FMHH12:MI AM'), 'by', my_name(), 'action', p_action, 'note', left(coalesce(p_note, ''), 400)))
$$;

-- HQ saves an SOA (new / Draft / Returned). p_submit = true sends it to the Admin.
-- p: { id?, dsmKey, from, to, note, dns:[{ id, costs:{ "<line>": unitCost } }] }
create or replace function public.soa_save(p jsonb, p_submit boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g dsm_groups; s soas; v_hq text := (my_hqs())[1]; pk jsonb; d delivery_notes; v_b branches; ln jsonb; v_cost numeric; raw text;
        v_lines jsonb := '[]'; v_missing int := 0; v_total numeric := 0; v_prs text[] := '{}'; v_n int := 0; v_dncount int := 0; xl jsonb;
        v_from date := nullif(p->>'from', '')::date; v_to date := nullif(p->>'to', '')::date;
begin
  perform require_type('HQ');
  select * into g from dsm_groups where key = upper(coalesce(p->>'dsmKey', '')) and active;
  if g.key is null then raise exception 'Choose a District Sales Manager.'; end if;
  if jsonb_array_length(coalesce(p->'dns', '[]')) = 0 then raise exception 'Tick at least one validated delivery to put on the SOA.'; end if;
  if nullif(p->>'id', '') is not null then
    select * into s from soas where id = (p->>'id')::uuid for update;
    if s.id is null then raise exception 'SOA not found.'; end if;
    if not (s.hq_code = any (my_hqs())) then raise exception 'This SOA belongs to another HQ.'; end if;
    if s.status not in ('Draft', 'Returned to HQ', 'Returned by Finance') then raise exception 'SOA % is % and can no longer be changed.', s.soa_no, s.status; end if;
  end if;
  for pk in select * from jsonb_array_elements(p->'dns') loop
    select * into d from delivery_notes where id = (pk->>'id')::uuid;
    if d.id is null or not (d.hq_code = any (my_hqs())) then raise exception 'Please refresh the list: a delivery note was not found.'; end if;
    if d.status <> 'Validated' then raise exception 'Please refresh the list: % is not validated yet.', d.dn_no; end if;
    if not (d.branch_id = any (g.branch_ids)) then raise exception 'Please refresh the list: % is not under %.', d.dn_no, dsm_label(g); end if;
    if exists (select 1 from soa_lines l join soas o on o.id = l.soa_id where l.dn_id = d.id and o.status <> 'Cancelled' and o.id is distinct from s.id) then
      raise exception 'Please refresh the list: % is already on another SOA.', d.dn_no;
    end if;
    select * into v_b from branches where id = d.branch_id;
    v_dncount := v_dncount + 1;
    for ln in select * from jsonb_array_elements(soa_dn_lines(d.id, d.hq_code)) loop
      if (ln->>'excluded')::boolean then continue; end if;
      raw := pk->'costs'->>(ln->>'line');
      v_cost := case when raw is null or trim(raw) = '' then (ln->>'cost')::numeric else round(raw::numeric, 2) end;
      if v_cost < 0 then v_cost := 0; end if;
      if v_cost <= 0 then v_missing := v_missing + 1; end if;
      if d.prs_no is not null and not (d.prs_no = any (v_prs)) then v_prs := v_prs || d.prs_no; end if;
      v_lines := v_lines || jsonb_build_object('dn', d.id, 'item', (ln->>'itemId')::bigint, 'dnNo', d.dn_no, 'prs', d.prs_no, 'prsDate', d.prs_date,
        'branch', v_b.name, 'dnDate', d.delivery_date, 'rr', d.rr_no, 'qty', (ln->>'qty')::numeric, 'unit', ln->>'unit', 'desc', ln->>'desc',
        'batch', ln->>'batch', 'cost', v_cost, 'total', round((ln->>'qty')::numeric * v_cost, 2),
        'src', case when raw is null or trim(raw) = '' or round(raw::numeric, 2) = (ln->>'cost')::numeric then ln->>'src' else 'Entered by HQ' end);
      v_total := v_total + round((ln->>'qty')::numeric * v_cost, 2);
    end loop;
  end loop;
  if jsonb_array_length(v_lines) = 0 then raise exception 'The ticked deliveries have no received items to bill.'; end if;
  if p_submit and v_missing > 0 then raise exception 'Enter the unit cost of every item before submitting (% missing).', v_missing; end if;

  if s.id is null then
    insert into soas (soa_no, hq_code, dsm_key, prepared_user, prepared_by, history)
    values (next_doc_no('SOA ' || v_hq), v_hq, g.key, auth.uid(), my_name(), '[]') returning * into s;
  end if;
  update soas set soa_date = mnl_today(), dsm_key = g.key, dsm_label = dsm_label(g),
         dsm_name = concat_ws(' · ', nullif(g.manager_name, ''), 'OIC ' || nullif(g.oic, '')), area = g.area,
         period_from = coalesce(v_from, (select min((x->>'dnDate')::date) from jsonb_array_elements(v_lines) e(x))),
         period_to = coalesce(v_to, (select max((x->>'dnDate')::date) from jsonb_array_elements(v_lines) e(x))),
         prs_count = cardinality(v_prs), dn_count = v_dncount, total = v_total,
         status = case when p_submit then 'For Approval' when status in ('Returned to HQ', 'Returned by Finance') then status else 'Draft' end,
         prepared_by = my_name(), prepared_user = auth.uid(), submitted_at = case when p_submit then now() else submitted_at end,
         hq_note = nullif(left(trim(coalesce(p->>'note', '')), 500), ''),
         history = soa_hist(history, case when p_submit then 'Submitted for approval' else 'Saved' end, p->>'note'), updated_at = now()
   where id = s.id returning * into s;
  delete from soa_lines where soa_id = s.id;
  v_n := 0;
  for xl in select * from jsonb_array_elements(v_lines) loop
    v_n := v_n + 1;
    insert into soa_lines (soa_id, line_no, dn_id, dn_item_id, dn_no, prs_no, prs_date, branch, dn_date, rr_no, qty, unit, description, batch, unit_cost, total_cost, cost_source)
    values (s.id, v_n, (xl->>'dn')::uuid, (xl->>'item')::bigint, xl->>'dnNo', xl->>'prs', nullif(xl->>'prsDate', '')::date, xl->>'branch',
            (xl->>'dnDate')::date, xl->>'rr', (xl->>'qty')::numeric, xl->>'unit', xl->>'desc', xl->>'batch', (xl->>'cost')::numeric, (xl->>'total')::numeric, xl->>'src');
  end loop;
  if p_submit then
    perform queue_email(admin_emails(), '{}', 'SOA for approval: ' || s.soa_no || ' · ' || s.dsm_label || ' · ₱' || to_char(s.total, 'FM999,999,990.00'),
      mail_wrap('SOA for approval', '<p>' || esc(s.prepared_by) || ' (' || esc(s.hq_code) || ') submitted <b>' || esc(s.soa_no) ||
        '</b> for ' || esc(s.dsm_label) || ' — total <b>₱' || to_char(s.total, 'FM999,999,990.00') || '</b>.</p>' ||
        coalesce('<p>Note: ' || esc(s.hq_note) || '</p>', '')));
  end if;
  perform log_event(case when p_submit then 'SOA SUBMITTED ' else 'SOA SAVED ' end || s.soa_no);
  return jsonb_build_object('ok', true, 'id', s.id, 'no', s.soa_no, 'msg',
    s.soa_no || case when p_submit then ' sent to the Admin for approval' else ' saved as ' || lower(s.status) end ||
    ' (₱' || to_char(s.total, 'FM999,999,990.00') || ').');
end $$;

create or replace function public.soa_rns_emails(p_soa uuid) returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct u.email), '{}') from soa_lines l join delivery_notes d on d.id = l.dn_id
    join branches b on b.id = d.branch_id join app_users u on u.id = b.rns_user_id
  where l.soa_id = p_soa and u.email is not null
$$;

-- cancel (HQ) · approve / return (Admin) · receive / process / return (Finance)
create or replace function public.soa_action(p_id uuid, p_action text, p_note text default '', p_ref text default '') returns jsonb
language plpgsql security definer set search_path = public as $$
declare s soas; t user_type := require_type('HQ', 'Admin', 'Finance'); g dsm_groups; v_note text := left(trim(coalesce(p_note, '')), 500);
        v_ref text := left(trim(coalesce(p_ref, '')), 120); v_msg text; v_label text; v_link text; v_tbl text; v_dsm_to text[];
begin
  select * into s from soas where id = p_id for update;
  if s.id is null or not can_see_soa(s.hq_code, s.status, s.approved_at) then raise exception 'SOA not found.'; end if;
  v_link := case when setting_text('portal_url') <> '' then setting_text('portal_url') || '/soa-view?soa=' || s.soa_no || '&k=' || s.view_key end;
  v_tbl := '<table cellpadding="5" cellspacing="0" style="border-collapse:collapse;font-family:Arial;font-size:12px"><tr style="background:#1E3A8A;color:#fff">' ||
           '<th align="left">SOA No.</th><th align="left">DSM / DM</th><th align="left">HQ</th><th align="left">Period</th><th>PRS</th><th>DN</th><th align="right">Total</th></tr>' ||
           '<tr><td>' || esc(s.soa_no) || '</td><td>' || esc(s.dsm_label) || '</td><td>' || esc(s.hq_code) || '</td><td>' || coalesce(s.period_from::text, '') ||
           ' to ' || coalesce(s.period_to::text, '') || '</td><td align="center">' || s.prs_count || '</td><td align="center">' || s.dn_count ||
           '</td><td align="right"><b>₱' || to_char(s.total, 'FM999,999,990.00') || '</b></td></tr></table>';

  if p_action = 'cancel' then
    if not (t = 'HQ' and s.status in ('Draft', 'Returned to HQ', 'Returned by Finance')) then raise exception 'Only a draft or returned SOA can be cancelled by the HQ.'; end if;
    update soas set status = 'Cancelled' where id = s.id;
    v_msg := s.soa_no || ' cancelled. Its deliveries can be put on a new SOA.'; v_label := 'Cancelled';
  elsif p_action = 'approve' then
    if not (t = 'Admin' and s.status = 'For Approval') then raise exception 'Only an SOA waiting for approval can be approved by the Admin.'; end if;
    update soas set status = 'Sent to Finance', approved_by = my_name(), approved_at = now(), admin_note = nullif(v_note, '') where id = s.id;
    perform queue_email(finance_emails(), array[hq_email(s.hq_code)] || admin_emails(),
      'Statement of Account ' || s.soa_no || ' · ' || s.dsm_label || ' · ₱' || to_char(s.total, 'FM999,999,990.00'),
      mail_wrap('Statement of Account for payment processing',
        '<p>Good day, Finance Department.</p><p>The Supply Office approved <b>' || esc(s.soa_no) || '</b>. Open it in the portal to print or save it as PDF.</p>' ||
        v_tbl || case when v_note <> '' then '<p>Note from the Supply Office: ' || esc(v_note) || '</p>' else '' end ||
        case when v_link is not null then '<p>Delivery notes and receiving reports (view only): <a href="' || esc(v_link) || '">' || esc(s.soa_no) || ' — DN &amp; RR</a></p>' else '' end));
    select * into g from dsm_groups where key = s.dsm_key;
    v_dsm_to := array_remove(array[nullif(g.manager_email, ''), nullif(g.oic_email, '')], null);
    if cardinality(v_dsm_to) > 0 then
      perform queue_email(v_dsm_to, soa_rns_emails(s.id),
        'Statement of Account ' || s.soa_no || ' · ' || s.dsm_label || ' · ₱' || to_char(s.total, 'FM999,999,990.00'),
        mail_wrap('Statement of Account ' || s.soa_no,
          '<p>Good day, ' || esc(coalesce(nullif(g.manager_name, ''), g.oic, '')) || '.</p><p>The Statement of Account for your branches was approved and sent to the Finance Department.</p>' ||
          v_tbl || case when v_link is not null then '<p>View the delivery notes and receiving reports here (view only): <a href="' || esc(v_link) || '">' || esc(s.soa_no) || ' — DN &amp; RR</a></p>' else '' end));
      update soas set dsm_sent_at = now() where id = s.id;
    end if;
    v_msg := s.soa_no || ' approved and sent to Finance' ||
             case when cardinality(v_dsm_to) > 0 then ' and to ' || s.dsm_label || ' (RNS copied).' else '. No DSM / OIC email is set for this group.' end;
    v_label := 'Approved — sent to Finance';
  elsif p_action = 'return' then
    if v_note = '' then raise exception 'Write the reason for returning it.'; end if;
    if t = 'Admin' and s.status = 'For Approval' then
      update soas set status = 'Returned to HQ', admin_note = v_note where id = s.id;
      perform queue_email(array[hq_email(s.hq_code)], '{}', 'SOA returned: ' || s.soa_no,
        mail_wrap('SOA returned for correction', v_tbl || '<p><b>Note:</b> ' || esc(v_note) || '</p>'));
      v_msg := s.soa_no || ' returned to ' || s.hq_code || '.'; v_label := 'Returned to HQ';
    elsif t = 'Finance' and s.status in ('Sent to Finance', 'Received by Finance') then
      update soas set status = 'Returned by Finance', finance_by = my_name(), finance_at = now(), finance_note = v_note where id = s.id;
      perform queue_email(admin_emails(), array[hq_email(s.hq_code)], 'Finance returned SOA ' || s.soa_no,
        mail_wrap('Finance returned an SOA', v_tbl || '<p><b>Note:</b> ' || esc(v_note) || '</p>'));
      v_msg := s.soa_no || ' returned to the Supply Office for clarification.'; v_label := 'Returned by Finance';
    else raise exception 'This SOA cannot be returned now.'; end if;
  elsif p_action = 'receive' then
    if not (t = 'Finance' and s.status = 'Sent to Finance') then raise exception 'Only a newly sent SOA can be marked received.'; end if;
    update soas set status = 'Received by Finance', finance_by = my_name(), finance_at = now(),
           finance_note = coalesce(nullif(v_note, ''), finance_note) where id = s.id;
    v_msg := s.soa_no || ' marked received by Finance.'; v_label := 'Received by Finance';
  elsif p_action = 'process' then
    if not (t = 'Finance' and s.status in ('Sent to Finance', 'Received by Finance')) then raise exception 'Only an SOA sent to Finance can be processed.'; end if;
    if v_ref = '' then raise exception 'Enter the voucher / reference no. of the payment processing.'; end if;
    update soas set status = 'Processed by Finance', finance_by = my_name(), finance_at = now(), finance_ref = v_ref,
           finance_note = coalesce(nullif(v_note, ''), finance_note) where id = s.id;
    perform queue_email(admin_emails(), array[hq_email(s.hq_code)], 'SOA processed: ' || s.soa_no || ' (ref. ' || v_ref || ')',
      mail_wrap('SOA processed by Finance', v_tbl || '<p>Reference: <b>' || esc(v_ref) || '</b></p>'));
    v_msg := s.soa_no || ' processed by Finance (ref. ' || v_ref || ').'; v_label := 'Processed by Finance (ref. ' || v_ref || ')';
  else
    raise exception 'Unknown action.';
  end if;
  update soas set history = soa_hist(history, v_label, v_note), updated_at = now() where id = s.id;
  perform log_event('SOA ' || upper(p_action) || ' ' || s.soa_no);
  return jsonb_build_object('ok', true, 'msg', v_msg);
end $$;

-- Attachments are uploaded to storage by the client; this records / removes them
create or replace function public.soa_attach(p_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s soas; t user_type := require_type('HQ', 'Admin');
begin
  select * into s from soas where id = p_id;
  if s.id is null or not can_see_soa(s.hq_code, s.status, s.approved_at) then raise exception 'SOA not found.'; end if;
  if t = 'HQ' and s.status not in ('Draft', 'Returned to HQ', 'Returned by Finance') then
    raise exception 'Files can be added while the SOA is a draft or returned.';
  end if;
  if coalesce(p->>'path', '') not like s.id::text || '/%' then raise exception 'File not found.'; end if;
  insert into soa_attachments (soa_id, path, name, mime, size, label, added_by)
  values (s.id, p->>'path', left(coalesce(p->>'name', 'file'), 120), left(p->>'mime', 100), (p->>'size')::bigint,
          left(coalesce(p->>'label', 'Supplier invoice'), 60), my_name());
  return jsonb_build_object('ok', true, 'msg', coalesce(p->>'name', 'File') || ' attached to ' || s.soa_no || '.');
end $$;

create or replace function public.soa_detach(p_att bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a soa_attachments; s soas; t user_type := require_type('HQ', 'Admin');
begin
  select * into a from soa_attachments where id = p_att;
  select * into s from soas where id = a.soa_id;
  if a.id is null or not can_see_soa(s.hq_code, s.status, s.approved_at)
     or (t = 'HQ' and s.status not in ('Draft', 'Returned to HQ', 'Returned by Finance')) then
    raise exception 'This file can no longer be removed.';
  end if;
  delete from soa_attachments where id = a.id;
  return jsonb_build_object('ok', true, 'path', a.path, 'msg', 'File removed.');
end $$;

-- View-only page of the DN & RR of an approved SOA (link e-mailed to the DSM / OIC / RNS). No prices.
create or replace function public.soa_public(p_no text, p_key text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s soas;
begin
  select * into s from soas where soa_no = p_no and view_key = p_key;
  if s.id is null then return jsonb_build_object('ok', false, 'msg', 'This link is not valid. Ask the Supply Office for a new link.'); end if;
  if s.status = 'Cancelled' then return jsonb_build_object('ok', false, 'msg', s.soa_no || ' was cancelled.'); end if;
  return jsonb_build_object('ok', true, 'soa', jsonb_build_object('no', s.soa_no, 'dsm', s.dsm_label, 'hq', s.hq_code, 'from', s.period_from, 'to', s.period_to),
    'dns', (select coalesce(jsonb_agg(jsonb_build_object('no', d.dn_no, 'branch', b.name, 'prs', d.prs_no, 'date', d.delivery_date, 'mode', d.mode,
              'rider', d.rider, 'preparedBy', d.prepared_by, 'rr', d.rr_no, 'rDate', d.received_date, 'rBy', d.received_by, 'witness', d.witness,
              'validatedBy', d.validated_by, 'validated', d.validated_at, 'discrepancy', d.discrepancy, 'rRemarks', d.rr_remarks,
              'items', (select coalesce(jsonb_agg(jsonb_build_object('desc', i.description, 'forDesc', i.for_description, 'unit', i.unit,
                         'batch', coalesce(i.r_batch, i.batch_no), 'expiry', coalesce(i.r_expiry, i.expiry), 'qty', i.qty, 'rQty', i.r_qty,
                         'condition', i.condition, 'note', i.note) order by i.line_no), '[]') from dn_items i where i.dn_id = d.id))
              order by d.delivery_date, d.dn_no), '[]')
            from delivery_notes d join branches b on b.id = d.branch_id
            where d.id in (select dn_id from soa_lines where soa_id = s.id)));
end $$;

-- ---------------------------------------------------------------- Purchase Orders (Admin → Finance)
create table public.po_headers (
  po_no          text primary key,
  po_date        date not null default mnl_today(),
  supplier       text,
  address        text,
  contact        text,
  due_date       date,
  receipt_date   date,
  expected_date  date,
  payment_terms  text,
  shipping_terms text,
  notes          text,
  lines          jsonb,                       -- snapshot when submitted
  total          numeric(14, 2) not null default 0,
  status         text not null default 'Draft' check (status in ('Draft', 'Sent to Finance', 'Received by Finance',
                   'Processed by Finance', 'Returned by Finance', 'Cancelled')),
  prepared_by    text,
  prepared_at    timestamptz not null default now(),
  submitted_at   timestamptz,
  finance_by     text,
  finance_at     timestamptz,
  finance_ref    text,
  finance_note   text,
  history        jsonb not null default '[]',
  updated_at     timestamptz not null default now()
);
alter table public.po_headers enable row level security;
create policy po_read on public.po_headers for select to authenticated using (
  is_admin() or (me_type() = 'Finance' and status in ('Sent to Finance', 'Received by Finance', 'Returned by Finance', 'Processed by Finance')));

create or replace function public.po_live_lines(p_no text) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'sku', l.sku, 'name', p.name, 'uom', p.uom, 'qty', l.qty, 'cost', l.unit_cost,
           'total', round(l.qty * l.unit_cost, 2), 'status', l.status, 'batch', l.batch_no) order by l.id), '[]')
  from purchase_order_lines l join products p on p.sku = l.sku where upper(l.po_no) = upper(p_no)
$$;

create or replace function public.po_list() returns jsonb
language plpgsql security definer set search_path = public as $$
declare t user_type := require_type('Admin', 'Finance');
begin
  if t = 'Finance' then
    return jsonb_build_object('list', (select coalesce(jsonb_agg(jsonb_build_object('no', po_no, 'date', po_date, 'supplier', supplier,
             'items', jsonb_array_length(coalesce(lines, '[]')), 'total', total, 'status', status, 'financeRef', finance_ref, 'updated', updated_at)
             order by updated_at desc), '[]') from po_headers
             where status in ('Sent to Finance', 'Received by Finance', 'Returned by Finance', 'Processed by Finance')));
  end if;
  return jsonb_build_object(
    'list', (select coalesce(jsonb_agg(x order by x->>'date' desc, x->>'no' desc), '[]') from (
      select jsonb_build_object('no', coalesce(h.po_no, g.po_no), 'date', coalesce(h.po_date, g.d), 'supplier', coalesce(h.supplier, g.supplier),
        'items', coalesce(g.n, 0),
        'total', case when h.status is not null and h.status <> 'Draft' and h.lines is not null then h.total else coalesce(g.total, h.total, 0) end,
        'logStatus', g.st, 'status', coalesce(h.status, 'Not generated'), 'financeRef', h.finance_ref, 'updated', h.updated_at) x
      from (select po_no, min(po_date) d, max(supplier) supplier, count(*) n, sum(round(qty * unit_cost, 2)) total,
                   string_agg(distinct status, ' · ') st
            from purchase_order_lines where po_no <> '' group by po_no) g
      full join po_headers h on upper(h.po_no) = upper(g.po_no)) s),
    'loose', (select count(*) from purchase_order_lines where po_no = ''),
    'nextNo', 'PO CW ' || lpad((coalesce((select max(substring(z.no from '^PO CW (\d+)-' || extract(year from mnl_today()) || '$')::int)
                from (select po_no as no from purchase_order_lines union select po_no from po_headers) z), 0) + 1)::text, 3, '0')
              || '-' || extract(year from mnl_today()),
    'products', (select coalesce(jsonb_agg(jsonb_build_object('sku', sku, 'name', name, 'uom', uom, 'cost', unit_cost, 'supplier', supplier) order by name), '[]')
                 from products where active),
    'suppliers', (select coalesce(jsonb_agg(distinct s), '[]') from (select supplier s from purchase_order_lines where coalesce(supplier, '') <> ''
                  union select supplier from products where coalesce(supplier, '') <> '') z));
end $$;

create or replace function public.po_doc(p_no text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t user_type := require_type('Admin', 'Finance'); h po_headers; v_live jsonb; v_lines jsonb; v_editable boolean;
begin
  select * into h from po_headers where upper(po_no) = upper(p_no);
  if t = 'Finance' and (h.po_no is null or h.status not in ('Sent to Finance', 'Received by Finance', 'Returned by Finance', 'Processed by Finance')) then
    raise exception 'Purchase order % not found.', p_no;
  end if;
  v_live := po_live_lines(p_no);
  if h.po_no is null and jsonb_array_length(v_live) = 0 then raise exception 'Purchase order % not found.', p_no; end if;
  v_editable := h.po_no is null or h.status in ('Draft', 'Returned by Finance');
  v_lines := case when v_editable or h.lines is null then
               (select coalesce(jsonb_agg(x), '[]') from jsonb_array_elements(v_live) e(x) where x->>'status' <> 'Cancelled')
             else h.lines end;
  return jsonb_build_object('po', coalesce(to_jsonb(h), jsonb_build_object('po_no', upper(p_no), 'status', 'Not generated', 'history', '[]'))
           || jsonb_build_object('supplier', coalesce(h.supplier, (select max(supplier) from purchase_order_lines where upper(po_no) = upper(p_no))),
                                 'po_date', coalesce(h.po_date, (select min(po_date) from purchase_order_lines where upper(po_no) = upper(p_no)))),
         'lines', v_lines, 'editable', v_editable and t = 'Admin',
         'total', (select coalesce(sum((x->>'total')::numeric), 0) from jsonb_array_elements(v_lines) e(x)),
         'signers', setting('po_signers'));
end $$;

create or replace function public.po_upsert_header(p_no text, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into po_headers (po_no, prepared_by, history) values (p_no, my_name(), soa_hist('[]', 'Created', ''))
  on conflict (po_no) do nothing;
  update po_headers set
    po_date = coalesce(nullif(p->>'date', '')::date, po_date),
    supplier = case when p ? 'supplier' then nullif(left(trim(p->>'supplier'), 200), '') else supplier end,
    address = case when p ? 'address' then nullif(left(trim(p->>'address'), 300), '') else address end,
    contact = case when p ? 'contact' then nullif(left(trim(p->>'contact'), 200), '') else contact end,
    due_date = case when p ? 'due' then nullif(p->>'due', '')::date else due_date end,
    receipt_date = case when p ? 'receipt' then nullif(p->>'receipt', '')::date else receipt_date end,
    expected_date = case when p ? 'expected' then nullif(p->>'expected', '')::date else expected_date end,
    payment_terms = case when p ? 'payment' then nullif(left(trim(p->>'payment'), 120), '') else payment_terms end,
    shipping_terms = case when p ? 'shipping' then nullif(left(trim(p->>'shipping'), 120), '') else shipping_terms end,
    notes = case when p ? 'notes' then nullif(left(trim(p->>'notes'), 600), '') else notes end,
    updated_at = now()
  where po_no = p_no;
end $$;

-- Admin: new PO — lines are added to the CW Purchase Orders log as Pending. p: { no, date, supplier, lines:[{sku, qty, cost}] }
create or replace function public.po_create(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_no text := upper(trim(coalesce(p->>'no', ''))); l jsonb; n int := 0;
begin
  perform require_type('Admin');
  if v_no = '' then raise exception 'Enter the PO control no.'; end if;
  if trim(coalesce(p->>'supplier', '')) = '' then raise exception 'Enter the supplier.'; end if;
  if exists (select 1 from purchase_order_lines where upper(po_no) = v_no) or exists (select 1 from po_headers where po_no = v_no) then
    raise exception '% already exists. Open it from the list.', v_no;
  end if;
  for l in select * from jsonb_array_elements(coalesce(p->'lines', '[]')) loop
    if coalesce(l->>'sku', '') = '' or coalesce(nullif(l->>'qty', '')::numeric, 0) <= 0 then continue; end if;
    perform inv_po_add(jsonb_build_object('date', p->>'date', 'po', v_no, 'supplier', p->>'supplier', 'sku', l->>'sku',
      'qty', l->>'qty', 'cost', l->>'cost', 'status', 'Pending', 'remarks', 'Created in the PO tab'));
    n := n + 1;
  end loop;
  if n = 0 then raise exception 'Add at least one item with a quantity.'; end if;
  perform po_upsert_header(v_no, jsonb_build_object('date', p->>'date', 'supplier', p->>'supplier'));
  return jsonb_build_object('ok', true, 'no', v_no, 'msg', v_no || ' created with ' || n || ' item(s) in the CW log. Fill in the details, then submit it to Finance.');
end $$;

create or replace function public.po_save(p_no text, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare h po_headers; v_no text := upper(trim(p_no));
begin
  perform require_type('Admin');
  select * into h from po_headers where po_no = v_no;
  if h.po_no is not null and h.status not in ('Draft', 'Returned by Finance') then raise exception '% was already sent to Finance.', v_no; end if;
  if h.po_no is null and not exists (select 1 from purchase_order_lines where upper(po_no) = v_no) then raise exception 'Purchase order not found.'; end if;
  perform po_upsert_header(v_no, p);
  return jsonb_build_object('ok', true, 'msg', v_no || ' details saved.');
end $$;

create or replace function public.po_submit(p_no text, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare h po_headers; v_no text := upper(trim(p_no)); v_lines jsonb; v_bad text; v_total numeric; v_was text;
begin
  perform require_type('Admin');
  select * into h from po_headers where po_no = v_no;
  if h.po_no is not null and h.status not in ('Draft', 'Returned by Finance') then raise exception '% was already sent to Finance.', v_no; end if;
  v_was := h.status;
  select coalesce(jsonb_agg(x), '[]') into v_lines from jsonb_array_elements(po_live_lines(v_no)) e(x) where x->>'status' <> 'Cancelled';
  if jsonb_array_length(v_lines) = 0 then raise exception '% has no active lines in the Central Warehouse log.', v_no; end if;
  select string_agg(x->>'name', ', ') into v_bad from jsonb_array_elements(v_lines) e(x) where (x->>'cost')::numeric <= 0;
  if v_bad is not null then raise exception 'Enter the unit cost (pre-approved supplier quotation) of % in the CW Purchase Orders log first.', v_bad; end if;
  perform po_upsert_header(v_no, p);
  select * into h from po_headers where po_no = v_no;
  if coalesce(h.supplier, '') = '' then raise exception 'Enter the supplier company name.'; end if;
  select sum((x->>'total')::numeric) into v_total from jsonb_array_elements(v_lines) e(x);
  update po_headers set lines = v_lines, total = v_total, status = 'Sent to Finance', submitted_at = now(),
         finance_by = null, finance_at = null, finance_note = null,
         history = soa_hist(history, case when v_was = 'Returned by Finance' then 'Corrected and re-sent to Finance' else 'Submitted to Finance' end, p->>'note'),
         updated_at = now()
   where po_no = v_no;
  perform queue_email(finance_emails(), admin_emails(), 'Purchase Order ' || v_no || ' · ' || h.supplier || ' · ₱' || to_char(v_total, 'FM999,999,990.00'),
    mail_wrap('Purchase Order for processing', '<p>Good day, Finance Department.</p><p>Purchase Order <b>' || esc(v_no) || '</b> from ' ||
      esc(h.supplier) || ' — total <b>₱' || to_char(v_total, 'FM999,999,990.00') || '</b> — is ready for processing. Open it in the portal to print or save it as PDF.</p>' ||
      coalesce('<p>Note: ' || esc(nullif(p->>'note', '')) || '</p>', '')));
  perform log_event('PO SUBMITTED ' || v_no);
  return jsonb_build_object('ok', true, 'msg', v_no || ' sent to Finance (₱' || to_char(v_total, 'FM999,999,990.00') || ').');
end $$;

create or replace function public.po_action(p_no text, p_action text, p_note text default '', p_ref text default '') returns jsonb
language plpgsql security definer set search_path = public as $$
declare t user_type := require_type('Admin', 'Finance'); h po_headers; v_note text := left(trim(coalesce(p_note, '')), 500);
        v_ref text := left(trim(coalesce(p_ref, '')), 120); v_label text; v_msg text;
begin
  select * into h from po_headers where po_no = upper(trim(p_no)) for update;
  if h.po_no is null then raise exception 'Purchase order not found.'; end if;
  if p_action = 'cancel' then
    if not (t = 'Admin' and h.status in ('Draft', 'Returned by Finance')) then raise exception 'Only a draft or returned PO can be cancelled.'; end if;
    update po_headers set status = 'Cancelled' where po_no = h.po_no; v_label := 'Cancelled'; v_msg := h.po_no || ' cancelled.';
  elsif p_action = 'receive' then
    if not (t = 'Finance' and h.status = 'Sent to Finance') then raise exception 'Only a newly sent PO can be marked received.'; end if;
    update po_headers set status = 'Received by Finance', finance_by = my_name(), finance_at = now() where po_no = h.po_no;
    v_label := 'Received by Finance'; v_msg := h.po_no || ' marked received.';
  elsif p_action = 'process' then
    if not (t = 'Finance' and h.status in ('Sent to Finance', 'Received by Finance')) then raise exception 'Only a PO sent to Finance can be processed.'; end if;
    if v_ref = '' then raise exception 'Enter the voucher / reference no.'; end if;
    update po_headers set status = 'Processed by Finance', finance_by = my_name(), finance_at = now(), finance_ref = v_ref,
           finance_note = coalesce(nullif(v_note, ''), finance_note) where po_no = h.po_no;
    perform queue_email(admin_emails(), '{}', 'PO processed: ' || h.po_no || ' (ref. ' || v_ref || ')',
      mail_wrap('PO processed by Finance', '<p>' || esc(h.po_no) || ' — reference <b>' || esc(v_ref) || '</b>.</p>'));
    v_label := 'Processed by Finance (ref. ' || v_ref || ')'; v_msg := h.po_no || ' processed (ref. ' || v_ref || ').';
  elsif p_action = 'return' then
    if not (t = 'Finance' and h.status in ('Sent to Finance', 'Received by Finance')) then raise exception 'Only a PO sent to Finance can be returned.'; end if;
    if v_note = '' then raise exception 'Write what needs clarification.'; end if;
    update po_headers set status = 'Returned by Finance', finance_by = my_name(), finance_at = now(), finance_note = v_note where po_no = h.po_no;
    perform queue_email(admin_emails(), '{}', 'Finance returned PO ' || h.po_no,
      mail_wrap('Finance returned a PO', '<p>' || esc(h.po_no) || ' — <b>Note:</b> ' || esc(v_note) || '</p>'));
    v_label := 'Returned by Finance'; v_msg := h.po_no || ' returned to the Supply Office.';
  else raise exception 'Unknown action.'; end if;
  update po_headers set history = soa_hist(history, v_label, v_note), updated_at = now() where po_no = h.po_no;
  perform log_event('PO ' || upper(p_action) || ' ' || h.po_no);
  return jsonb_build_object('ok', true, 'msg', v_msg);
end $$;

-- ---------------------------------------------------------------- Monday report (Admin)
create table public.monday_reports (
  week_of    date primary key check (extract(isodow from week_of) = 1),
  wins       text[] not null default '{}',
  cascading  text[] not null default '{}',
  escalation text[] not null default '{}',
  updated_at timestamptz not null default now(),
  updated_by text
);
alter table public.monday_reports enable row level security;
create policy monday_admin on public.monday_reports for all to authenticated using (is_admin()) with check (is_admin());

-- ---------------------------------------------------------------- Ordered items (HQ / Admin)
-- Approved PRS in scope and their lines: [prs index, description, unit, qty ordered, qty delivered]
create or replace function public.ordered_items(p_from date, p_to date) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t user_type := require_type('HQ', 'Admin');
begin
  return (
    with pr as (
      select p.id, p.control_no, p.prs_date, p.status, b.name as branch, p.hq_code, coalesce(p.sent_to_hq_at, p.date_approved) as approved,
             row_number() over (order by p.prs_date, p.control_no) - 1 as ix
      from prs p join branches b on b.id = p.branch_id
      where (t = 'Admin' or p.hq_code = any (my_hqs()))
        and (p.status in ('Approved', 'Partially Served', 'Served')
             or (p.sent_to_hq_at is not null and p.status not in ('Returned for Correction', 'Cancelled', 'Submitted', 'Under Review')))
        and (p_from is null or p.prs_date >= p_from) and (p_to is null or p.prs_date <= p_to))
    select jsonb_build_object(
      'role', t, 'today', mnl_today(),
      'prs', (select coalesce(jsonb_agg(jsonb_build_object('no', control_no, 'date', prs_date, 'branch', branch, 'hq', hq_code, 'status', status,
               'approved', approved) order by ix), '[]') from pr),
      'lines', (select coalesce(jsonb_agg(jsonb_build_array(pr.ix, x.description, x.unit, x.requested, x.delivered)), '[]')
                from pr cross join lateral prs_remaining(pr.id, null) x)));
end $$;

-- ---------------------------------------------------------------- Admin report data
-- orders: [year, supplier, item, qty, unitCost, total]   dist: [year, region, 'yyyy-MM', branch, item, qty, total, noCost]
create or replace function public.report_data() returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform require_type('Admin');
  return jsonb_build_object(
    'built', to_char(mnl_now(), 'Mon FMDD, YYYY FMHH12:MI AM'),
    'orders', (select coalesce(jsonb_agg(jsonb_build_array(extract(year from coalesce(l.received_date, l.po_date))::int,
                 coalesce(nullif(l.supplier, ''), 'Unknown supplier'), p.name, l.qty, l.unit_cost, round(l.qty * l.unit_cost, 2))), '[]')
               from purchase_order_lines l join products p on p.sku = l.sku where l.status = 'Received'),
    'dist', (select coalesce(jsonb_agg(jsonb_build_array(extract(year from d.delivery_date)::int, h.region, to_char(d.delivery_date, 'YYYY-MM'),
               b.short_name, coalesce(p.name, i.description), coalesce(i.r_qty, i.qty),
               round(coalesce(i.r_qty, i.qty) * coalesce(p.unit_cost, 0), 2), case when coalesce(p.unit_cost, 0) > 0 then 0 else 1 end)), '[]')
             from dn_items i join delivery_notes d on d.id = i.dn_id join branches b on b.id = d.branch_id join hqs h on h.code = d.hq_code
             left join batches bt on bt.batch_no = upper(coalesce(i.r_batch, i.batch_no)) left join products p on p.sku = bt.sku
             where d.status <> 'Prepared'));
end $$;

-- ---------------------------------------------------------------- Admin data export (backup to a JSON file)
create or replace function public.admin_export() returns jsonb
language plpgsql security definer set search_path = public as $$
declare out jsonb := '{}'; t text; v jsonb;
begin
  perform require_type('Admin');
  foreach t in array array['hqs', 'branches', 'app_users', 'app_settings', 'links', 'prs', 'prs_items', 'wastage_reports',
    'fridge_locations', 'temp_readings', 'chat_messages', 'employees', 'attendance_sites', 'attendance', 'products', 'hq_prices',
    'batches', 'purchase_order_lines', 'stock_moves', 'delivery_notes', 'dn_items', 'sc_items', 'sc_entries', 'sc_locks',
    'dsm_groups', 'soas', 'soa_lines', 'soa_attachments', 'po_headers', 'monday_reports', 'doc_counters'] loop
    execute format('select coalesce(jsonb_agg(to_jsonb(x)), ''[]'') from public.%I x', t) into v;
    out := out || jsonb_build_object(t, v);
  end loop;
  return out;
end $$;
