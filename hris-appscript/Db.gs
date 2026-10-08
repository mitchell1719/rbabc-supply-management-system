/**
 * Sheet "tables". Row 1 holds the headers below; every cell is stored as plain
 * text (dates as yyyy-MM-dd, times as HH:mm, stamps as yyyy-MM-dd HH:mm:ss) so
 * Sheets never reformats them. Columns can be added at the end later.
 */
var SCHEMA = {
  Users: ['Username', 'Name', 'Email', 'Role', 'EmployeeID', 'Branches', 'Active', 'MustChange', 'PasswordHash', 'Salt', 'LastLogin', 'CreatedAt'],
  Employees: ['EmployeeID', 'LastName', 'FirstName', 'MiddleName', 'Suffix', 'Gender', 'BirthDate', 'CivilStatus', 'Contact', 'Email', 'Address',
    'EmergencyName', 'EmergencyRelation', 'EmergencyContact',
    'Position', 'Department', 'Branch', 'HQ', 'DistrictManager', 'DateHired', 'EmploymentType', 'Status',
    'RegularizationDate', 'ContractEnd', 'SeparationDate', 'SeparationReason',
    'SalaryType', 'BasicSalary', 'Allowance', 'SSS', 'PhilHealth', 'PagIBIG', 'TIN', 'BankAccount',
    'ShiftStart', 'ShiftEnd', 'RestDays', 'Remarks', 'CreatedAt', 'UpdatedAt'],
  Attendance: ['ID', 'Date', 'EmployeeID', 'EmployeeName', 'Branch', 'TimeIn', 'TimeOut', 'InLat', 'InLng', 'InDistance', 'InSelfie',
    'OutLat', 'OutLng', 'OutDistance', 'OutSelfie', 'Hours', 'LateMins', 'UndertimeMins', 'OTHours', 'Status', 'Source', 'Remarks'],
  Corrections: ['ID', 'EmployeeID', 'EmployeeName', 'Branch', 'Date', 'TimeIn', 'TimeOut', 'Reason', 'Status',
    'ManagerBy', 'ManagerAt', 'ManagerNote', 'HRBy', 'HRAt', 'HRNote', 'CreatedAt'],
  Leaves: ['ID', 'EmployeeID', 'EmployeeName', 'Branch', 'LeaveType', 'StartDate', 'EndDate', 'Days', 'Reason', 'AttachmentId', 'Status',
    'ManagerBy', 'ManagerAt', 'ManagerNote', 'HRBy', 'HRAt', 'HRNote', 'CreatedAt'],
  LeaveCredits: ['EmployeeID', 'Year', 'LeaveType', 'Credits'],
  Overtime: ['ID', 'EmployeeID', 'EmployeeName', 'Branch', 'Date', 'StartTime', 'EndTime', 'Hours', 'Reason', 'Status',
    'ManagerBy', 'ManagerAt', 'ManagerNote', 'HRBy', 'HRAt', 'HRNote', 'PayrollPeriod', 'CreatedAt'],
  PayrollPeriods: ['PeriodID', 'Label', 'StartDate', 'EndDate', 'PayDate', 'Status', 'CreatedBy', 'CreatedAt', 'ApprovedBy', 'ApprovedAt', 'ReleasedAt'],
  Payroll: ['PeriodID', 'EmployeeID', 'EmployeeName', 'Branch', 'Position', 'SalaryType', 'BasicSalary', 'DailyRate', 'HourlyRate',
    'WorkDays', 'DaysWorked', 'LeaveDays', 'BasicPay', 'OTHours', 'OTPay', 'HolidayPay', 'NightDiff', 'Allowances',
    'AbsentDays', 'AbsenceDeduction', 'LateMins', 'LateDeduction', 'GrossPay', 'SSS', 'PhilHealth', 'PagIBIG', 'Tax',
    'OtherDeductions', 'TotalDeductions', 'NetPay', 'Status', 'Remarks', 'UpdatedAt'],
  Jobs: ['JobID', 'Title', 'Position', 'Department', 'Branch', 'HQ', 'Slots', 'Description', 'Status', 'PostedDate', 'CreatedBy'],
  Applicants: ['ApplicantID', 'JobID', 'JobTitle', 'Name', 'Email', 'Contact', 'Address', 'Source', 'Stage', 'ResumeId', 'Score', 'Notes',
    'AppliedDate', 'UpdatedAt', 'EmployeeID'],
  Evaluations: ['EvalID', 'EmployeeID', 'EmployeeName', 'Position', 'Branch', 'Period', 'Attendance', 'PatientService', 'ClinicalCompliance',
    'Documentation', 'Teamwork', 'Overall', 'Rating', 'Evaluator', 'Remarks', 'Date'],
  Trainings: ['TrainingID', 'EmployeeID', 'EmployeeName', 'Title', 'Date', 'Trainer', 'Location', 'CertificateId', 'ExpiryDate', 'Status', 'Remarks'],
  Documents: ['DocID', 'EmployeeID', 'EmployeeName', 'DocType', 'FileName', 'FileId', 'IssueDate', 'ExpiryDate', 'UploadedBy', 'UploadedAt', 'Remarks'],
  Requests: ['RequestID', 'EmployeeID', 'EmployeeName', 'Branch', 'Type', 'Details', 'Status', 'HRBy', 'HRNote', 'AttachmentId', 'CreatedAt', 'UpdatedAt'],
  HQs: ['HQ', 'Name', 'Region', 'Head', 'Address', 'Sort'],
  Branches: ['Branch', 'Code', 'Type', 'HQ', 'Region', 'Address', 'Lat', 'Lng', 'Radius', 'Manager', 'Active'],
  Departments: ['Department', 'Head', 'Description', 'Active'],
  Positions: ['Position', 'Department', 'Level', 'Description', 'Active'],
  Holidays: ['Date', 'Name', 'Type'],
  Settings: ['Key', 'Value', 'Note'],
  AuditLog: ['Timestamp', 'User', 'Role', 'Action', 'Module', 'RecordID', 'Details']
};

