/* =====================================================================
 * One-time setup and the daily maintenance job.
 *
 *   1. Open the HRIS spreadsheet → Extensions → Apps Script, paste the files.
 *   2. Run setup() once (Run ▸ setup). It creates every sheet, the starting
 *      HQs / branches / departments / positions / holidays / settings and the
 *      first Super Admin account, and prints its temporary password in the log.
 *   3. Run installTriggers() once for the daily job (12:30 AM Manila).
 *   4. Deploy ▸ New deployment ▸ Web app (Execute as: Me · Who has access: Anyone).
 * ===================================================================== */

function ownerOnly_() {
  var active = '', eff = '';
  try { active = Session.getActiveUser().getEmail(); eff = Session.getEffectiveUser().getEmail(); } catch (e) { /* no scope */ }
  if (!active || active !== eff) throw new Error('Run this from the Apps Script editor as the owner of the spreadsheet.');
}

function setup() {
  ownerOnly_();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Open this script from the HRIS spreadsheet (Extensions → Apps Script).');
  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());
  ss.setSpreadsheetTimeZone(TZ);
  _ss = ss;

  Object.keys(SCHEMA).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    var head = SCHEMA[name];
    var cur = sh.getLastColumn() ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String) : [];
    // add missing columns at the end (safe to run setup() again after an update)
    head.forEach(function (h) { if (cur.indexOf(h) < 0) cur.push(h); });
    if (sh.getMaxColumns() < cur.length) sh.insertColumnsAfter(sh.getMaxColumns(), cur.length - sh.getMaxColumns());
    sh.getRange(1, 1, 1, cur.length).setValues([cur]).setFontWeight('bold').setBackground('#1B2A6B').setFontColor('#ffffff');
    sh.setFrozenRows(1);
    sh.getRange(1, 1, sh.getMaxRows(), cur.length).setNumberFormat('@');
  });
  var blank = ss.getSheetByName('Sheet1');
  if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);
  _cache = {};

  seed_();
  var msg = 'Setup complete.';
  if (!table_('Users').length) {
    var pw = 'Hr' + Utilities.getUuid().replace(/-/g, '').slice(0, 8) + '!';
    var salt = newSalt_();
    insert_('Users', { Username: 'admin', Name: 'Super Admin', Email: Session.getEffectiveUser().getEmail(), Role: 'SUPER_ADMIN', Active: 'TRUE',
                       MustChange: 'TRUE', Salt: salt, PasswordHash: hash_(pw, salt), CreatedAt: stamp_() });
    msg += ' First login → username: admin · temporary password: ' + pw + ' (you will be asked to change it).';
  }
  filesFolder_('');
  Logger.log(msg);
  return msg;
}

function installTriggers() {
  ownerOnly_();
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'dailyJobs') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('dailyJobs').timeBased().atHour(0).nearMinute(30).everyDays(1).inTimezone(TZ).create();
  Logger.log('Daily job installed (around 12:30 AM Manila).');
}

/**
 * Every night: closes yesterday's time-ins without time-out, sets On Leave / Active from approved
 * leave, and on Mondays e-mails HR a digest of expiring documents and certificates.
 */
