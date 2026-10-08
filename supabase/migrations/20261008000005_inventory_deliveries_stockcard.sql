-- =====================================================================
-- Inventory (Central Warehouse + each HQ), Delivery Notes / Receiving
-- Reports, and the branch Stockcard.
--
-- Stock is a ledger: every movement of a batch is one row in stock_moves
-- (from_loc → to_loc). Locations: 'CW' · 'HQ:<code>' · 'BR:<branch uuid>'.
-- Balances are sums of the ledger, so nothing can drift like sheet formulas.
-- =====================================================================

create table public.products (
  sku           text primary key,
  name          text not null,
  category      text not null default 'Medical Supplies',
  uom           text,
  unit_cost     numeric(12, 2) not null default 0,     -- Central Warehouse cost
  reorder_point numeric,
  supplier      text,
  active        boolean not null default true
);

create table public.hq_prices (                        -- HQ "Price per Unit" (used on the SOA)
  hq_code text not null references public.hqs(code),
  sku     text not null references public.products(sku) on delete cascade,
  price   numeric(12, 2) not null check (price >= 0),
  primary key (hq_code, sku)
);

create table public.batches (
  batch_no   text primary key,
  sku        text not null references public.products(sku),
  expiry     date not null,
  created_at timestamptz not null default now()
);

