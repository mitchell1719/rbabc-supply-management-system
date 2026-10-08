-- End-to-end workflow test. Runs every role through the main flows under RLS.
-- Applied by supabase/tests/run.sh after the stub, migrations and seed.
\set ON_ERROR_STOP 1
\pset tuples_only on
\o /dev/null

-- ---------------------------------------------------------------- accounts
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'supply.office@rbabc.local'),
  ('00000000-0000-0000-0000-0000000000c1', 'cebu.hq@rbabc.local'),
  ('00000000-0000-0000-0000-0000000000d1', 'davao.hq@rbabc.local'),
  ('00000000-0000-0000-0000-0000000000a5', 'rns.dalapo@rbabc.local'),
  ('00000000-0000-0000-0000-0000000000b1', 'danao@rbabc.local'),
  ('00000000-0000-0000-0000-0000000000b2', 'liloan@rbabc.local'),
  ('00000000-0000-0000-0000-0000000000f1', 'finance@rbabc.local');
insert into public.app_users (id, username, display_name, type, hq_codes, branch_id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'SUPPLY OFFICE', 'Supply Office', 'Admin', '{}', null, 'admin@example.com'),
  ('00000000-0000-0000-0000-0000000000c1', 'CEBU HQ', 'Cebu HQ', 'HQ', '{CEBU}', null, 'cebu@example.com'),
  ('00000000-0000-0000-0000-0000000000d1', 'DAVAO HQ', 'Davao HQ', 'HQ', '{DAVAO}', null, 'davao@example.com'),
  ('00000000-0000-0000-0000-0000000000a5', 'RNS DALAPO', 'Angelene Q. Dalapo', 'RNS', '{CEBU}', null, 'rns@example.com'),
  ('00000000-0000-0000-0000-0000000000b1', 'DANAO', 'RB ABC Danao Inc.', 'Branch', '{}', (select id from branches where short_name = 'DANAO'), null),
  ('00000000-0000-0000-0000-0000000000b2', 'LILOAN', 'RB ABC Liloan Inc.', 'Branch', '{}', (select id from branches where short_name = 'LILOAN'), null),
  ('00000000-0000-0000-0000-0000000000f1', 'FINANCE', 'Finance Department', 'Finance', '{}', null, 'finance@example.com');
update branches set rns_user_id = '00000000-0000-0000-0000-0000000000a5' where short_name in ('DANAO', 'LILOAN');
update app_settings set value = '"https://portal.example.com"' where key = 'portal_url';
update attendance_sites set lat = 10.3157, lng = 123.8854, radius = 100 where name = 'CEBU HQ';

create or replace function pg_temp.check(cond boolean, what text) returns void language plpgsql as $$
begin if not coalesce(cond, false) then raise exception 'TEST FAILED: %', what; end if; end $$;
-- runs sql as the current role and expects it to fail with a message matching pattern
create or replace function pg_temp.expect_error(sql text, pattern text) returns void language plpgsql as $$
begin
  execute sql;
  raise exception 'TEST FAILED: expected an error like "%" from: %', pattern, sql;
exception when others then
  if sqlerrm like 'TEST FAILED%' then raise; end if;
  if sqlerrm !~* pattern then raise exception 'TEST FAILED: got "%" instead of "%"', sqlerrm, pattern; end if;
end $$;
grant execute on all functions in schema pg_temp to authenticated;

\set admin   '''00000000-0000-0000-0000-00000000000a'''
\set cebu    '''00000000-0000-0000-0000-0000000000c1'''
\set davao   '''00000000-0000-0000-0000-0000000000d1'''
\set rns     '''00000000-0000-0000-0000-0000000000a5'''
\set danao   '''00000000-0000-0000-0000-0000000000b1'''
\set liloan  '''00000000-0000-0000-0000-0000000000b2'''
\set finance '''00000000-0000-0000-0000-0000000000f1'''

-- ---------------------------------------------------------------- login lookup (anon)
set role anon;
select pg_temp.check(login_email('danao') = 'danao@rbabc.local', 'login by username');
select pg_temp.check(login_email('RB ABC Danao Inc.') = 'danao@rbabc.local', 'login by display name');
select pg_temp.check(login_email('nobody') is null, 'unknown user');
select pg_temp.expect_error('select next_doc_no(''X'')', 'permission denied');
reset role;

