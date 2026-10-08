-- =====================================================================
-- Starter data: HQs, branches, settings, products, DSM groups, fridges,
-- attendance sites. Accounts are created with scripts/create-users.mjs.
-- Everything here can be edited later in the portal (Admin → Setup).
-- =====================================================================

insert into public.hqs (code, name, region, email, sort) values
  ('PASIG', 'Pasig City HQ', 'Luzon',    'rbabcscojayson@gmail.com',    1),
  ('CEBU',  'Cebu City HQ',  'Visayas',  'rbabcscocebjay@gmail.com',    2),
  ('CDO',   'CDO HQ',        'Mindanao', 'rbabcscocdokienth@gmail.com', 3),
  ('DAVAO', 'Davao HQ',      'Mindanao', 'rbabcscodvoedward@gmail.com', 4)
on conflict (code) do nothing;

insert into public.app_settings (key, value, note) values
  ('portal_title',          '"RB ABC Supply Office"', 'Shown in the header and browser tab'),
  ('portal_url',            '""', 'Public URL of the portal (used in e-mails and SOA view links), e.g. https://portal.example.com'),
  ('supply_director_email', '"rbabcitmitch@gmail.com"', 'CC on approvals and receiving reports'),
  ('supply_director_name',  '""', 'Pre-fills "Approved by" on new Delivery Notes'),
  ('finance_email',         '""', 'Where approved SOAs and POs are e-mailed'),
  ('wastage',               '{"abh": 2.5, "spd": 3, "flag": 0.2}', 'ID doses per vial (Abhayrab / Speeda) and the wastage flag ratio'),
  ('temperature',           '{"min": 2, "max": 8, "amEnd": 12}', 'Safe range (°C) and the hour the AM session ends'),
  ('attendance_ot_hours',   '10', 'Hours worked beyond this get an overtime remark'),
  ('soa_signers',           '{"prepared": "Mitchell L. Patotoy | Supply Chain Director", "reviewed": "Kenneth B. Canales | Chief Operating Officer", "approved": "Marvin C. Yepes | Chief Executive Officer"}', 'Name | Title printed on the SOA'),
  ('po_signers',            '{"prepared": "Mitchell L. Patotoy | Supply Chain Director", "reviewed": "Sheina Marie O. Sinadjan, RPh | Pharmacist", "approved": "Kenneth B. Canales | Chief Operating Officer", "contact": "Mitchell L. Patotoy | Supply Chain Director | 0930-894-6850; rbabcitmitch@gmail.com"}', 'Name | Title printed on the PO')
on conflict (key) do nothing;