var _ss = null;
var _cache = {};

function ss_() {
  if (_ss) return _ss;
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  _ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  if (!_ss) throw new Error('Run setup() from the spreadsheet\'s Apps Script editor first.');
  return _ss;
}

function sheet_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('Sheet "' + name + '" is missing. Run setup() again.');
  return sh;
}

function cell_(v) {
  if (v instanceof Date) {
    var hasTime = v.getHours() || v.getMinutes() || v.getSeconds();
    if (v.getFullYear() < 1901) return Utilities.formatDate(v, TZ, 'HH:mm');   // a time-only cell
    return Utilities.formatDate(v, TZ, hasTime ? 'yyyy-MM-dd HH:mm:ss' : 'yyyy-MM-dd');
  }
  return v === null || v === undefined ? '' : String(v);
}

/** All rows as objects (header → text) with _row = sheet row number. Cached per call. */
function table_(name) {
  if (_cache[name]) return _cache[name];
  var sh = sheet_(name);
  var vals = sh.getDataRange().getValues();
  var head = vals.shift() || [];
  var out = [];
  for (var i = 0; i < vals.length; i++) {
    var r = vals[i];
    if (r.join('') === '') continue;
    var o = { _row: i + 2 };
    for (var c = 0; c < head.length; c++) if (head[c]) o[head[c]] = cell_(r[c]);
    out.push(o);
  }
  _cache[name] = out;
  return out;
}

function headers_(name) {
  var sh = sheet_(name);
  return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
}

function strip_(o) {
  var c = {};
  for (var k in o) if (k !== '_row' && o.hasOwnProperty(k)) c[k] = o[k];
  return c;
}

function findBy_(name, col, value, ignoreCase) {
  var v = String(value);
  var rows = table_(name);
  for (var i = 0; i < rows.length; i++) {
    var x = rows[i][col];
    if (ignoreCase ? String(x).toUpperCase() === v.toUpperCase() : String(x) === v) return rows[i];
  }
  return null;
}

function insert_(name, obj) {
  var head = headers_(name);
  var row = head.map(function (h) { return obj[h] === undefined || obj[h] === null ? '' : String(obj[h]); });
  var sh = sheet_(name);
  sh.appendRow(row);
  delete _cache[name];
  return obj;
}

function update_(name, rowNo, patch) {
  var head = headers_(name);
  var sh = sheet_(name);
  var cur = sh.getRange(rowNo, 1, 1, head.length).getValues()[0];
  for (var c = 0; c < head.length; c++) {
    if (patch.hasOwnProperty(head[c])) cur[c] = patch[head[c]] === null || patch[head[c]] === undefined ? '' : String(patch[head[c]]);
  }
  sh.getRange(rowNo, 1, 1, head.length).setValues([cur]);
  delete _cache[name];
}

function deleteRow_(name, rowNo) {
  sheet_(name).deleteRow(rowNo);
  delete _cache[name];
}

/** Runs fn while holding the script lock (all writes go through this). */
function locked_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/** 'LV' → 'LV-2026-0001' (counter per prefix and year, kept in script properties). */
function nextId_(prefix) {
  var y = today_().slice(0, 4);
  var props = PropertiesService.getScriptProperties();
  var key = 'SEQ_' + prefix + '_' + y;
  var n = Number(props.getProperty(key) || 0) + 1;
  props.setProperty(key, String(n));
  return prefix + '-' + y + '-' + ('0000' + n).slice(-4);
}

/** 'RB-0001' style employee numbers. */
function nextEmployeeId_() {
  var pre = setting_('employee_id_prefix', 'RB-');
  var max = 0;
  table_('Employees').forEach(function (e) {
    var m = String(e.EmployeeID).match(/(\d+)$/);
    if (String(e.EmployeeID).indexOf(pre) === 0 && m) max = Math.max(max, Number(m[1]));
  });
  return pre + ('0000' + (max + 1)).slice(-4);
}

/* ------------------------------------------------------------------ dates */

function today_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }
function stamp_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'); }
function nowTime_() { return Utilities.formatDate(new Date(), TZ, 'HH:mm'); }

function parseDate_(s) {
  var m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}