function dailyJobs() {
  locked_(function () {
    var t = today_();
    table_('Attendance').forEach(function (r) {
      if (r.TimeIn && !r.TimeOut && r.Date < t && r.Status !== 'Incomplete') {
        update_('Attendance', r._row, { Status: 'Incomplete', Remarks: [r.Remarks, 'No time out — file an attendance correction'].filter(String).join(' · ') });
      }
    });
    table_('Employees').forEach(function (e) {
      if (e.Status !== 'Active' && e.Status !== 'On Leave') return;
      var leave = onLeave_(e.EmployeeID, t);
      if (leave && e.Status === 'Active') update_('Employees', e._row, { Status: 'On Leave' });
      if (!leave && e.Status === 'On Leave') update_('Employees', e._row, { Status: 'Active' });
    });
  });
  if (dayName_(today_()) === 'Mon') {
    var sys = { username: 'system', role: 'SUPER_ADMIN', name: 'System' };
    var docs = documentsList_(sys, { expiring: true });
    var trs = trainingsList_(sys, {}).filter(function (x) { return x.State === 'Expired' || x.State === 'For Renewal'; });
    if (docs.length || trs.length) {
      mail_(hrEmails_(), 'Weekly expiry digest',
        (docs.length ? '<p><b>Documents</b></p><ul>' + docs.map(function (d) {
          return '<li>' + esc_(d.EmployeeName) + ' — ' + esc_(d.DocType) + ': ' + (d.State === 'Expired' ? 'expired ' : 'expires ') + esc_(d.ExpiryDate) + '</li>';
        }).join('') + '</ul>' : '') +
        (trs.length ? '<p><b>Training certificates</b></p><ul>' + trs.map(function (x) {
          return '<li>' + esc_(x.EmployeeName) + ' — ' + esc_(x.Title) + ': ' + esc_(x.State) + ' (' + esc_(x.ExpiryDate) + ')</li>';
        }).join('') + '</ul>' : ''));
    }
  }
}

/* ------------------------------------------------------------------ starting data (only added when missing) */

function seedRows_(name, key, rows) {
  var have = {};
  table_(name).forEach(function (r) { have[r[key]] = 1; });
  var head = SCHEMA[name];
  var add = rows.filter(function (r) { return !have[r[key]]; });
  if (!add.length) return;
  var sh = sheet_(name);
  var cols = headers_(name);
  var vals = add.map(function (r) { return cols.map(function (h) { return r[h] === undefined ? '' : String(r[h]); }); });
  sh.getRange(sh.getLastRow() + 1, 1, vals.length, cols.length).setValues(vals);
  delete _cache[name];
  return head;
}