-- ---------------------------------------------------------------- PRS
select set_config('request.jwt.claim.sub', :danao, false); set role authenticated;
select pg_temp.check((my_profile()->>'type') = 'Branch', 'profile');
select pg_temp.expect_error($$select prs_create('{"preparedBy":"Nurse A","items":[]}')$$, 'at least one item');
select pg_temp.expect_error($$select prs_create('{"preparedBy":"Nurse A","items":[{"qty":"0","desc":"Speeda"}]}')$$, 'greater than 0');
select prs_create(('{"prsDate":"' || mnl_today() || '","department":"ABC","preparedBy":"Nurse A",
  "items":[{"qty":"10","unit":"vial","desc":"Speeda"},{"qty":"20","unit":"vial","desc":"Abhayrab"},{"qty":"100","unit":"pc","desc":"Insulin Syringe"}]}')::jsonb);
select pg_temp.check((select control_no from prs) = 'DAN-001-' || extract(year from mnl_today()), 'PRS control no');
select pg_temp.check((select count(*) from prs_v) = 1, 'branch sees own PRS');
select pg_temp.check((select count(*) from email_outbox) = 0, 'branch cannot read outbox');
reset role;
select pg_temp.check((select count(*) from email_outbox where 'rns@example.com' = any (to_addr)) = 1, 'RNS emailed');

select set_config('request.jwt.claim.sub', :liloan, false); set role authenticated;
select pg_temp.check((select count(*) from prs) = 0, 'other branch cannot see PRS');
reset role;

select set_config('request.jwt.claim.sub', :cebu, false); set role authenticated;
select pg_temp.check((select count(*) from prs) = 0, 'HQ cannot see a PRS before RNS approval');
reset role;

select set_config('request.jwt.claim.sub', :rns, false); set role authenticated;
select pg_temp.expect_error(format($$select prs_review(%L, 'return', '{"items":[{"qty":"1","desc":"x"}]}')$$, (select id from prs)), 'Write a note');
select prs_review((select id from prs), 'return', '{"note":"Add stock count","items":[{"qty":"10","unit":"vial","desc":"Speeda"},{"qty":"20","unit":"vial","desc":"Abhayrab"},{"qty":"100","unit":"pc","desc":"Insulin Syringe"}]}');
reset role;
select set_config('request.jwt.claim.sub', :danao, false); set role authenticated;
select pg_temp.expect_error(format($$select prs_resubmit(%L, '{"items":[{"qty":"5","desc":"Speeda"}]}')$$, (select id from prs)), 'Tell your RNS');
select prs_resubmit((select id from prs), '{"reply":"Stock count attached","items":[{"qty":"10","unit":"vial","desc":"Speeda"},{"qty":"20","unit":"vial","desc":"Abhayrab"},{"qty":"100","unit":"pc","desc":"Insulin Syringe"}]}');
select pg_temp.check((select status from prs) = 'Submitted', 'resubmitted');
reset role;
select set_config('request.jwt.claim.sub', :rns, false); set role authenticated;
select prs_review((select id from prs), 'approve', '{"note":"OK","items":[{"qty":"10","unit":"vial","desc":"Speeda"},{"qty":"20","unit":"vial","desc":"Abhayrab"},{"qty":"100","unit":"pc","desc":"Insulin Syringe"}]}');
select pg_temp.check((select status from prs) = 'Approved', 'approved');
reset role;
select set_config('request.jwt.claim.sub', :cebu, false); set role authenticated;
select pg_temp.check((select count(*) from prs_v) = 1, 'HQ sees approved PRS');
select pg_temp.check((select count(*) from prs_items) = 3, 'HQ sees PRS items');
reset role;
select set_config('request.jwt.claim.sub', :davao, false); set role authenticated;
select pg_temp.check((select count(*) from prs) = 0, 'other HQ cannot see PRS');
reset role;

-- ---------------------------------------------------------------- inventory
select set_config('request.jwt.claim.sub', :admin, false); set role authenticated;
select inv_po_add('{"po":"PO CW 001-2026","supplier":"Zydus","sku":"VAC-007","batch":"sp100","expiry":"2028-01-31","qty":"50","cost":"350","status":"Received"}');
select inv_po_add('{"po":"PO CW 001-2026","supplier":"Zydus","sku":"VAC-001","batch":"AB200","expiry":"2028-03-31","qty":"40","cost":"300","status":"Received"}');
select inv_po_add('{"po":"PO CW 002-2026","supplier":"BD","sku":"SUP-001","qty":"1000","cost":"4","status":"Pending"}');
select pg_temp.check(stock_at('CW', 'SP100') = 50, 'CW stock after PO');
select pg_temp.expect_error($$select inv_transfer('{"hq":"CEBU","batch":"SP100","qty":"60"}')$$, 'Only 50');
select inv_transfer('{"hq":"CEBU","batch":"SP100","qty":"30","dr":"DR-1"}');
select inv_transfer('{"hq":"CEBU","batch":"AB200","qty":"25","dr":"DR-1"}');
select pg_temp.check(stock_at('CW', 'SP100') = 20 and stock_at('HQ:CEBU', 'SP100') = 30, 'transfer moved stock');
select pg_temp.check(jsonb_array_length(inv_get('CW')->'batches') = 2, 'inv_get CW');
-- receiving the PO line again (Pending → Received) adds the batch
select inv_po_update(jsonb_build_object('id', (select id from purchase_order_lines where sku = 'SUP-001'), 'status', 'Received', 'batch', 'IS9', 'expiry', '2030-01-01'));
select pg_temp.check(stock_at('CW', 'IS9') = 1000, 'PO received via update');
select inv_transfer('{"hq":"CEBU","batch":"IS9","qty":"500"}');
-- cannot "un-receive" stock that already went to an HQ
select pg_temp.expect_error(format($$select inv_po_update('{"id":%s,"status":"Pending"}')$$, (select id from purchase_order_lines where sku = 'SUP-001')), 'already sent to HQs');
reset role;

select set_config('request.jwt.claim.sub', :cebu, false); set role authenticated;
select pg_temp.check((inv_get('CW')->>'kind') = 'HQ', 'HQ always gets own inventory');
select pg_temp.check(jsonb_array_length(inv_hq_batches()->'batches') = 3, 'HQ batch picker');
select pg_temp.expect_error($$select inv_hq_receive('{"sku":"VAC-007","batch":"SP100","expiry":"2029-01-01","qty":"1"}')$$, 'expiry');
select pg_temp.check((select count(*) from stock_moves) = 0, 'HQ cannot read the raw ledger');

-- ---------------------------------------------------------------- delivery note
select pg_temp.check((dn_prs_lookup((select control_no from prs))->'prs'->'items'->0->>'qty')::numeric = 10, 'PRS lookup remaining');
select pg_temp.expect_error(format($$select dn_save('{"branchId":"%s","date":"%s","prsNo":"%s","items":[{"qty":"40","unit":"vial","desc":"Speeda","batch":"SP100"}]}', true)$$,
  (select id from branches where short_name = 'DANAO'), mnl_today(), (select control_no from prs)), 'Only 30');
-- Abhayrab short (10 of 20) and Speeda sent for it is not needed; insulin not available now → partially served
select dn_save(jsonb_build_object('branchId', (select id from branches where short_name = 'DANAO'), 'date', mnl_today(), 'prsNo', (select control_no from prs),
  'mode', 'Delivery rider', 'rider', 'Juan',
  'items', jsonb_build_array(
    jsonb_build_object('qty', '10', 'unit', 'vial', 'desc', 'Speeda', 'batch', 'SP100', 'forDesc', 'Speeda'),
    jsonb_build_object('qty', '10', 'unit', 'vial', 'desc', 'Abhayrab', 'batch', 'AB200', 'forDesc', 'Abhayrab'),
    jsonb_build_object('qty', '0', 'unit', 'pc', 'desc', 'Insulin Syringe', 'forDesc', 'Insulin Syringe'))), true);
select pg_temp.check((select dn_no from delivery_notes) = 'CEBU HQ 001-' || extract(year from mnl_today()), 'DN number');
select pg_temp.check((select status from prs) = 'Partially Served', 'PRS partially served');
select pg_temp.check((select remarks from delivery_notes) like '%Not delivered (no stock yet): Abhayrab 10 vial, Insulin Syringe 100 pc%', 'pending in remarks');
select pg_temp.check(stock_at('HQ:CEBU', 'SP100') = 20, 'HQ stock deducted on dispatch');
-- second note delivers the rest
select pg_temp.check((select jsonb_agg(x->>'qty') from jsonb_array_elements(dn_prs_lookup((select control_no from prs))->'prs'->'items') x) = '["0", "10", "100"]', 'remaining after first DN');
select dn_save(jsonb_build_object('branchId', (select id from branches where short_name = 'DANAO'), 'date', mnl_today(), 'prsNo', (select control_no from prs),
  'items', jsonb_build_array(jsonb_build_object('qty', '10', 'unit', 'vial', 'desc', 'Abhayrab', 'batch', 'AB200'),
                             jsonb_build_object('qty', '100', 'unit', 'pc', 'desc', 'Insulin Syringe', 'batch', 'IS9'))), false);
select pg_temp.check((select status from delivery_notes where dn_no like '%002-%') = 'Prepared', 'prepared DN');
reset role;

select set_config('request.jwt.claim.sub', :danao, false); set role authenticated;
select pg_temp.check((select count(*) from delivery_notes) = 1, 'branch does not see prepared notes');
select pg_temp.expect_error(format($$select rr_submit(%L, '{"receiptDate":"%s","receivedBy":"Nurse A","items":[{"rQty":"10"}]}')$$,
  (select id from delivery_notes), mnl_today()), 'every item');
select rr_submit((select id from delivery_notes), jsonb_build_object('receiptDate', mnl_today(), 'receivedBy', 'Nurse A',
  'items', jsonb_build_array(jsonb_build_object('rQty', '10', 'condition', 'Good'), jsonb_build_object('rQty', '9', 'condition', 'Damaged', 'note', '1 broken'))));
select pg_temp.check((select status from delivery_notes) = 'Received – with discrepancy', 'RR discrepancy');
select pg_temp.check((select rr_no from delivery_notes) = 'DAN BRR 001-' || extract(year from mnl_today()), 'RR number');
reset role;

select set_config('request.jwt.claim.sub', :cebu, false); set role authenticated;
select pg_temp.expect_error(format($$select dn_validate(%L, '')$$, (select id from delivery_notes where rr_no is not null)), 'action taken');
select dn_validate((select id from delivery_notes where rr_no is not null), 'Replacement on next DN');
select dn_save(jsonb_build_object('id', (select id from delivery_notes where dn_no like '%002-%'), 'branchId', (select id from branches where short_name = 'DANAO'),
  'date', mnl_today(), 'prsNo', (select control_no from prs),
  'items', jsonb_build_array(jsonb_build_object('qty', '10', 'unit', 'vial', 'desc', 'Abhayrab', 'batch', 'AB200'),
                             jsonb_build_object('qty', '100', 'unit', 'pc', 'desc', 'Insulin Syringe', 'batch', 'IS9'))), true);
select pg_temp.check((select status from prs) = 'Served', 'PRS served after second DN');
reset role;
select set_config('request.jwt.claim.sub', :danao, false); set role authenticated;
select rr_submit((select id from delivery_notes where dn_no like '%002-%'), jsonb_build_object('receiptDate', mnl_today(), 'receivedBy', 'Nurse A',
  'items', jsonb_build_array(jsonb_build_object('rQty', '10'), jsonb_build_object('rQty', '100'))));
reset role;
select set_config('request.jwt.claim.sub', :admin, false); set role authenticated;
select dn_validate((select id from delivery_notes where dn_no like '%002-%'), '');
reset role;

-- ---------------------------------------------------------------- stock card
select set_config('request.jwt.claim.sub', :danao, false); set role authenticated;
select pg_temp.check((select balance from sc_balances s join sc_items i on i.id = s.item_id where i.name = 'Speeda') = 10, 'validated DN on stock card');
select pg_temp.check((select balance from sc_balances s join sc_items i on i.id = s.item_id where i.name = 'Abhayrab') = 10, 'damaged line skipped');
select pg_temp.expect_error(format($$select sc_save_day('%s', '[{"item":"Speeda","consumed":"11"}]')$$, mnl_today()), 'more than the balance');
select sc_save_day(mnl_today(), '[{"item":"Speeda","consumed":"4"},{"item":"Insulin Syringe","consumed":"30","remarks":"busy day"}]');
select pg_temp.check((select balance from sc_balances s join sc_items i on i.id = s.item_id where i.name = 'Speeda') = 6, 'consumed');
select sc_save_begin(jsonb_build_object('item', 'Tetagam', 'qty', '5', 'date', mnl_today() - 3));
select sc_add_item('{"name":"Alcohol 70%","category":"Supplies","unit":"btl"}');
select pg_temp.expect_error($$select sc_add_item('{"name":"alcohol 70 %"}')$$, 'already in the list');
reset role;
select set_config('request.jwt.claim.sub', :rns, false); set role authenticated;
select sc_set_lock((select id::text from branches where short_name = 'DANAO'), true);
select pg_temp.expect_error($$select sc_set_lock('ALL', true)$$, 'Only the Admin');
reset role;
select set_config('request.jwt.claim.sub', :danao, false); set role authenticated;
select pg_temp.expect_error(format($$select sc_save_day('%s', '[{"item":"Speeda","consumed":"1"}]')$$, mnl_today() - 1), 'locked');
select pg_temp.expect_error($$select sc_save_begin('{"item":"Tetagam","qty":"6","date":"2026-01-01"}')$$, 'locked');
reset role;

-- ---------------------------------------------------------------- wastage & temperature
select set_config('request.jwt.claim.sub', :danao, false); set role authenticated;
select pg_temp.expect_error(format($$select wastage_submit('{"date":"%s","preparedBy":"Nurse A","abh":{"opened":"1","id":"4"}}')$$, mnl_today()), 'need');
select pg_temp.expect_error(format($$select wastage_submit('{"date":"%s","preparedBy":"Nurse A","abh":{"opened":"2","id":"4"}}')$$, mnl_today()), 'reason');
select wastage_submit(jsonb_build_object('date', mnl_today(), 'preparedBy', 'Nurse A', 'abh', jsonb_build_object('opened', '2', 'id', '4', 'booster', '1'), 'reason', 'No patient'));
select wastage_submit(jsonb_build_object('date', mnl_today(), 'preparedBy', 'Nurse A', 'abh', jsonb_build_object('opened', '2', 'id', '5'), 'reason', ''));
select pg_temp.check((select count(*) from wastage_reports) = 1 and (select abh_id from wastage_reports) = 5, 'wastage upsert');
select pg_temp.expect_error($$select temp_submit('{"ref":"1","temp":"9","recordedBy":"Nurse A"}')$$, 'action taken');
select temp_submit('{"ref":"1","temp":"4.5","recordedBy":"Nurse A"}');
select pg_temp.expect_error($$select temp_submit('{"ref":"1","temp":"4.5","recordedBy":"Nurse A"}')$$, 'already logged');
select temp_submit('{"ref":"1","temp":"9","recordedBy":"Nurse A","action":"Adjusted thermostat","recheck":true}');
reset role;
select set_config('request.jwt.claim.sub', :rns, false); set role authenticated;
select pg_temp.check((select count(*) from temp_readings) = 2, 'RNS sees branch readings');
select pg_temp.check((select count(*) from wastage_reports) = 1, 'RNS sees wastage');
reset role;
select set_config('request.jwt.claim.sub', :davao, false); set role authenticated;
select pg_temp.check((select count(*) from temp_readings) = 0, 'other HQ cannot see readings');
reset role;

-- ---------------------------------------------------------------- chat
select set_config('request.jwt.claim.sub', :danao, false); set role authenticated;
select pg_temp.check((select count(*) from my_chat_rooms()) = 3, 'branch rooms: everyone, HQ, RNS');
select chat_post('hq:CEBU', 'Hello HQ', null);
select pg_temp.expect_error($$select chat_post('admin', 'hi', null)$$, 'not a member');
reset role;
select set_config('request.jwt.claim.sub', :cebu, false); set role authenticated;
select pg_temp.check((select count(*) from chat_messages) = 1, 'HQ reads its room');
select pg_temp.check(dm_room('ADMIN', 'CEBU HQ') = any (my_chat_room_ids()), 'HQ ↔ Admin direct chat');
select chat_post(dm_room('ADMIN', 'CEBU HQ'), '', '{"kind":"call"}');
reset role;
select set_config('request.jwt.claim.sub', :davao, false); set role authenticated;
select pg_temp.check((select count(*) from chat_messages) = 0, 'other HQ cannot read');
reset role;
select set_config('request.jwt.claim.sub', :admin, false); set role authenticated;
select pg_temp.check((select count(*) from chat_messages) = 1, 'admin reads only own rooms');
reset role;

-- ---------------------------------------------------------------- attendance
select set_config('request.jwt.claim.sub', :cebu, false); set role authenticated;
select pg_temp.expect_error(format($$select attendance_log('{"action":"IN","id":"RBSO-001","site":"CEBU HQ","lat":10.40,"lng":123.88,"photoPath":"%s/x.jpg"}')$$, mnl_today()), 'Too far');
select attendance_log(jsonb_build_object('action', 'IN', 'id', 'rbso-001', 'site', 'CEBU HQ', 'lat', 10.3158, 'lng', 123.8855, 'accuracy', 20, 'photoPath', mnl_today() || '/a.jpg'));
select pg_temp.expect_error(format($$select attendance_log('{"action":"IN","id":"RBSO-001","site":"CEBU HQ","lat":10.3158,"lng":123.8855,"photoPath":"%s/b.jpg"}')$$, mnl_today()), 'already timed in');
select attendance_log(jsonb_build_object('action', 'OUT', 'id', 'RBSO-001', 'site', 'CEBU HQ', 'lat', 10.3158, 'lng', 123.8855, 'photoPath', mnl_today() || '/c.jpg'));
select pg_temp.check((attendance_for('RBSO-001')->'recent'->0->>'status') = 'COMPLETE', 'attendance complete');
select pg_temp.check((select count(*) from attendance) = 0, 'HQ cannot list attendance');
reset role;
insert into attendance (work_date, employee_id, employee_name, time_in, status, site) values (mnl_today() - 1, 'RBSO-002', 'K', now() - interval '1 day', 'TIMED IN', 'CDO HQ');
select set_config('request.jwt.claim.sub', :cebu, false); set role authenticated;
select attendance_for('RBSO-002');
reset role;
select pg_temp.check((select status from attendance where employee_id = 'RBSO-002') = 'NO TIME OUT', 'midnight auto-close');

-- ---------------------------------------------------------------- SOA
select set_config('request.jwt.claim.sub', :cebu, false); set role authenticated;
insert into hq_prices (hq_code, sku, price) values ('CEBU', 'VAC-007', 400);
select pg_temp.check(jsonb_array_length(soa_candidates('ANDREA', null, null)->'ready') = 2, 'SOA candidates');
select pg_temp.check((soa_candidates('ANDREA', null, null)->'ready'->0->'lines'->0->>'cost')::numeric = 400, 'HQ price used');
select pg_temp.expect_error(format($$select soa_save('{"dsmKey":"ANDREA","dns":[{"id":"%s","costs":{"2":"0"}}]}', true)$$,
  (select id from delivery_notes where dn_no like '%002-%')), 'unit cost');
select soa_save(jsonb_build_object('dsmKey', 'ANDREA', 'note', 'Invoices attached', 'dns', jsonb_build_array(
  jsonb_build_object('id', (select id from delivery_notes where dn_no like '%001-%'), 'costs', '{}'::jsonb),
  jsonb_build_object('id', (select id from delivery_notes where dn_no like '%002-%'), 'costs', jsonb_build_object('2', '5')))), true);
-- Speeda 10×400 + Abhayrab (damaged) excluded + Abhayrab 10×300 (CW PO) + Insulin 100×5
select pg_temp.check((select total from soas) = 4000 + 3000 + 500, 'SOA total');
select pg_temp.check((select status from soas) = 'For Approval', 'SOA submitted');
select pg_temp.expect_error(format($$select soa_save('{"dsmKey":"ANDREA","dns":[{"id":"%s"}]}', false)$$, (select id from delivery_notes where dn_no like '%001-%')), 'another SOA');
reset role;
select set_config('request.jwt.claim.sub', :finance, false); set role authenticated;
select pg_temp.check((select count(*) from soas) = 0, 'finance cannot see SOA before approval');
reset role;
select set_config('request.jwt.claim.sub', :admin, false); set role authenticated;
select soa_action((select id from soas), 'approve', 'Please process', '');
reset role;
select pg_temp.check((select count(*) from email_outbox where 'rbabchqdmandrea@gmail.com' = any (to_addr) and 'rns@example.com' = any (cc_addr)) = 1, 'DSM e-mailed, RNS copied');
\o
select soa_no as soa_no, view_key as soa_key from soas \gset
\o /dev/null
set role anon;
select pg_temp.check((soa_public(:'soa_no', :'soa_key')->>'ok')::boolean, 'public SOA view');
select pg_temp.check(jsonb_array_length(soa_public(:'soa_no', :'soa_key')->'dns') = 2, 'public SOA view lists the DNs');
select pg_temp.check(not (soa_public(:'soa_no', 'wrong')->>'ok')::boolean, 'public SOA view needs key');
reset role;
select set_config('request.jwt.claim.sub', :finance, false); set role authenticated;
select pg_temp.expect_error(format($$select soa_action(%L, 'process', '', '')$$, (select id from soas)), 'reference');
select soa_action((select id from soas), 'process', '', 'CV-2026-0001');
select pg_temp.check((select status from soas) = 'Processed by Finance', 'SOA processed');
reset role;

-- ---------------------------------------------------------------- purchase orders
select set_config('request.jwt.claim.sub', :admin, false); set role authenticated;
select pg_temp.check((po_list()->>'nextNo') = 'PO CW 003-' || extract(year from mnl_today()), 'next PO no');
select po_create('{"no":"PO CW 003-2026","supplier":"Indoplas","lines":[{"sku":"SUP-002","qty":"200","cost":"3.5"},{"sku":"SUP-003","qty":"100","cost":"0"}]}');
select pg_temp.expect_error($$select po_submit('PO CW 003-2026', '{}')$$, 'unit cost');
select inv_po_update(jsonb_build_object('id', (select id from purchase_order_lines where po_no = 'PO CW 003-2026' and sku = 'SUP-003'), 'cost', '6'));
select po_submit('PO CW 003-2026', '{"due":"2026-12-01","payment":"n/30"}');
select pg_temp.check((select total from po_headers where po_no = 'PO CW 003-2026') = 1300, 'PO total');
select pg_temp.check(jsonb_array_length(po_list()->'list') = 3, 'PO list groups the CW log');
reset role;
select set_config('request.jwt.claim.sub', :finance, false); set role authenticated;
select pg_temp.check(jsonb_array_length(po_list()->'list') = 1, 'finance sees submitted POs');
select po_action('PO CW 003-2026', 'return', 'Wrong supplier address', '');
reset role;
select set_config('request.jwt.claim.sub', :admin, false); set role authenticated;
select po_submit('PO CW 003-2026', '{"address":"Mandaue"}');
reset role;
select set_config('request.jwt.claim.sub', :finance, false); set role authenticated;
select po_action('PO CW 003-2026', 'process', '', 'CV-2');
reset role;

-- ---------------------------------------------------------------- reports
select set_config('request.jwt.claim.sub', :cebu, false); set role authenticated;
select pg_temp.check(jsonb_array_length(ordered_items(null, null)->'lines') = 3, 'ordered items');
select pg_temp.check((ordered_items(null, null)->'lines'->1->>4)::numeric = 20, 'Abhayrab delivered 20');
select pg_temp.expect_error('select report_data()', 'not available');
reset role;
select set_config('request.jwt.claim.sub', :admin, false); set role authenticated;
select pg_temp.check(jsonb_array_length(report_data()->'orders') >= 3, 'report data');
select pg_temp.check(jsonb_array_length(admin_export()->'prs') = 1, 'export');
select pg_temp.check(jsonb_array_length(inv_get('HQ:CEBU')->'orders') = 4, 'HQ orders view');
reset role;

\o
select 'workflow tests passed' as result;