function fmtDate_(d) { return Utilities.formatDate(d, TZ, 'yyyy-MM-dd'); }
function addDays_(s, n) { var d = parseDate_(s); d.setDate(d.getDate() + n); return fmtDate_(d); }
function daysBetween_(a, b) { return Math.round((parseDate_(b) - parseDate_(a)) / 86400000); }
function isDate_(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !!parseDate_(s); }
function isTime_(s) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || '')); }
function mins_(hhmm) { var p = String(hhmm).split(':'); return Number(p[0]) * 60 + Number(p[1]); }
function dayName_(s) { return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][parseDate_(s).getDay()]; }
function round2_(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function num_(v) { var n = Number(v); return isFinite(n) ? n : 0; }

/* ------------------------------------------------------------------ settings */

function setting_(key, fallback) {
  var r = findBy_('Settings', 'Key', key);
  if (!r || r.Value === '') return fallback;
  var v = r.Value;
  if (/^[\[{]/.test(v)) { try { return JSON.parse(v); } catch (e) { return fallback; } }
  return v;
}

/* ------------------------------------------------------------------ files (Google Drive) */

/** Folder next to the spreadsheet: "<spreadsheet folder>/HRIS Files/<sub>". */
function filesFolder_(sub) {
  var props = PropertiesService.getScriptProperties();
  var rootId = props.getProperty('FILES_FOLDER_ID');
  var root;
  if (rootId) {
    try { root = DriveApp.getFolderById(rootId); } catch (e) { root = null; }
  }
  if (!root) {
    var parents = DriveApp.getFileById(ss_().getId()).getParents();
    var base = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
    var it = base.getFoldersByName('HRIS Files');
    root = it.hasNext() ? it.next() : base.createFolder('HRIS Files');
    props.setProperty('FILES_FOLDER_ID', root.getId());
  }
  if (!sub) return root;
  var parts = String(sub).split('/');
  var f = root;
  parts.forEach(function (p) {
    var it2 = f.getFoldersByName(p);
    f = it2.hasNext() ? it2.next() : f.createFolder(p);
  });
  return f;
}

var MAX_FILE_MB = 10;

/** file: { name, mime, data (base64) } → Drive file id */
function saveFile_(file, sub, prefix) {
  if (!file || !file.data) return '';
  var bytes = Utilities.base64Decode(String(file.data).replace(/^data:[^,]*,/, ''));
  need_(bytes.length <= MAX_FILE_MB * 1024 * 1024, 'Files can be up to ' + MAX_FILE_MB + ' MB.');
  var name = (prefix ? prefix + ' - ' : '') + String(file.name || 'file').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
  var blob = Utilities.newBlob(bytes, file.mime || 'application/octet-stream', name);
  return filesFolder_(sub).createFile(blob).getId();
}

/* ------------------------------------------------------------------ audit & e-mail */

function audit_(u, action, module, id, details) {
  try {
    sheet_('AuditLog').appendRow([stamp_(), u ? u.username : '', u ? u.role : '', action, module, String(id || ''),
      String(details || '').slice(0, 500)]);
  } catch (e) { /* never block the action on the log */ }
}

function mail_(to, subject, html) {
  if (String(setting_('email_notifications', 'TRUE')).toUpperCase() !== 'TRUE') return;
  var list = (Array.isArray(to) ? to : [to]).filter(function (x) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(x || '')); });
  if (!list.length) return;
  try {
    var url = '';
    try { url = ScriptApp.getService().getUrl() || ''; } catch (e) { url = ''; }
    MailApp.sendEmail({
      to: list.filter(function (x, i) { return list.indexOf(x) === i; }).join(','),
      subject: '[RB ABC HRIS] ' + subject,
      htmlBody: '<div style="font-family:Arial;font-size:14px;color:#1B2133">' +
        '<div style="background:#C62828;color:#fff;padding:12px 16px;font-weight:bold">' + esc_(subject) + '</div>' +
        '<div style="padding:12px 4px">' + html + '</div>' +
        (url ? '<p><a href="' + url + '" style="color:#1E3A8A;font-weight:bold">Open the HRIS</a></p>' : '') + '</div>'
    });
  } catch (e) { /* quota or bad address — the workflow still goes on */ }
}

function esc_(s) {
  return String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}

function hrEmails_() {
  var list = table_('Users').filter(function (x) { return String(x.Active) === 'TRUE' && (x.Role === 'HR_ADMIN'); })
    .map(function (x) { return x.Email; });
  var extra = setting_('hr_email', '');
  if (extra) list.push(extra);
  return list;
}

function managerUsers_(branch) {
  return table_('Users').filter(function (x) {
    return String(x.Active) === 'TRUE' && x.Role === 'BRANCH_MANAGER' &&
      String(x.Branches || '').split(',').map(function (s) { return s.trim(); }).indexOf(branch) >= 0;
  });
}

function employeeEmail_(empId) {
  var e = findBy_('Employees', 'EmployeeID', empId);
  if (e && e.Email) return e.Email;
  var u = findBy_('Users', 'EmployeeID', empId);
  return u ? u.Email : '';
}