-- name, short name, official code, HQ
insert into public.branches (name, short_name, code, hq_code, region)
select 'RB ABC ' || n || ' Inc.', upper(n), c, h, r.region from (values
  ('Antipolo City', 'LANT', 'PASIG'), ('Calamba City', 'LCAL', 'PASIG'), ('Dasmariñas City', 'LDAS', 'PASIG'),
  ('Pasay City', 'LPSY', 'PASIG'), ('Pasig City', 'LPSG', 'PASIG'), ('San Pablo City', 'LSAN', 'PASIG'),
  ('Argao', 'ARG', 'CEBU'), ('Bantayan Island', 'BAN', 'CEBU'), ('Baybay', 'BAY', 'CEBU'), ('Bogo City', 'BOG', 'CEBU'),
  ('Camotes Island', 'CAM', 'CEBU'), ('Carcar', 'CAR', 'CEBU'), ('Cebu City', 'CEB', 'CEBU'), ('Compostela', 'COM', 'CEBU'),
  ('Consolacion', 'CON', 'CEBU'), ('Daanbantayan', 'DAA', 'CEBU'), ('Danao', 'DAN', 'CEBU'), ('Dumaguete', 'DGT', 'CEBU'),
  ('Dumanjug', 'DUM', 'CEBU'), ('Lapu-Lapu City', 'LAP', 'CEBU'), ('Liloan', 'LIL', 'CEBU'), ('Mandaue City', 'MAN', 'CEBU'),
  ('Maasin City', 'MAA', 'CEBU'), ('Minglanilla', 'MIN', 'CEBU'), ('Moalboal', 'MOA', 'CEBU'), ('Naga', 'NAG', 'CEBU'),
  ('Ormoc City', 'ORM', 'CEBU'), ('Talamban', 'TLB', 'CEBU'), ('Tagbilaran City', 'TAG', 'CEBU'), ('Talisay City', 'TAL', 'CEBU'),
  ('Toledo', 'TOL', 'CEBU'), ('Tubigon', 'TUB', 'CEBU'),
  ('Ipil', 'MIPI', 'CDO'), ('Zamboanga City', 'MZAM', 'CDO'), ('Dapitan City', 'MDAP', 'CDO'), ('Dipolog City', 'MDIP', 'CDO'),
  ('Pagadian City', 'MPAG', 'CDO'), ('Tubod', 'MTUB', 'CDO'), ('CDO', 'MCDO', 'CDO'), ('Malaybalay City', 'MMAL', 'CDO'),
  ('Manolo Fortich', 'MMAN', 'CDO'), ('Valencia City', 'MVAL', 'CDO'), ('Oroquieta City', 'MORO', 'CDO'), ('Iligan City', 'MILI', 'CDO'),
  ('Gingoog City', 'MGIN', 'CDO'),
  ('Panabo City', 'MPAN', 'DAVAO'), ('Kidapawan City', 'MKID', 'DAVAO'), ('Davao City', 'MDAV', 'DAVAO'), ('Koronadal City', 'MKOR', 'DAVAO'),
  ('Butuan City', 'MBUT', 'DAVAO'), ('Surigao City', 'MSUR', 'DAVAO'), ('Siargao Island', 'MSIA', 'DAVAO'), ('Tagum City', 'MTAG', 'DAVAO'),
  ('Digos City', 'MDIG', 'DAVAO'), ('Polomolok', 'MPOL', 'DAVAO'), ('General Santos City', 'MGEN', 'DAVAO')
) v(n, c, h) join public.hqs r on r.code = v.h
on conflict (name) do nothing;

-- one refrigerator location per branch and per HQ
insert into public.fridge_locations (name, kind, hq_code, branch_id, ref_count)
select b.name, 'Branch', b.hq_code, b.id, 1 from public.branches b on conflict do nothing;
insert into public.fridge_locations (name, kind, hq_code, ref_count)
select h.name, 'HQ', h.code, 2 from public.hqs h on conflict do nothing;

-- attendance sites (set the GPS point of each HQ in Admin → Setup → Attendance)
insert into public.attendance_sites (name, hq_code, radius) select upper(h.code) || ' HQ', h.code, 100 from public.hqs h on conflict do nothing;
insert into public.employees (id, name, hq_code) values
  ('RBSO-001', 'Jeremiah C. Soquite', 'CEBU'), ('RBSO-002', 'Kienth Brayan M. Gapol', 'CDO'),
  ('RBSO-003', 'Edward Sean C. Maravilla', 'DAVAO'), ('RBSO-004', 'Jayson Arzadon', 'PASIG')
on conflict do nothing;

-- starter product list (Central Warehouse). Adding a product also adds it to the stock card list.
insert into public.products (sku, name, category, uom, unit_cost) values
  ('VAC-001', 'Abhayrab', 'Vaccines', 'vial', 0), ('VAC-006', 'Equirab', 'Vaccines', 'vial', 0),
  ('VAC-007', 'Speeda', 'Vaccines', 'vial', 0), ('VAC-008', 'Abhay-Tox', 'Vaccines', 'vial', 0),
  ('VAC-010', 'Tetagam', 'Vaccines', 'vial', 0),
  ('MED-003', 'Co-Amoxiclav Syrup', 'Medicine', 'btl', 0), ('MED-004', 'Co-Amoxiclav Tab', 'Medicine', 'tab', 0),
  ('MED-005', 'Cetirizine Syrup', 'Medicine', 'btl', 0), ('MED-006', 'Cetirizine Tab', 'Medicine', 'tab', 0),
  ('MED-008', 'Cefuroxime Capsule', 'Medicine', 'cap', 0),
  ('SUP-001', 'Insulin Syringe', 'Medical Supplies', 'pc', 0), ('SUP-002', 'Tuberculin Syringe', 'Medical Supplies', 'pc', 0),
  ('SUP-003', '3 cc Syringe', 'Medical Supplies', 'pc', 0)
on conflict do nothing;