function seed_() {
  seedRows_('HQs', 'HQ', [
    { HQ: 'CENTRAL', Name: 'Central Office – Cebu', Region: 'Visayas', Sort: 0 },
    { HQ: 'PASIG', Name: 'Luzon HQ – Pasig', Region: 'Luzon', Sort: 1 },
    { HQ: 'CEBU', Name: 'Visayas HQ – Cebu', Region: 'Visayas', Sort: 2 },
    { HQ: 'CDO', Name: 'Mindanao HQ – CDO', Region: 'Mindanao', Sort: 3 },
    { HQ: 'DAVAO', Name: 'Mindanao HQ – Davao', Region: 'Mindanao', Sort: 4 }
  ]);
  var region = { CENTRAL: 'Visayas', PASIG: 'Luzon', CEBU: 'Visayas', CDO: 'Mindanao', DAVAO: 'Mindanao' };
  var offices = [['Central Office', 'CO', 'Central Office', 'CENTRAL'], ['Pasig City HQ', 'HQ-PSG', 'HQ Office', 'PASIG'],
    ['Cebu City HQ', 'HQ-CEB', 'HQ Office', 'CEBU'], ['CDO HQ', 'HQ-CDO', 'HQ Office', 'CDO'], ['Davao HQ', 'HQ-DVO', 'HQ Office', 'DAVAO']];
  var branches = [
    ['Antipolo City', 'LANT', 'PASIG'], ['Calamba City', 'LCAL', 'PASIG'], ['Dasmariñas City', 'LDAS', 'PASIG'], ['Pasay City', 'LPSY', 'PASIG'],
    ['Pasig City', 'LPSG', 'PASIG'], ['San Pablo City', 'LSAN', 'PASIG'],
    ['Argao', 'ARG', 'CEBU'], ['Bantayan Island', 'BAN', 'CEBU'], ['Baybay', 'BAY', 'CEBU'], ['Bogo City', 'BOG', 'CEBU'], ['Camotes Island', 'CAM', 'CEBU'],
    ['Carcar', 'CAR', 'CEBU'], ['Cebu City', 'CEB', 'CEBU'], ['Compostela', 'COM', 'CEBU'], ['Consolacion', 'CON', 'CEBU'], ['Daanbantayan', 'DAA', 'CEBU'],
    ['Danao', 'DAN', 'CEBU'], ['Dumaguete', 'DGT', 'CEBU'], ['Dumanjug', 'DUM', 'CEBU'], ['Lapu-Lapu City', 'LAP', 'CEBU'], ['Liloan', 'LIL', 'CEBU'],
    ['Mandaue City', 'MAN', 'CEBU'], ['Maasin City', 'MAA', 'CEBU'], ['Minglanilla', 'MIN', 'CEBU'], ['Moalboal', 'MOA', 'CEBU'], ['Naga', 'NAG', 'CEBU'],
    ['Ormoc City', 'ORM', 'CEBU'], ['Talamban', 'TLB', 'CEBU'], ['Tagbilaran City', 'TAG', 'CEBU'], ['Talisay City', 'TAL', 'CEBU'], ['Toledo', 'TOL', 'CEBU'],
    ['Tubigon', 'TUB', 'CEBU'],
    ['Ipil', 'MIPI', 'CDO'], ['Zamboanga City', 'MZAM', 'CDO'], ['Dapitan City', 'MDAP', 'CDO'], ['Dipolog City', 'MDIP', 'CDO'], ['Pagadian City', 'MPAG', 'CDO'],
    ['Tubod', 'MTUB', 'CDO'], ['CDO', 'MCDO', 'CDO'], ['Malaybalay City', 'MMAL', 'CDO'], ['Manolo Fortich', 'MMAN', 'CDO'], ['Valencia City', 'MVAL', 'CDO'],
    ['Oroquieta City', 'MORO', 'CDO'], ['Iligan City', 'MILI', 'CDO'], ['Gingoog City', 'MGIN', 'CDO'],
    ['Panabo City', 'MPAN', 'DAVAO'], ['Kidapawan City', 'MKID', 'DAVAO'], ['Davao City', 'MDAV', 'DAVAO'], ['Koronadal City', 'MKOR', 'DAVAO'],
    ['Butuan City', 'MBUT', 'DAVAO'], ['Surigao City', 'MSUR', 'DAVAO'], ['Siargao Island', 'MSIA', 'DAVAO'], ['Tagum City', 'MTAG', 'DAVAO'],
    ['Digos City', 'MDIG', 'DAVAO'], ['Polomolok', 'MPOL', 'DAVAO'], ['General Santos City', 'MGEN', 'DAVAO']
  ];
  seedRows_('Branches', 'Branch', offices.map(function (o) {
    return { Branch: o[0], Code: o[1], Type: o[2], HQ: o[3], Region: region[o[3]], Radius: 150, Active: 'TRUE' };
  }).concat(branches.map(function (b) {
    return { Branch: b[0], Code: b[1], Type: 'Branch', HQ: b[2], Region: region[b[2]], Radius: 150, Active: 'TRUE' };
  })));
  seedRows_('Departments', 'Department', ['Operations', 'Nursing / Clinical', 'Supply Chain', 'Finance & Accounting', 'Human Resources',
    'Administration', 'Customer Service', 'Sales & Marketing', 'IT'].map(function (d) { return { Department: d, Active: 'TRUE' }; }));
  seedRows_('Positions', 'Position', [
    ['Branch Nurse', 'Nursing / Clinical', 'Staff'], ['Branch Manager', 'Operations', 'Supervisory'],
    ['Regional Nurse Supervisor', 'Nursing / Clinical', 'Supervisory'], ['District Manager', 'Operations', 'Managerial'],
    ['Supply Officer', 'Supply Chain', 'Staff'], ['CSR', 'Customer Service', 'Staff'], ['Medical Staff', 'Nursing / Clinical', 'Staff'],
    ['Accounting Staff', 'Finance & Accounting', 'Staff'], ['Administrative Staff', 'Administration', 'Staff'],
    ['HR Officer', 'Human Resources', 'Staff'], ['Supply Chain Director', 'Supply Chain', 'Executive'], ['Pharmacist', 'Supply Chain', 'Staff']
  ].map(function (p) { return { Position: p[0], Department: p[1], Level: p[2], Active: 'TRUE' }; }));
  // 2026 Philippine holidays — check against the year's Proclamation and add Eid / local holidays in Organization → Holidays
  seedRows_('Holidays', 'Date', [
    ['2026-01-01', 'New Year\'s Day', 'Regular'], ['2026-02-17', 'Chinese New Year', 'Special'], ['2026-04-02', 'Maundy Thursday', 'Regular'],
    ['2026-04-03', 'Good Friday', 'Regular'], ['2026-04-04', 'Black Saturday', 'Special'], ['2026-04-09', 'Araw ng Kagitingan', 'Regular'],
    ['2026-05-01', 'Labor Day', 'Regular'], ['2026-06-12', 'Independence Day', 'Regular'], ['2026-08-21', 'Ninoy Aquino Day', 'Special'],
    ['2026-08-31', 'National Heroes Day', 'Regular'], ['2026-11-01', 'All Saints\' Day', 'Special'], ['2026-11-30', 'Bonifacio Day', 'Regular'],
    ['2026-12-08', 'Feast of the Immaculate Conception', 'Special'], ['2026-12-24', 'Christmas Eve', 'Special'], ['2026-12-25', 'Christmas Day', 'Regular'],
    ['2026-12-30', 'Rizal Day', 'Regular'], ['2026-12-31', 'Last Day of the Year', 'Special']
  ].map(function (h) { return { Date: h[0], Name: h[1], Type: h[2] }; }));
  seedRows_('Settings', 'Key', [
    { Key: 'portal_title', Value: 'RB ABC HRIS', Note: 'Shown in the header and browser tab' },
    { Key: 'company_name', Value: 'RB ABC HOLDING OPC', Note: 'Printed on payslips and reports' },
    { Key: 'employee_id_prefix', Value: 'RB-', Note: 'New employees get RB-0001, RB-0002, …' },
    { Key: 'default_shift', Value: JSON.stringify({ start: '08:00', end: '17:00', graceMins: 15, restDays: 'Sun' }),
      Note: 'Used when the employee has no own shift / rest days. graceMins = minutes before counted late' },
    { Key: 'leave_credits', Value: JSON.stringify({ 'Vacation Leave': 5, 'Sick Leave': 5, 'Emergency Leave': 3, 'Maternity Leave': 105,
      'Paternity Leave': 7, 'Bereavement Leave': 3, 'Other Leave': 0 }), Note: 'Default yearly credits (days). Per-employee credits are set in Leave → Balances' },
    { Key: 'leave_allow_negative', Value: 'FALSE', Note: 'TRUE lets HR approve leave beyond the balance' },
    { Key: 'document_alert_days', Value: '30', Note: 'Warn this many days before a document expires' },
    { Key: 'renewal_alert_days', Value: '60', Note: 'Training certificates are "For Renewal" this many days before expiry' },
    { Key: 'email_notifications', Value: 'TRUE', Note: 'E-mail approvers and employees at each workflow step' },
    { Key: 'hr_email', Value: '', Note: 'Extra HR mailbox copied on new requests' },
    { Key: 'payroll', Value: JSON.stringify(PAYROLL_DEFAULTS), Note: 'Payroll rates and tables — have Accounting confirm before the first payroll' },
    { Key: 'payroll_self_approval', Value: 'FALSE', Note: 'TRUE lets the HR Admin who prepared a payroll also approve it' }
  ]);
}