create table public.purchase_order_lines (             -- Central Warehouse "Purchase Orders" log
  id            bigserial primary key,
  po_no         text not null default '',
  po_date       date not null default mnl_today(),
  supplier      text,
  sku           text not null references public.products(sku),
  batch_no      text,
  expiry        date,
  unit_cost     numeric(12, 2) not null default 0,
  qty           numeric not null check (qty > 0),
  status        text not null default 'Pending' check (status in ('Pending', 'Received', 'Cancelled')),
  received_date date,
  remarks       text,
  created_by    uuid references public.app_users(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index on public.purchase_order_lines (po_no);

create table public.stock_moves (
  id         bigserial primary key,
  moved_on   date not null default mnl_today(),
  batch_no   text not null references public.batches(batch_no),
  qty        numeric not null check (qty > 0),
  from_loc   text,
  to_loc     text,
  kind       text not null check (kind in ('PO_RECEIPT', 'TRANSFER', 'DISPATCH', 'ADJUST')),
  ref        text,
  note       text,
  po_line_id bigint references public.purchase_order_lines(id) on delete cascade,
  dn_id      uuid,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  check (from_loc is not null or to_loc is not null)
);
create index on public.stock_moves (batch_no);
create index on public.stock_moves (to_loc);
create index on public.stock_moves (from_loc);

create or replace view public.stock_balance with (security_invoker = true) as
  select loc, batch_no, sum(q) as qty from (
    select to_loc as loc, batch_no, qty as q from public.stock_moves where to_loc is not null
    union all
    select from_loc, batch_no, -qty from public.stock_moves where from_loc is not null) m
  group by loc, batch_no;

create or replace function public.stock_at(p_loc text, p_batch text) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum(case when to_loc = p_loc then qty else 0 end) - sum(case when from_loc = p_loc then qty else 0 end), 0)
  from stock_moves where batch_no = p_batch and (to_loc = p_loc or from_loc = p_loc)
$$;

create or replace function public.expiry_alert(p_exp date) returns text
language sql stable as $$
  select case when p_exp is null then '' when p_exp < mnl_today() then 'Expired'
              when p_exp <= mnl_today() + 90 then 'Expiring ≤90 days' else 'OK' end
$$;

-- Registers a batch or checks it matches what is already recorded
create or replace function public.ensure_batch(p_batch text, p_sku text, p_exp date) returns text
language plpgsql security definer set search_path = public as $$
declare b batches; v text := upper(trim(coalesce(p_batch, '')));
begin
  if v = '' then raise exception 'Enter the Batch No.'; end if;
  if p_exp is null then raise exception 'Enter the expiry date of batch %.', v; end if;
  select * into b from batches where batch_no = v;
  if b.batch_no is null then
    insert into batches (batch_no, sku, expiry) values (v, upper(p_sku), p_exp);
  else
    if b.sku <> upper(p_sku) then raise exception 'Batch % is already recorded for another SKU (%).', v, b.sku; end if;
    if b.expiry <> p_exp then
      raise exception 'Batch % is already recorded with expiry %, but this entry says %. Correct one of them first.', v, b.expiry, p_exp;
    end if;
  end if;
  return v;
end $$;

-- Which inventory this account may open: HQ → its own · Admin → CW or any HQ
create or replace function public.inv_loc_for(p_req text) returns text
language plpgsql stable security definer set search_path = public as $$
declare t user_type := me_type(); h text[] := my_hqs(); r text := upper(coalesce(p_req, ''));
begin
  if t = 'HQ' then return 'HQ:' || h[1]; end if;
  if t = 'Admin' then
    if r = 'CW' or r = '' then return 'CW'; end if;
    if r like 'HQ:%' and exists (select 1 from hqs where code = substr(r, 4)) then return r; end if;
    if exists (select 1 from hqs where code = r) then return 'HQ:' || r; end if;
    return 'CW';
  end if;
  raise exception 'The inventory is for Headquarters and the Central Warehouse (Admin).';
end $$;

-- ---------------------------------------------------------------- inventory data for the tab
create or replace function public.inv_get(p_loc text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_loc text := inv_loc_for(p_loc); v_hq text; out jsonb;
begin
  if v_loc = 'CW' then
    with bal as (select loc, batch_no, qty from stock_balance),
    bt as (
      select b.batch_no, b.sku, p.name, b.expiry, (b.expiry - mnl_today()) as days, expiry_alert(b.expiry) as alert,
             coalesce((select sum(qty) from stock_moves m where m.batch_no = b.batch_no and m.to_loc = 'CW'), 0) as received,
             coalesce((select sum(qty) from stock_moves m where m.batch_no = b.batch_no and m.from_loc = 'CW'), 0) as delivered,
             coalesce((select qty from bal where bal.loc = 'CW' and bal.batch_no = b.batch_no), 0) as cw,
             coalesce((select jsonb_object_agg(substr(loc, 4), qty) from bal where bal.loc like 'HQ:%' and bal.batch_no = b.batch_no), '{}') as hqs,
             coalesce((select sum(qty) from bal where bal.loc like 'BR:%' and bal.batch_no = b.batch_no), 0) as branches
      from batches b join products p on p.sku = b.sku)
    select jsonb_build_object(
      'kind', 'CW', 'loc', 'CW', 'name', 'Central Warehouse',
      'products', (select coalesce(jsonb_agg(x order by x->>'sku'), '[]') from (
        select jsonb_build_object('sku', p.sku, 'name', p.name, 'category', p.category, 'uom', p.uom, 'cost', p.unit_cost,
          'reorder', p.reorder_point, 'supplier', p.supplier,
          'received', coalesce((select sum(received) from bt where bt.sku = p.sku), 0),
          'onOrder', coalesce((select sum(qty) from purchase_order_lines l where l.sku = p.sku and l.status = 'Pending'), 0),
          'cw', coalesce((select sum(cw) from bt where bt.sku = p.sku), 0),
          'atHqs', coalesce((select sum(bal.qty) from bal join batches b on b.batch_no = bal.batch_no where b.sku = p.sku and bal.loc like 'HQ:%'), 0),
          'atBranches', coalesce((select sum(branches) from bt where bt.sku = p.sku), 0),
          'batches', (select count(*) from bt where bt.sku = p.sku and bt.cw > 0),
          'nearest', (select min(expiry) from bt where bt.sku = p.sku and bt.cw > 0)) x
        from products p where p.active) s),
      'batches', (select coalesce(jsonb_agg(to_jsonb(bt) order by bt.expiry), '[]') from bt),
      'pos', (select coalesce(jsonb_agg(to_jsonb(l) || jsonb_build_object('name', p.name, 'uom', p.uom) order by l.id desc), '[]')
              from (select * from purchase_order_lines order by id desc limit 300) l join products p on p.sku = l.sku),
      'suppliers', (select coalesce(jsonb_agg(distinct s), '[]') from (
                      select supplier s from purchase_order_lines where coalesce(supplier, '') <> ''
                      union select supplier from products where coalesce(supplier, '') <> '') z),
      'hqs', (select jsonb_agg(jsonb_build_object('code', code, 'name', name) order by sort) from hqs))
    into out;
  else
    v_hq := substr(v_loc, 4);
    with bal as (select loc, batch_no, qty from stock_balance),
    br as (select 'BR:' || id::text as loc from branches where hq_code = v_hq),
    bt as (
      select b.batch_no, b.sku, p.name, p.uom, b.expiry, (b.expiry - mnl_today()) as days, expiry_alert(b.expiry) as alert,
             coalesce((select sum(qty) from stock_moves m where m.batch_no = b.batch_no and m.to_loc = v_loc), 0) as received,
             coalesce((select qty from bal where bal.loc = v_loc and bal.batch_no = b.batch_no), 0) as hq,
             coalesce((select sum(qty) from bal where bal.loc in (select loc from br) and bal.batch_no = b.batch_no), 0) as branches
      from batches b join products p on p.sku = b.sku
      where exists (select 1 from stock_moves m where m.batch_no = b.batch_no and (m.to_loc = v_loc or m.from_loc = v_loc)))
    select jsonb_build_object(
      'kind', 'HQ', 'loc', v_loc, 'hq', v_hq, 'name', (select name from hqs where code = v_hq),
      'products', (select coalesce(jsonb_agg(x order by x->>'sku'), '[]') from (
        select jsonb_build_object('sku', p.sku, 'name', p.name, 'category', p.category, 'uom', p.uom, 'reorder', p.reorder_point,
          'price', (select price from hq_prices hp where hp.hq_code = v_hq and hp.sku = p.sku),
          'received', coalesce((select sum(received) from bt where bt.sku = p.sku), 0),
          'hq', coalesce((select sum(hq) from bt where bt.sku = p.sku), 0),
          'branches', coalesce((select sum(branches) from bt where bt.sku = p.sku), 0),
          'batches', (select count(*) from bt where bt.sku = p.sku and bt.hq > 0),
          'nearest', (select min(expiry) from bt where bt.sku = p.sku and bt.hq > 0)) x
        from products p where p.active) s),
      'batches', (select coalesce(jsonb_agg(to_jsonb(bt) order by bt.expiry), '[]') from bt),
      'receipts', (select coalesce(jsonb_agg(jsonb_build_object('date', m.moved_on, 'dr', m.ref, 'batch', m.batch_no, 'sku', b.sku,
                     'name', p.name, 'expiry', b.expiry, 'qty', m.qty, 'remarks', m.note) order by m.id desc), '[]')
                   from (select * from stock_moves where to_loc = v_loc order by id desc limit 80) m
                   join batches b on b.batch_no = m.batch_no join products p on p.sku = b.sku),
      'orders', (select coalesce(jsonb_agg(jsonb_build_object('date', m.moved_on, 'ref', m.ref, 'branch', br2.name, 'batch', m.batch_no,
                   'name', p.name, 'expiry', b.expiry, 'qty', m.qty, 'remarks', m.note) order by m.id desc), '[]')
                 from (select * from stock_moves where from_loc = v_loc order by id desc limit 80) m
                 join batches b on b.batch_no = m.batch_no join products p on p.sku = b.sku
                 left join branches br2 on 'BR:' || br2.id::text = m.to_loc))
    into out;
  end if;
  return out || jsonb_build_object('role', me_type(), 'canEdit', (me_type() = 'Admin') = (v_loc = 'CW'), 'today', mnl_today(),
    'locations', case when me_type() = 'Admin' then
      (select jsonb_build_array(jsonb_build_object('key', 'CW', 'name', 'Central Warehouse')) ||
              coalesce(jsonb_agg(jsonb_build_object('key', 'HQ:' || code, 'name', name) order by sort), '[]') from hqs)
      else '[]'::jsonb end);
end $$;

-- ---------------------------------------------------------------- Admin: purchase order line (stock in at CW)
-- p: { date, po, supplier, sku, batch, expiry, qty, cost, status, received, remarks }
create or replace function public.inv_po_add(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_sku text := upper(trim(coalesce(p->>'sku', ''))); v_status text := coalesce(nullif(p->>'status', ''), 'Received');
        v_batch text := upper(trim(coalesce(p->>'batch', ''))); v_exp date := nullif(p->>'expiry', '')::date;
        v_qty numeric := nullif(p->>'qty', '')::numeric; v_cost numeric := nullif(p->>'cost', '')::numeric; v_id bigint; pr products;
begin
  perform require_type('Admin');
  select * into pr from products where sku = v_sku;
  if pr.sku is null then raise exception 'Choose a SKU from the product list.'; end if;
  if v_status not in ('Pending', 'Received', 'Cancelled') then raise exception 'Unknown status.'; end if;
  if v_qty is null or v_qty <= 0 then raise exception 'Enter the quantity.'; end if;
  if v_status = 'Received' and v_batch = '' then raise exception 'Enter the Batch No. of the stock received.'; end if;
  if v_status = 'Received' and v_exp is null then raise exception 'Enter the expiry date.'; end if;
  if v_batch <> '' and exists (select 1 from batches where batch_no = v_batch and sku <> v_sku) then
    raise exception 'Batch % is already used for another SKU.', v_batch;
  end if;
  insert into purchase_order_lines (po_no, po_date, supplier, sku, batch_no, expiry, unit_cost, qty, status, received_date, remarks, created_by)
  values (trim(coalesce(p->>'po', '')), coalesce(nullif(p->>'date', '')::date, mnl_today()), nullif(trim(coalesce(p->>'supplier', '')), ''),
          v_sku, nullif(v_batch, ''), v_exp, coalesce(v_cost, pr.unit_cost, 0), v_qty, v_status,
          case when v_status = 'Received' then coalesce(nullif(p->>'received', '')::date, mnl_today()) end,
          nullif(left(trim(coalesce(p->>'remarks', '')), 200), ''), auth.uid())
  returning id into v_id;
  if v_status = 'Received' then
    perform ensure_batch(v_batch, v_sku, v_exp);
    insert into stock_moves (moved_on, batch_no, qty, to_loc, kind, ref, po_line_id, created_by)
    values (coalesce(nullif(p->>'received', '')::date, mnl_today()), v_batch, v_qty, 'CW', 'PO_RECEIPT', nullif(trim(coalesce(p->>'po', '')), ''), v_id, auth.uid());
  end if;
  perform log_event('INV PO ' || coalesce(p->>'po', '') || ' ' || v_sku || ' ' || v_batch);
  return jsonb_build_object('ok', true, 'id', v_id, 'msg', 'Purchase order line saved' ||
    case when v_status = 'Received' then ' — ' || v_qty || ' of batch ' || v_batch || ' added to the Central Warehouse.' else ' as ' || v_status || '.' end);
end $$;

-- p: { id, status, batch, expiry, qty, received, remarks, cost }
create or replace function public.inv_po_update(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare l purchase_order_lines; v_status text; v_batch text; v_exp date; v_qty numeric; v_old text;
begin
  perform require_type('Admin');
  select * into l from purchase_order_lines where id = (p->>'id')::bigint for update;
  if l.id is null then raise exception 'Purchase order line not found.'; end if;
  v_status := coalesce(nullif(p->>'status', ''), l.status);
  if v_status not in ('Pending', 'Received', 'Cancelled') then raise exception 'Unknown status.'; end if;
  v_batch := upper(trim(coalesce(p->>'batch', l.batch_no, '')));
  v_exp := case when p ? 'expiry' then nullif(p->>'expiry', '')::date else l.expiry end;
  v_qty := coalesce(nullif(p->>'qty', '')::numeric, l.qty);
  if v_qty <= 0 then raise exception 'Enter the quantity.'; end if;
  if v_status = 'Received' and v_batch = '' then raise exception 'Enter the Batch No. of the stock received.'; end if;
  if v_status = 'Received' and v_exp is null then raise exception 'Enter the expiry date.'; end if;
  if v_batch <> '' and exists (select 1 from batches where batch_no = v_batch and sku <> l.sku) then
    raise exception 'Batch % is already used for another SKU.', v_batch;
  end if;
  v_old := l.batch_no;
  delete from stock_moves where po_line_id = l.id;
  update purchase_order_lines set status = v_status, batch_no = nullif(v_batch, ''), expiry = v_exp, qty = v_qty,
         unit_cost = coalesce(nullif(p->>'cost', '')::numeric, unit_cost),
         received_date = case when v_status = 'Received' then coalesce(nullif(p->>'received', '')::date, received_date, mnl_today()) end,
         remarks = case when p ? 'remarks' then nullif(left(trim(p->>'remarks'), 200), '') else remarks end
   where id = l.id;
  if v_status = 'Received' then
    perform ensure_batch(v_batch, l.sku, v_exp);
    insert into stock_moves (moved_on, batch_no, qty, to_loc, kind, ref, po_line_id, created_by)
    values (coalesce(nullif(p->>'received', '')::date, l.received_date, mnl_today()), v_batch, v_qty, 'CW', 'PO_RECEIPT', nullif(l.po_no, ''), l.id, auth.uid());
  end if;
  -- stock already sent to the HQs cannot be "un-received"
  if v_old is not null and stock_at('CW', v_old) < 0 then
    raise exception 'Not enough of batch % is left at the Central Warehouse — it was already sent to HQs. Correct the transfers first.', v_old;
  end if;
  perform log_event('INV PO EDIT ' || l.id || ' ' || l.sku || ' ' || v_status);
  return jsonb_build_object('ok', true, 'msg', 'Purchase order ' || coalesce(nullif(l.po_no, ''), l.sku) || ' updated — ' || v_status ||
    case when v_status = 'Received' and l.status <> 'Received' then ': ' || v_qty || ' of batch ' || v_batch || ' added to the Central Warehouse stock.' else '.' end);
end $$;

-- Admin: send a batch from the Central Warehouse to an HQ. p: { hq, batch, qty, date, dr, remarks }
create or replace function public.inv_transfer(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b batches; v_hq text := upper(coalesce(p->>'hq', '')); v_qty numeric := nullif(p->>'qty', '')::numeric; v_have numeric; v_name text;
begin
  perform require_type('Admin');
  if not exists (select 1 from hqs where code = v_hq) then raise exception 'Choose the HQ.'; end if;
  select * into b from batches where batch_no = upper(trim(coalesce(p->>'batch', '')));
  if b.batch_no is null then raise exception 'Batch % is not in the Central Warehouse.', p->>'batch'; end if;
  if v_qty is null or v_qty <= 0 then raise exception 'Enter the quantity.'; end if;
  if b.expiry < mnl_today() then raise exception 'Batch % is EXPIRED and cannot be transferred.', b.batch_no; end if;
  v_have := stock_at('CW', b.batch_no);
  if v_qty > v_have then raise exception 'Only % of batch % left at the Central Warehouse.', v_have, b.batch_no; end if;
  insert into stock_moves (moved_on, batch_no, qty, from_loc, to_loc, kind, ref, note, created_by)
  values (coalesce(nullif(p->>'date', '')::date, mnl_today()), b.batch_no, v_qty, 'CW', 'HQ:' || v_hq, 'TRANSFER',
          nullif(trim(coalesce(p->>'dr', '')), ''),
          left('Transfer from Central Warehouse' || coalesce(' · ' || nullif(trim(p->>'remarks'), ''), ''), 200), auth.uid());
  select name into v_name from products where sku = b.sku;
  perform log_event('INV TRANSFER ' || b.batch_no || ' x' || v_qty || ' to ' || v_hq);
  return jsonb_build_object('ok', true, 'msg', v_qty || ' of ' || v_name || ' (batch ' || b.batch_no || ') sent to ' ||
    (select name from hqs where code = v_hq) || '. It shows in that HQ''s inventory now.');
end $$;

-- HQ: log stock received from the Central Warehouse. p: { date, dr, sku, batch, expiry, qty, remarks }
create or replace function public.inv_hq_receive(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_loc text := inv_loc_for(null); v_sku text := upper(trim(coalesce(p->>'sku', ''))); v_batch text;
        v_qty numeric := nullif(p->>'qty', '')::numeric; v_dr text := nullif(trim(coalesce(p->>'dr', '')), '');
begin
  perform require_type('HQ');
  if not exists (select 1 from products where sku = v_sku) then raise exception 'Choose a product (SKU).'; end if;
  if v_qty is null or v_qty <= 0 then raise exception 'Enter the quantity.'; end if;
  v_batch := ensure_batch(p->>'batch', v_sku, nullif(p->>'expiry', '')::date);
  if v_dr is not null and exists (select 1 from stock_moves where to_loc = v_loc and batch_no = v_batch and upper(ref) = upper(v_dr)) then
    raise exception 'Batch % on % is already recorded — it may have been entered already.', v_batch, v_dr;
  end if;
  insert into stock_moves (moved_on, batch_no, qty, from_loc, to_loc, kind, ref, note, created_by)
  values (coalesce(nullif(p->>'date', '')::date, mnl_today()), v_batch, v_qty, 'CW', v_loc, 'TRANSFER', v_dr,
          nullif(left(trim(coalesce(p->>'remarks', '')), 200), ''), auth.uid());
  perform log_event('INV RECEIVED ' || v_batch || ' x' || v_qty);
  return jsonb_build_object('ok', true, 'msg', 'Received ' || v_qty || ' of batch ' || v_batch || ' at ' ||
    (select name from hqs where code = substr(v_loc, 4)) || '.');
end $$;

-- HQ: batches on hand (for the Delivery Note batch picker), nearest expiry first
create or replace function public.inv_hq_batches() returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_loc text := inv_loc_for(null);
begin
  perform require_type('HQ');
  return jsonb_build_object('hq', (select name from hqs where code = substr(v_loc, 4)),
    'batches', (select coalesce(jsonb_agg(jsonb_build_object('batch', b.batch_no, 'sku', b.sku, 'name', p.name, 'uom', p.uom,
                  'expiry', b.expiry, 'hq', s.qty, 'alert', expiry_alert(b.expiry)) order by b.expiry), '[]')
                from stock_balance s join batches b on b.batch_no = s.batch_no join products p on p.sku = b.sku
                where s.loc = v_loc and s.qty > 0),
    'products', (select coalesce(jsonb_agg(jsonb_build_object('sku', p.sku, 'name', p.name, 'uom', p.uom,
                  'hq', coalesce((select sum(s.qty) from stock_balance s join batches b on b.batch_no = s.batch_no
                                  where s.loc = v_loc and b.sku = p.sku), 0)) order by p.name), '[]')
                 from products p where p.active));
end $$;

alter table public.products enable row level security;
alter table public.hq_prices enable row level security;
alter table public.batches enable row level security;
alter table public.purchase_order_lines enable row level security;
alter table public.stock_moves enable row level security;
create policy products_read on public.products for select to authenticated using (me_type() is not null);
create policy products_admin on public.products for all to authenticated using (is_admin()) with check (is_admin());
create policy hq_prices_read on public.hq_prices for select to authenticated using (me_type() in ('HQ', 'Admin', 'Finance'));
create policy hq_prices_write on public.hq_prices for all to authenticated
  using (is_admin() or (me_type() = 'HQ' and hq_code = any (my_hqs())))
  with check (is_admin() or (me_type() = 'HQ' and hq_code = any (my_hqs())));
create policy batches_read on public.batches for select to authenticated using (me_type() is not null);
create policy po_lines_admin on public.purchase_order_lines for select to authenticated using (is_admin());
create policy moves_admin on public.stock_moves for select to authenticated using (is_admin());

-- =====================================================================
-- Delivery Note (HQ) · Receiving Report (Branch) · validation
-- =====================================================================
create table public.delivery_notes (
  id              uuid primary key default gen_random_uuid(),
  dn_no           text not null unique,
  delivery_date   date not null,
  hq_code         text not null references public.hqs(code),
  branch_id       uuid not null references public.branches(id),
  prs_id          uuid references public.prs(id) on delete set null,
  prs_no          text,
  prs_date        date,
  prepared_by     text,
  approved_by     text,
  status          text not null default 'Prepared'
                  check (status in ('Prepared', 'Dispatched', 'Received', 'Received – with discrepancy', 'Validated')),
  remarks         text,
  mode            text,
  rider           text,
  created_at      timestamptz not null default now(),
  created_by      uuid references public.app_users(id) on delete set null,
  dispatched_at   timestamptz,
  rr_no           text unique,
  received_date   date,
  received_by     text,
  witness         text,
  discrepancy     text,
  rr_remarks      text,
  rr_submitted_at timestamptz,
  rr_submitted_by uuid references public.app_users(id) on delete set null,
  validated_by    text,
  validated_at    timestamptz
);
create index on public.delivery_notes (hq_code);
create index on public.delivery_notes (branch_id);
create index on public.delivery_notes (prs_id);

create table public.dn_items (
  id              bigserial primary key,
  dn_id           uuid not null references public.delivery_notes(id) on delete cascade,
  line_no         int not null,
  qty             numeric not null check (qty > 0),
  unit            text,
  description     text not null,
  batch_no        text,
  expiry          date,
  for_description text,                 -- PRS item it replaces (e.g. Speeda sent for Abhayrab)
  r_qty           numeric,
  r_batch         text,
  r_expiry        date,
  condition       text,
  note            text
);
create index on public.dn_items (dn_id);

alter table public.stock_moves add constraint stock_moves_dn_fk foreign key (dn_id) references public.delivery_notes(id) on delete cascade;

create or replace function public.can_see_dn(p_hq text, p_branch uuid, p_status text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare t user_type := me_type();
begin
  if t = 'Admin' then return true; end if;
  if t = 'HQ' then return p_hq = any (my_hqs()); end if;
  if t = 'Branch' then return p_branch = my_branch() and p_status <> 'Prepared'; end if;
  if t = 'RNS' then return can_see_branch(p_branch); end if;
  return false;
end $$;

alter table public.delivery_notes enable row level security;
alter table public.dn_items enable row level security;
create policy dn_read on public.delivery_notes for select to authenticated using (can_see_dn(hq_code, branch_id, status));
create policy dn_items_read on public.dn_items for select to authenticated using (
  exists (select 1 from public.delivery_notes d where d.id = dn_id and can_see_dn(d.hq_code, d.branch_id, d.status)));

create or replace view public.delivery_notes_v with (security_invoker = true) as
  select d.*, b.name as branch_name, b.short_name as branch_short, h.name as hq_name
  from public.delivery_notes d join public.branches b on b.id = d.branch_id join public.hqs h on h.code = d.hq_code;

create or replace function public.branch_doc_code(p_branch uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(nullif(code, ''), regexp_replace(upper(short_name), '[^A-Z0-9 ]', '', 'g')) from branches where id = p_branch
$$;

-- PRS items: requested, delivered so far on dispatched notes (other than p_exclude), remaining
create or replace function public.prs_remaining(p_prs uuid, p_exclude uuid default null)
returns table (line_no int, description text, unit text, requested numeric, delivered numeric, remaining numeric)
language plpgsql stable security definer set search_path = public as $$
declare got jsonb := '{}'; k text; r record; d numeric;
begin
  for r in select item_key(coalesce(nullif(i.for_description, ''), i.description)) as key, sum(i.qty) as q
           from dn_items i join delivery_notes n on n.id = i.dn_id
           where n.prs_id = p_prs and n.status <> 'Prepared' and n.id is distinct from p_exclude group by 1 loop
    got := got || jsonb_build_object(r.key, r.q);
  end loop;
  for r in select * from prs_items where prs_id = p_prs order by prs_items.line_no loop
    k := item_key(r.description);
    d := least(r.qty, coalesce((got->>k)::numeric, 0));
    got := got || jsonb_build_object(k, coalesce((got->>k)::numeric, 0) - d);
    line_no := r.line_no; description := r.description; unit := r.unit;
    requested := r.qty; delivered := d; remaining := greatest(0, r.qty - d);
    return next;
  end loop;
end $$;

-- HQ: items of an approved PRS to start a Delivery Note
create or replace function public.dn_prs_lookup(p_prs_no text, p_editing uuid default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r prs; v_b branches;
begin
  perform require_type('HQ');
  select * into r from prs where upper(control_no) = upper(trim(coalesce(p_prs_no, '')));
  if r.id is null then return jsonb_build_object('ok', false, 'msg', 'PRS ' || coalesce(p_prs_no, '') || ' is not in the PRS log.'); end if;
  if not can_see_prs(r.branch_id, r.status, r.sent_to_hq_at) or not (r.hq_code = any (my_hqs())) then
    return jsonb_build_object('ok', false, 'msg', 'This PRS is not for your HQ.');
  end if;
  select * into v_b from branches where id = r.branch_id;
  return jsonb_build_object('ok', true, 'prs', jsonb_build_object('id', r.id, 'no', r.control_no, 'date', r.prs_date, 'branchId', r.branch_id,
    'branch', v_b.name, 'hq', r.hq_code, 'status', r.status,
    'earlier', (select coalesce(jsonb_agg(dn_no order by dn_no), '[]') from delivery_notes
                where prs_id = r.id and status <> 'Prepared' and id is distinct from p_editing),
    'items', (select coalesce(jsonb_agg(jsonb_build_object('qty', x.remaining, 'requested', x.requested, 'delivered', x.delivered,
                'unit', x.unit, 'desc', x.description) order by x.line_no), '[]') from prs_remaining(r.id, p_editing) x)));
end $$;

-- HQ saves a Delivery Note; p_dispatch = true releases it to the branch.
-- p: { id?, prsNo, prsDate, branchId, date, mode, rider, preparedBy, approvedBy, remarks, prsStatus,
--      items:[{qty, unit, desc, batch, expiry, forDesc}] }
-- Quantity 0 / blank = not available now: left off the note, listed in Remarks; the PRS becomes Partially Served.
create or replace function public.dn_save(p jsonb, p_dispatch boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_hq text := (my_hqs())[1]; d delivery_notes; v_id uuid; v_no text; v_branch branches; v_prs prs;
        it jsonb; v_items jsonb := '[]'; v_lines int := 0; q text; v_desc text; v_for text; v_batch text; b batches;
        v_need jsonb := '{}'; v_have numeric; v_now jsonb := '{}'; v_pending text[] := '{}'; v_subs text[] := '{}';
        v_status text; v_rem text; r record; v_give numeric; v_k text; n int := 0; v_date date;
begin
  perform require_type('HQ');
  begin v_date := (p->>'date')::date; exception when others then v_date := null; end;
  if v_date is null then raise exception 'Enter the delivery date.'; end if;
  select * into v_branch from branches where id = nullif(p->>'branchId', '')::uuid;
  if v_branch.id is null then raise exception 'Choose the destination branch.'; end if;
  if v_branch.hq_code <> v_hq then raise exception 'That branch is not under your HQ.'; end if;

  for it in select * from jsonb_array_elements(coalesce(p->'items', '[]')) loop
    q := trim(coalesce(it->>'qty', ''));
    v_desc := left(trim(coalesce(it->>'desc', '')), 200);
    if q = '' and v_desc = '' then continue; end if;
    if v_desc = '' then raise exception 'Every item needs a description.'; end if;
    if q <> '' and (q !~ '^\d+(\.\d+)?$') then raise exception 'Check the quantity of %.', v_desc; end if;
    if q = '' or q::numeric = 0 then continue; end if;          -- not available now
    v_for := left(trim(coalesce(it->>'forDesc', '')), 200);
    if item_key(v_for) = item_key(v_desc) then v_for := ''; end if;
    v_items := v_items || jsonb_build_object('qty', q::numeric, 'unit', left(trim(coalesce(it->>'unit', '')), 30), 'desc', v_desc,
      'batch', upper(trim(coalesce(it->>'batch', ''))), 'expiry', nullif(it->>'expiry', ''), 'forDesc', v_for);
  end loop;
  v_lines := jsonb_array_length(v_items);
  if v_lines = 0 then raise exception 'Nothing to deliver — enter the quantity you can send for at least one item.'; end if;
  if v_lines > 40 then raise exception 'Up to 40 items per delivery note.'; end if;

  if nullif(p->>'id', '') is not null then
    select * into d from delivery_notes where id = (p->>'id')::uuid for update;
    if d.id is null then raise exception 'Delivery note not found.'; end if;
    if d.hq_code <> v_hq then raise exception 'This delivery note belongs to another HQ.'; end if;
    if d.status <> 'Prepared' then raise exception 'This delivery note was already dispatched and can no longer be edited.'; end if;
  end if;

  -- every batch must be in this HQ's inventory with enough on hand (checked on dispatch)
  if p_dispatch then
    for it in select * from jsonb_array_elements(v_items) loop
      if it->>'batch' = '' or it->>'expiry' is null and not exists (select 1 from batches where batch_no = it->>'batch') then
        raise exception 'Fill in the Batch No. and Expiry Date of every item before dispatching (%).', it->>'desc';
      end if;
      select * into b from batches where batch_no = it->>'batch';
      if b.batch_no is null then
        raise exception 'Batch % (%) is not in your HQ inventory. Receive it in the Inventory tab first, or pick a batch from the list.', it->>'batch', it->>'desc';
      end if;
      if b.expiry < mnl_today() then raise exception 'Batch % (%) is EXPIRED and cannot be delivered.', b.batch_no, it->>'desc'; end if;
      v_need := v_need || jsonb_build_object(b.batch_no, coalesce((v_need->>b.batch_no)::numeric, 0) + (it->>'qty')::numeric);
      v_have := stock_at('HQ:' || v_hq, b.batch_no);
      if (v_need->>b.batch_no)::numeric > v_have then
        raise exception 'Only % of batch % left at your HQ.', v_have, b.batch_no;
      end if;
    end loop;
    -- the inventory's expiry wins
    select jsonb_agg(e.x || jsonb_build_object('expiry', (select expiry from batches where batch_no = e.x->>'batch')) order by e.n) into v_items
      from jsonb_array_elements(v_items) with ordinality as e(x, n);
  end if;

  -- PRS (optional; kept as typed when it is not in the log)
  if nullif(trim(coalesce(p->>'prsNo', '')), '') is not null then
    select * into v_prs from prs where upper(control_no) = upper(trim(p->>'prsNo')) and hq_code = v_hq;
  end if;
  v_rem := regexp_replace(coalesce(p->>'remarks', ''), '\s*(·\s*)?Not delivered \(no stock yet\):.*$', '', 'i');
  v_rem := trim(regexp_replace(v_rem, '\s*(·\s*)?Sent instead:[^·]*', '', 'i'));
  if v_prs.id is not null then
    for it in select * from jsonb_array_elements(v_items) loop
      v_k := item_key(coalesce(nullif(it->>'forDesc', ''), it->>'desc'));
      v_now := v_now || jsonb_build_object(v_k, coalesce((v_now->>v_k)::numeric, 0) + (it->>'qty')::numeric);
    end loop;
    for r in select * from prs_remaining(v_prs.id, d.id) loop
      v_k := item_key(r.description);
      v_give := least(r.remaining, coalesce((v_now->>v_k)::numeric, 0));
      v_now := v_now || jsonb_build_object(v_k, coalesce((v_now->>v_k)::numeric, 0) - v_give);
      if r.remaining - v_give > 0 then v_pending := v_pending || (r.description || ' ' || (r.remaining - v_give) || coalesce(' ' || nullif(r.unit, ''), '')); end if;
    end loop;
  end if;
  v_status := case when p->>'prsStatus' in ('Served', 'Partially Served') then p->>'prsStatus'
                   when cardinality(v_pending) > 0 then 'Partially Served' else 'Served' end;
  select coalesce(array_agg((e.x->>'desc') || ' for ' || (e.x->>'forDesc')), '{}') into v_subs
    from jsonb_array_elements(v_items) as e(x) where e.x->>'forDesc' <> '';
  if cardinality(v_subs) > 0 then v_rem := concat_ws(' · ', nullif(v_rem, ''), 'Sent instead: ' || array_to_string(v_subs, ', ')); end if;
  if cardinality(v_pending) > 0 and v_status = 'Partially Served' then
    v_rem := concat_ws(' · ', nullif(v_rem, ''), 'Not delivered (no stock yet): ' || array_to_string(v_pending, ', '));
  end if;

  if d.id is null then
    v_no := next_doc_no(v_hq || ' HQ');
    insert into delivery_notes (dn_no, delivery_date, hq_code, branch_id, created_by) values (v_no, v_date, v_hq, v_branch.id, auth.uid())
    returning * into d;
  end if;
  update delivery_notes set delivery_date = v_date, branch_id = v_branch.id,
         prs_id = v_prs.id, prs_no = nullif(trim(coalesce(p->>'prsNo', '')), ''),
         prs_date = coalesce(nullif(p->>'prsDate', '')::date, v_prs.prs_date),
         prepared_by = left(coalesce(nullif(trim(p->>'preparedBy'), ''), my_name()), 80),
         approved_by = left(trim(coalesce(p->>'approvedBy', '')), 80),
         remarks = left(nullif(v_rem, ''), 900), mode = left(trim(coalesce(p->>'mode', '')), 40),
         rider = left(trim(coalesce(p->>'rider', '')), 120),
         status = case when p_dispatch then 'Dispatched' else 'Prepared' end,
         dispatched_at = case when p_dispatch then now() end
   where id = d.id;
  delete from dn_items where dn_id = d.id;
  for it in select * from jsonb_array_elements(v_items) loop
    n := n + 1;
    insert into dn_items (dn_id, line_no, qty, unit, description, batch_no, expiry, for_description)
    values (d.id, n, (it->>'qty')::numeric, it->>'unit', it->>'desc', nullif(it->>'batch', ''), nullif(it->>'expiry', '')::date, nullif(it->>'forDesc', ''));
  end loop;

  if p_dispatch then
    insert into stock_moves (moved_on, batch_no, qty, from_loc, to_loc, kind, ref, note, dn_id, created_by)
    select v_date, batch_no, qty, 'HQ:' || v_hq, 'BR:' || v_branch.id::text, 'DISPATCH', coalesce(v_prs.control_no, d.dn_no), 'DN ' || d.dn_no, d.id, auth.uid()
      from dn_items where dn_id = d.id;
    if v_prs.id is not null then
      update prs set status = v_status::prs_status, date_served = v_date,
             dn_numbers = case when d.dn_no = any (dn_numbers) then dn_numbers else dn_numbers || d.dn_no end, updated_at = now()
       where id = v_prs.id;
    end if;
  end if;
  perform log_event(case when p_dispatch then 'DN DISPATCHED ' else 'DN SAVED ' end || d.dn_no);
  return jsonb_build_object('ok', true, 'id', d.id, 'no', d.dn_no, 'msg',
    case when p_dispatch then 'Delivery note ' || d.dn_no || ' dispatched to ' || v_branch.name || '. Stock deducted from your HQ inventory.' ||
           case when v_prs.id is not null then ' PRS ' || v_prs.control_no || ' marked ' || v_status || '.' ||
             case when cardinality(v_pending) > 0 and v_status = 'Partially Served' then ' Still to deliver: ' || array_to_string(v_pending, ', ') || '.' else '' end
           when nullif(trim(coalesce(p->>'prsNo', '')), '') is not null then ' (PRS ' || trim(p->>'prsNo') || ' is not in the PRS log, so it was kept on the note as typed.)'
           else '' end
         else 'Delivery note ' || d.dn_no || ' saved. Dispatch it when the supplies leave the HQ.' end);
end $$;

-- Branch submits the Receiving Report. p: { receiptDate, receivedBy, witness, remarks, items:[{rQty, rBatch, rExpiry, condition, note}] }
create or replace function public.rr_submit(p_dn uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d delivery_notes; v_b branches; it record; g jsonb; v_disc text[] := '{}'; v_probs text[]; v_rq numeric; v_cond text;
        v_rb text; v_re date; v_rr text; v_status text; v_date date; v_by text; n int; v_html text := '';
        v_conds text[] := array['Good', 'Short', 'Damaged', 'Expired / near expiry', 'Wrong item', 'Not delivered'];
begin
  perform require_type('Branch');
  begin v_date := (p->>'receiptDate')::date; exception when others then v_date := null; end;
  if v_date is null then raise exception 'Enter the receipt date.'; end if;
  v_by := left(trim(coalesce(p->>'receivedBy', '')), 80);
  if v_by = '' then raise exception 'Enter who received the delivery.'; end if;
  select * into d from delivery_notes where id = p_dn for update;
  if d.id is null or d.branch_id <> my_branch() then raise exception 'This delivery is for another branch.'; end if;
  if d.status = 'Prepared' then raise exception 'This delivery has not been dispatched yet.'; end if;
  if d.rr_no is not null then raise exception 'A receiving report (%) was already submitted for this delivery.', d.rr_no; end if;
  select count(*) into n from dn_items where dn_id = d.id;
  if jsonb_array_length(coalesce(p->'items', '[]')) <> n then raise exception 'Fill in every item line.'; end if;

  for it in select * from dn_items where dn_id = d.id order by line_no loop
    g := p->'items'->(it.line_no - 1);
    if coalesce(trim(g->>'rQty'), '') !~ '^\d+(\.\d+)?$' then raise exception 'Enter the quantity received for %.', it.description; end if;
    v_rq := (g->>'rQty')::numeric;
    v_cond := case when g->>'condition' = any (v_conds) then g->>'condition' else 'Good' end;
    v_rb := upper(left(trim(coalesce(g->>'rBatch', '')), 60));
    v_re := nullif(g->>'rExpiry', '')::date;
    v_probs := '{}';
    if v_rq <> it.qty then v_probs := v_probs || ((case when v_rq < it.qty then 'short ' else 'over ' end) || abs(it.qty - v_rq) || coalesce(' ' || it.unit, '')); end if;
    if v_cond <> 'Good' then v_probs := v_probs || lower(v_cond); end if;
    if v_rb <> '' and it.batch_no is not null and v_rb <> upper(it.batch_no) then v_probs := v_probs || ('batch ' || v_rb || ' (DN ' || it.batch_no || ')'); end if;
    if v_re is not null and it.expiry is not null and v_re <> it.expiry then v_probs := v_probs || ('expiry ' || v_re || ' (DN ' || it.expiry || ')'); end if;
    if cardinality(v_probs) > 0 then v_disc := v_disc || (it.description || ': ' || array_to_string(v_probs, ', ')); end if;
    update dn_items set r_qty = v_rq, r_batch = coalesce(nullif(v_rb, ''), batch_no), r_expiry = coalesce(v_re, expiry),
           condition = v_cond, note = nullif(left(trim(coalesce(g->>'note', '')), 200), '')
     where id = it.id;
    v_html := v_html || '<tr><td>' || esc(it.description) || '</td><td>' || esc(it.unit) || '</td><td align="right">' || it.qty ||
              '</td><td align="right">' || v_rq || '</td><td>' || esc(coalesce(nullif(v_rb, ''), it.batch_no)) || '</td><td>' || esc(v_cond) || '</td></tr>';
  end loop;
  v_rr := next_doc_no(branch_doc_code(d.branch_id) || ' BRR');
  v_status := case when cardinality(v_disc) > 0 then 'Received – with discrepancy' else 'Received' end;
  update delivery_notes set status = v_status, rr_no = v_rr, received_date = v_date, received_by = v_by,
         witness = nullif(left(trim(coalesce(p->>'witness', '')), 80), ''), discrepancy = nullif(array_to_string(v_disc, ' · '), ''),
         rr_remarks = nullif(left(trim(coalesce(p->>'remarks', '')), 500), ''), rr_submitted_at = now(), rr_submitted_by = auth.uid()
   where id = d.id;
  select * into v_b from branches where id = d.branch_id;
  perform queue_email(array[hq_email(d.hq_code), director_email()], '{}',
    'Receiving Report ' || v_rr || ' — ' || v_b.name || case when cardinality(v_disc) > 0 then ' (with discrepancy)' else '' end,
    mail_wrap('Receiving Report ' || v_rr,
      '<p>From <b>' || esc(v_b.name) || '</b> for Delivery Note ' || esc(d.dn_no) || ' (PRS ' || esc(coalesce(d.prs_no, '—')) || ')</p>' ||
      '<p>Receipt date: ' || v_date || ' · Received by: ' || esc(v_by) || '</p>' ||
      case when cardinality(v_disc) > 0 then '<p style="color:#A9242A"><b>Discrepancies:</b><br>' || esc(array_to_string(v_disc, ' · ')) || '</p>'
           else '<p style="color:#1b6b34"><b>All items received in good order.</b></p>' end ||
      '<table cellpadding="6" cellspacing="0" border="1" style="border-collapse:collapse;font-size:13px"><tr style="background:#1E3A8A;color:#fff">' ||
      '<th>Description</th><th>Unit</th><th>Qty sent</th><th>Qty received</th><th>Batch</th><th>Condition</th></tr>' || v_html || '</table>'));
  perform log_event('RR SUBMITTED ' || v_rr || ' for ' || d.dn_no);
  return jsonb_build_object('ok', true, 'rr', v_rr, 'status', v_status, 'msg', 'Receiving report ' || v_rr || ' submitted' ||
    case when cardinality(v_disc) > 0 then ' with ' || cardinality(v_disc) || ' discrepanc' || case when cardinality(v_disc) = 1 then 'y' else 'ies' end else '' end || '.');
end $$;

-- HQ that sent it, or the Supply Office (Admin), validates a received delivery → posted to the branch stock card
create or replace function public.dn_validate(p_dn uuid, p_note text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d delivery_notes; t user_type := require_type('Admin', 'HQ'); v_who text; v_note text := trim(coalesce(p_note, '')); v_sc text;
begin
  select * into d from delivery_notes where id = p_dn for update;
  if d.id is null then raise exception 'Delivery note not found.'; end if;
  if t = 'HQ' and not (d.hq_code = any (my_hqs())) then raise exception 'This delivery note belongs to another HQ.'; end if;
  if d.rr_no is null then raise exception 'The branch has not submitted the receiving report yet.'; end if;
  if d.status = 'Validated' then raise exception 'Receiving report % was already validated by %.', d.rr_no, coalesce(d.validated_by, 'someone'); end if;
  if d.discrepancy is not null and v_note = '' then
    raise exception 'This receiving report has a discrepancy (%). Write the action taken before validating.', d.discrepancy;
  end if;
  v_who := my_name() || case when t = 'HQ' then ' (' || d.hq_code || ' HQ)' else ' (Supply Office)' end;
  update delivery_notes set status = 'Validated', validated_by = v_who, validated_at = now(),
         rr_remarks = case when v_note <> '' then concat_ws(' · ', nullif(rr_remarks, ''),
                        case when t = 'HQ' then 'HQ: ' else 'Supply Office: ' end || left(v_note, 300)) else rr_remarks end
   where id = d.id;
  v_sc := sc_post_delivery(d.id);
  perform log_event('RR VALIDATED ' || d.rr_no);
  return jsonb_build_object('ok', true, 'msg', 'Receiving report ' || d.rr_no || ' (' || d.dn_no || ') validated by ' || v_who || '.' || v_sc);
end $$;

-- =====================================================================
-- Stockcard: supplies received / consumed per branch, per day
-- =====================================================================
create table public.sc_items (
  id            bigserial primary key,
  name          text not null,
  category      text not null default 'Supplies' check (category in ('Supplies', 'Vaccine', 'Meds')),
  description   text,
  unit          text,
  reorder_point numeric,
  sku           text references public.products(sku) on delete set null,
  active        boolean not null default true,
  added_by      text
);
create unique index sc_items_name_uq on public.sc_items (item_key(name));

create table public.sc_entries (
  id         bigserial primary key,
  branch_id  uuid not null references public.branches(id) on delete cascade,
  entry_date date not null,
  item_id    bigint not null references public.sc_items(id),
  batch_no   text,
  source     text,                       -- ordered / borrowed from
  received   numeric not null default 0 check (received >= 0),
  consumed   numeric not null default 0 check (consumed >= 0),
  remarks    text,
  expiry     date,
  kind       text not null check (kind in ('DAILY', 'BEGIN', 'DN')),
  dn_id      uuid references public.delivery_notes(id) on delete cascade,
  logged_at  timestamptz not null default now(),
  logged_by  text
);
create unique index sc_one_daily on public.sc_entries (branch_id, entry_date, item_id) where kind = 'DAILY';
create unique index sc_one_begin on public.sc_entries (branch_id, item_id) where kind = 'BEGIN';
create index on public.sc_entries (branch_id, entry_date);

create table public.sc_locks (
  scope  text primary key,               -- 'ALL' or a branch id
  locked boolean not null default false,
  set_by text,
  set_at timestamptz not null default now()
);

alter table public.sc_items enable row level security;
alter table public.sc_entries enable row level security;
alter table public.sc_locks enable row level security;
create policy sc_items_read on public.sc_items for select to authenticated using (me_type() is not null);
create policy sc_items_admin on public.sc_items for all to authenticated using (is_admin()) with check (is_admin());
create policy sc_entries_read on public.sc_entries for select to authenticated using (can_see_branch(branch_id));
create policy sc_locks_read on public.sc_locks for select to authenticated using (me_type() is not null);

create or replace view public.sc_balances with (security_invoker = true) as
  select e.branch_id, e.item_id, sum(e.received - e.consumed) as balance, max(e.entry_date) as last_entry
  from public.sc_entries e group by e.branch_id, e.item_id;

-- every product of the Central Warehouse is also a stock card item
create or replace function public.sc_sync_product() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from sc_items where sku = new.sku or item_key(name) = item_key(new.name)) then
    insert into sc_items (name, category, unit, sku, added_by)
    values (new.name, case when upper(new.category) like 'VACC%' then 'Vaccine' when upper(new.category) like 'MED%' and upper(new.category) not like '%SUPPL%' then 'Meds' else 'Supplies' end,
            new.uom, new.sku, 'Products list (inventory)');
  end if;
  return new;
end $$;
create trigger products_sc_sync after insert on public.products for each row execute function public.sc_sync_product();

create or replace function public.sc_lock_state(p_branch uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select jsonb_build_object('locked', true, 'by', set_by, 'at', set_at, 'all', true) from sc_locks where scope = 'ALL' and locked),
    (select jsonb_build_object('locked', true, 'by', set_by, 'at', set_at, 'all', false) from sc_locks where scope = p_branch::text and locked),
    jsonb_build_object('locked', false))
$$;

-- Raises if any item's running balance at the branch goes below zero on any day
create or replace function public.sc_check_negative(p_branch uuid, p_items bigint[]) returns void
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  select s.item_id, s.entry_date, s.run, s.received, s.consumed into r from (
    select item_id, entry_date, received, consumed,
           sum(received - consumed) over (partition by item_id order by entry_date, (kind <> 'BEGIN'), id) as run
    from sc_entries where branch_id = p_branch and item_id = any (p_items)) s
  where s.run < -0.0001 order by s.entry_date limit 1;
  if r.item_id is not null then
    raise exception '%: consumed is more than the balance on % (% left). Enter the beginning balance or what was received first.',
      (select name from sc_items where id = r.item_id), r.entry_date, round(r.run + r.consumed - r.received, 2);
  end if;
end $$;

-- Branch saves one day. p_lines: [{item, batch, from, received, consumed, remarks}] (item = item name)
create or replace function public.sc_save_day(p_date date, p_lines jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_b uuid := my_branch(); v_today date := mnl_today(); lk jsonb; l jsonb; it sc_items; v_rec numeric; v_con numeric;
        v_ids bigint[] := '{}'; v_blank boolean; v_who text; v_low text[];
begin
  perform require_type('Branch');
  if v_b is null then raise exception 'Your account is not linked to a branch.'; end if;
  if p_date is null then raise exception 'Choose the date.'; end if;
  if p_date > v_today then raise exception 'The date cannot be in the future.'; end if;
  lk := sc_lock_state(v_b);
  if (lk->>'locked')::boolean and p_date <> v_today then
    raise exception 'Editing past days is locked by %. You can still enter today. Ask your RNS to unlock it for corrections.', coalesce(lk->>'by', 'your RNS / Admin');
  end if;
  if p_date < v_today - 31 then raise exception 'Only the last 31 days can be entered or corrected. Ask the Admin for older corrections.'; end if;
  select 'Portal · ' || username into v_who from app_users where id = auth.uid();
  for l in select * from jsonb_array_elements(coalesce(p_lines, '[]')) loop
    select * into it from sc_items where item_key(name) = item_key(l->>'item') and active;
    if it.id is null then continue; end if;
    begin
      v_rec := coalesce(nullif(trim(coalesce(l->>'received', '')), '')::numeric, 0);
      v_con := coalesce(nullif(trim(coalesce(l->>'consumed', '')), '')::numeric, 0);
    exception when others then raise exception 'Check the quantities of %.', it.name; end;
    if v_rec < 0 or v_con < 0 then raise exception 'Check the quantities of % (no negative numbers).', it.name; end if;
    v_blank := v_rec = 0 and v_con = 0 and trim(coalesce(l->>'remarks', '')) = '' and trim(coalesce(l->>'from', '')) = ''
               and trim(coalesce(l->>'batch', '')) = '';
    v_ids := v_ids || it.id;
    if v_blank then
      delete from sc_entries where branch_id = v_b and entry_date = p_date and item_id = it.id and kind = 'DAILY';
    else
      insert into sc_entries (branch_id, entry_date, item_id, batch_no, source, received, consumed, remarks, kind, logged_at, logged_by)
      values (v_b, p_date, it.id, nullif(left(trim(coalesce(l->>'batch', '')), 120), ''), nullif(left(trim(coalesce(l->>'from', '')), 120), ''),
              v_rec, v_con, nullif(left(trim(coalesce(l->>'remarks', '')), 300), ''), 'DAILY', now(), v_who)
      on conflict (branch_id, entry_date, item_id) where kind = 'DAILY' do update set
        batch_no = excluded.batch_no, source = excluded.source, received = excluded.received, consumed = excluded.consumed,
        remarks = excluded.remarks, logged_at = now(), logged_by = excluded.logged_by;
    end if;
  end loop;
  if cardinality(v_ids) = 0 then raise exception 'Nothing to save.'; end if;
  perform sc_check_negative(v_b, v_ids);
  select coalesce(array_agg(i.name order by i.name), '{}') into v_low from sc_balances s join sc_items i on i.id = s.item_id
   where s.branch_id = v_b and (s.balance <= 0 or (i.reorder_point is not null and s.balance <= i.reorder_point));
  perform log_event('STOCKCARD ' || p_date);
  return jsonb_build_object('ok', true, 'msg', 'Stock card for ' || to_char(p_date, 'Mon FMDD, YYYY') || ' saved.' ||
    case when cardinality(v_low) > 0 then ' Low or out of stock: ' || array_to_string(v_low, ', ') || ' — request it on a PRS.' else '' end);
end $$;

-- Branch sets / edits the beginning balance of one item. p: { item, qty, date, batch, expiry, remarks }
create or replace function public.sc_save_begin(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_b uuid := my_branch(); lk jsonb; it sc_items; v_qty numeric; v_date date; v_exists boolean;
begin
  perform require_type('Branch');
  if v_b is null then raise exception 'Your account is not linked to a branch.'; end if;
  lk := sc_lock_state(v_b);
  if (lk->>'locked')::boolean then
    raise exception 'Editing is locked by %. Ask your RNS to unlock it to change the beginning balance.', coalesce(lk->>'by', 'your RNS / Admin');
  end if;
  select * into it from sc_items where item_key(name) = item_key(p->>'item') and active;
  if it.id is null then raise exception 'Choose the item.'; end if;
  begin v_qty := (p->>'qty')::numeric; exception when others then v_qty := null; end;
  if v_qty is null or v_qty < 0 then raise exception 'Enter the beginning balance (0 or more).'; end if;
  begin v_date := (p->>'date')::date; exception when others then v_date := null; end;
  if v_date is null or v_date > mnl_today() then raise exception 'Enter the date of the count (today or earlier).'; end if;
  select exists (select 1 from sc_entries where branch_id = v_b and item_id = it.id and kind = 'BEGIN') into v_exists;
  insert into sc_entries (branch_id, entry_date, item_id, batch_no, source, received, consumed, remarks, expiry, kind, logged_at, logged_by)
  values (v_b, v_date, it.id, nullif(left(trim(coalesce(p->>'batch', '')), 120), ''), 'Physical count', v_qty, 0,
          left('Beginning balance' || coalesce(' — ' || nullif(trim(p->>'remarks'), ''), ''), 300), nullif(p->>'expiry', '')::date,
          'BEGIN', now(), 'Portal · ' || (select username from app_users where id = auth.uid()))
  on conflict (branch_id, item_id) where kind = 'BEGIN' do update set entry_date = excluded.entry_date, batch_no = excluded.batch_no,
    received = excluded.received, remarks = excluded.remarks, expiry = excluded.expiry, logged_at = now(), logged_by = excluded.logged_by;
  perform sc_check_negative(v_b, array[it.id]);
  perform log_event('STOCKCARD BEGIN ' || it.name || ' ' || v_qty);
  return jsonb_build_object('ok', true, 'msg', 'Beginning balance of ' || it.name || ' ' || case when v_exists then 'updated' else 'set' end ||
    ' to ' || v_qty || coalesce(' ' || nullif(it.unit, ''), '') || ' as of ' || to_char(v_date, 'Mon FMDD, YYYY') || '.');
end $$;

-- Branch / Admin adds an item that is not in the list. p: { name, category, unit, desc, reorder }
create or replace function public.sc_add_item(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t user_type := require_type('Branch', 'Admin'); v_name text := left(regexp_replace(trim(coalesce(p->>'name', '')), '\s+', ' ', 'g'), 80);
        dup sc_items;
begin
  if v_name = '' then raise exception 'Enter the item name.'; end if;
  select * into dup from sc_items where item_key(name) = item_key(v_name);
  if dup.id is not null then
    if not dup.active then raise exception '"%" is in the list but switched off. Ask the Admin to turn it back on.', dup.name; end if;
    raise exception '"%" is already in the list.', dup.name;
  end if;
  insert into sc_items (name, category, description, unit, reorder_point, active, added_by)
  values (v_name, case when p->>'category' in ('Supplies', 'Vaccine', 'Meds') then p->>'category' else 'Supplies' end,
          nullif(left(trim(coalesce(p->>'desc', '')), 120), ''), nullif(left(trim(coalesce(p->>'unit', '')), 40), ''),
          case when t = 'Admin' then nullif(p->>'reorder', '')::numeric end, true,
          (select display_name from app_users where id = auth.uid()) || ' · ' || to_char(mnl_today(), 'Mon FMDD, YYYY'));
  perform log_event('STOCKCARD ITEM ' || v_name);
  return jsonb_build_object('ok', true, 'msg', v_name || ' added to the stock card list' ||
    case when t = 'Branch' then ' for every branch. The Admin can set its reorder point.' else '.' end);
end $$;

-- RNS (own branches) / Admin (any branch, or 'ALL'): lock editing of past days and beginning balances
create or replace function public.sc_set_lock(p_scope text, p_locked boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t user_type := require_type('RNS', 'Admin'); v_all boolean := p_scope = 'ALL'; v_name text;
begin
  if v_all and t <> 'Admin' then raise exception 'Only the Admin locks all branches at once.'; end if;
  if not v_all then
    if not can_see_branch(p_scope::uuid) then raise exception 'That branch is not in your scope.'; end if;
    select name into v_name from branches where id = p_scope::uuid;
  end if;
  insert into sc_locks (scope, locked, set_by, set_at) values (p_scope, p_locked, my_name() || ' (' || t || ')', now())
  on conflict (scope) do update set locked = excluded.locked, set_by = excluded.set_by, set_at = now();
  perform log_event('STOCKCARD ' || case when p_locked then 'LOCK ' else 'UNLOCK ' end || coalesce(v_name, 'ALL'));
  return jsonb_build_object('ok', true, 'msg', coalesce(v_name, 'All branches') || ': ' ||
    case when p_locked then 'editing locked. Branches can still enter today, but cannot change past days or beginning balances.'
         else 'editing unlocked.' end);
end $$;

-- Validated delivery → branch stock card ("Received"). Re-posting replaces the same DN.
-- Lines received as Damaged / Expired / Wrong item / Not delivered are not usable stock and are skipped.
create or replace function public.sc_post_delivery(p_dn uuid) returns text
language plpgsql security definer set search_path = public as $$
declare d delivery_notes; l dn_items; it sc_items; v_sku text; v_q numeric; v_posted int := 0; v_skipped text[] := '{}'; v_added text[] := '{}';
begin
  select * into d from delivery_notes where id = p_dn;
  delete from sc_entries where dn_id = d.id and kind = 'DN';
  for l in select * from dn_items where dn_id = d.id order by line_no loop
    v_q := coalesce(l.r_qty, l.qty);
    if v_q <= 0 then continue; end if;
    if coalesce(l.condition, '') ~* 'damaged|expired|wrong item|not delivered' then
      v_skipped := v_skipped || (l.description || ' (' || l.condition || ')'); continue;
    end if;
    select sku into v_sku from batches where batch_no = upper(coalesce(l.r_batch, l.batch_no, ''));
    it := null;
    if v_sku is not null then select * into it from sc_items where sku = v_sku and active limit 1; end if;
    if it.id is null then select * into it from sc_items where item_key(name) = item_key(l.description) limit 1; end if;
    if it.id is null then
      select * into it from sc_items where length(item_key(name)) >= 4
        and (item_key(l.description) like '%' || item_key(name) || '%' or item_key(name) like '%' || item_key(l.description) || '%')
        order by length(name) desc limit 1;
    end if;
    if it.id is null then
      insert into sc_items (name, category, description, unit, sku, added_by)
      values (left(l.description, 80), 'Supplies', 'Added from HQ · DN ' || d.dn_no, l.unit, v_sku, 'Auto · DN ' || d.dn_no) returning * into it;
      v_added := v_added || it.name;
    end if;
    insert into sc_entries (branch_id, entry_date, item_id, batch_no, source, received, consumed, remarks, expiry, kind, dn_id, logged_by)
    values (d.branch_id, coalesce(d.received_date, mnl_today()), it.id, coalesce(l.r_batch, l.batch_no), 'HQ · DN ' || d.dn_no, v_q, 0,
            left(case when coalesce(l.condition, 'Good') <> 'Good' then l.condition || ' · ' else '' end || 'RR ' || coalesce(d.rr_no, ''), 300),
            coalesce(l.r_expiry, l.expiry), 'DN', d.id, 'Portal · auto (validated)');
    v_posted := v_posted + 1;
  end loop;
  return ' Stock card: ' || case when v_posted > 0 then v_posted || ' item(s) added as received' else 'nothing to add' end ||
    case when cardinality(v_added) > 0 then ' (new item(s) in the list: ' || array_to_string(v_added, ', ') || ')' else '' end ||
    case when cardinality(v_skipped) > 0 then '; not added: ' || array_to_string(v_skipped, ', ') else '' end || '.';
end $$;