insert into public.sc_items (name, category, description, unit, added_by) values
  ('Cefuroxime Syrup', 'Meds', 'Antibiotic', 'btl', 'Starter list'),
  ('Amoxicillin Capsule', 'Meds', 'Ambimox', '500 mg cap', 'Starter list'),
  ('Amoxicillin Suspension', 'Meds', 'Suspension', '125 mg/5 mL btl', 'Starter list')
on conflict do nothing;

-- DSM / Branch Manager groups for the SOA
insert into public.dsm_groups (key, role, manager_name, manager_email, oic, oic_email, rns_name, area, phone, branch_ids)
select g.k, g.role, g.mgr, g.mail, g.oic, g.oicmail, g.rns, g.area, g.phone,
       array(select id from public.branches b where public.norm_key(b.short_name) in (select public.norm_key(x) from unnest(g.brs) x))
from (values
  ('ANDREA', 'District Sales Manager', 'Andrealyn V. Siazon', 'rbabchqdmandrea@gmail.com', null, null, 'Angelene Dalapo', 'Cebu North Branches', '0956 714 8583',
     array['MANDAUE CITY', 'BANTAYAN ISLAND', 'DAANBANTAYAN', 'BOGO CITY', 'DANAO', 'CAMOTES ISLAND', 'COMPOSTELA', 'TALAMBAN', 'CONSOLACION', 'LILOAN']),
  ('CUNANAN-SABAL', 'Branch Manager', 'Dr. Angelie Nocido-Cunanan / Dr. Arjay Cunanan', null, 'Angelica Sabal', 'rbabcminglanillarnangelicalou@gmail.com', null, 'Minglanilla group', null,
     array['MINGLANILLA', 'TALISAY CITY', 'CARCAR', 'DUMANJUG']),
  ('CUNANAN-SAJONIA', 'Branch Manager', 'Dr. Angelie Nocido-Cunanan / Dr. Arjay Cunanan', null, 'Vea Sajonia', 'rbabciliganrnvea@gmail.com', null, 'Iligan group', null,
     array['ILIGAN CITY', 'OROQUIETA CITY']),
  ('LINDSEY', 'District Sales Manager', 'Lindsey Glenn Gandionco', 'rbabchqdmlindsey@gmail.com', null, null, 'Angelene Dalapo', 'Cebu South Branches', '0977 334 2420',
     array['MOALBOAL', 'ORMOC CITY', 'CEBU CITY', 'NAGA', 'ARGAO', 'TOLEDO', 'LAPU-LAPU CITY', 'DUMAGUETE', 'TUBIGON', 'TAGBILARAN CITY']),
  ('SHIRLY', 'Branch Manager', 'Shirly Calo Pagolong', 'rbabchqrshirly@gmail.com', null, null, 'Angelene Dalapo', 'Maasin', null,
     array['MAASIN CITY']),
  ('ANDREW', 'District Sales Manager', 'Andrew M. Pestillos', 'rbabchqdmdrew@gmail.com', null, null, 'Trixiemaxine Pairy Angely Pulgo', 'Northern Mindanao Branches', '0947 644 6116',
     array['IPIL', 'PAGADIAN CITY', 'ZAMBOANGA CITY', 'DAPITAN CITY', 'DIPOLOG CITY', 'TUBOD', 'CDO', 'MALAYBALAY CITY', 'MANOLO FORTICH', 'VALENCIA CITY', 'GINGOOG CITY']),
  ('JED', 'District Sales Manager', 'Jed Anthon Maruya', 'rbabchqdmjed@gmail.com', null, null, 'Trixiemaxine Pairy Angely Pulgo', 'Southern Mindanao Branches', '0917 770 2866',
     array['GENERAL SANTOS CITY', 'DAVAO CITY', 'KORONADAL CITY', 'BUTUAN CITY', 'SURIGAO CITY', 'SIARGAO ISLAND', 'TAGUM CITY', 'DIGOS CITY', 'PANABO CITY', 'KIDAPAWAN CITY', 'POLOMOLOK']),
  ('LUZON', 'District Sales Manager', null, null, 'Lovely Moirha M. Sardido', null, 'Gabrielle Maldo', 'Luzon Branches', null,
     array['SAN PABLO CITY', 'PASIG CITY', 'DASMARIÑAS CITY', 'PASAY CITY', 'ANTIPOLO CITY', 'CALAMBA CITY'])
) g(k, role, mgr, mail, oic, oicmail, rns, area, phone, brs)
on conflict (key) do nothing;
