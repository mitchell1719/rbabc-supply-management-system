/**
 * RB ABC HRIS — Google Apps Script web app on a Google Sheet.
 * The whole server side is in this one file; the whole page is in Index.html.
 *
 * Sections (search for "SECTION:"):
 *   1. web app, login / sessions, router, roles & permissions
 *   2. sheet "tables": schema, read / insert / update, ids, files, audit log, e-mail
 *   3. employees, attendance, leave, overtime, approvals, recruitment, performance,
 *      training, documents, requests, organization, settings, users
 *   4. payroll: periods, computation (SSS, PhilHealth, Pag-IBIG, tax), payslips
 *   5. dashboard, notifications, reports
 *   6. setup(): creates every sheet, seeds HQs / branches / settings and the first admin; dailyJobs()
 *
 * Every rule (who may see or change what) is checked here on the server; the
 * browser only shows what the server returns.
 */

var TZ = 'Asia/Manila';
var SESSION_HOURS = 6;

/* ================================================================== SECTION: 1. web app, login, router, roles */

/* ------------------------------------------------------------------ roles */

var ROLES = ['SUPER_ADMIN', 'HR_ADMIN', 'BRANCH_MANAGER', 'EMPLOYEE'];

var ROLE_LABELS = {
  SUPER_ADMIN: 'Super Admin',
  HR_ADMIN: 'HR Admin',
  BRANCH_MANAGER: 'Branch Manager',
  EMPLOYEE: 'Employee'
};

/** Shown on Settings → Roles & Permissions. The checks themselves are in each function. */
var ROLE_MATRIX = [
  ['Dashboard',            'All',  'All',  'Own branches',     'Own'],
  ['Employees',            'Edit', 'Edit', 'View (no salary / gov. IDs)', 'Own profile'],
  ['Attendance',           'All',  'All',  'View + approve corrections', 'Own (selfie time in / out)'],
  ['Leave',                'Approve', 'Final approval', 'Approve (1st level)', 'Own requests'],
  ['Overtime',             'Approve', 'Final approval', 'Approve (1st level)', 'Own requests'],
  ['Payroll',              'All',  'Prepare / approve / release', 'View limited (no amounts)', 'Own released payslips'],
  ['Recruitment',          'All',  'All',  '—',                '—'],
  ['Performance',          'All',  'All',  'Evaluate own branches', 'Own evaluations'],
  ['Training',             'All',  'All',  'View own branches', 'Own trainings'],
  ['Documents',            'All',  'All',  'View own branches', 'Own documents'],
  ['Employee requests',    'All',  'Process', '—',             'Own requests'],
  ['Departments / positions / branches', 'Edit', 'Edit', 'View', '—'],
  ['Reports',              'All',  'All',  'Own branches',     '—'],
  ['HR settings',          'Edit', '—',    '—',                '—'],
  ['User management',      'Edit', '—',    '—',                '—'],
  ['Audit logs',           'View', '—',    '—',                '—']
];

function isSuper_(u) { return u.role === 'SUPER_ADMIN'; }
function isHR_(u) { return u.role === 'SUPER_ADMIN' || u.role === 'HR_ADMIN'; }
function isMgr_(u) { return u.role === 'BRANCH_MANAGER'; }

function need_(cond, msg) { if (!cond) throw new Error(msg || 'This action is not available for your account.'); }
function needHR_(u) { need_(isHR_(u), 'Only HR can do this.'); }
function needSuper_(u) { need_(isSuper_(u), 'Only the Super Admin can do this.'); }

/** Branches a manager covers (Users.Branches, comma separated). */
function mgrBranches_(u) {
  return String(u.branches || '').split(',').map(function (s) { return s.trim(); }).filter(String);
}

/** Can this account see the employee record e? */
function canSeeEmp_(u, e) {
  if (!e) return false;
  if (isHR_(u)) return true;
  if (u.employeeId && e.EmployeeID === u.employeeId) return true;
  if (isMgr_(u)) return mgrBranches_(u).indexOf(e.Branch) >= 0;
  return false;
}

/** Managers act on their branches' staff, never on their own requests. */
function canManage_(u, e) {
  if (isHR_(u)) return true;
  return isMgr_(u) && e && e.EmployeeID !== u.employeeId && mgrBranches_(u).indexOf(e.Branch) >= 0;
}

/* ------------------------------------------------------------------ web app */

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle(setting_('portal_title', 'RB ABC HRIS'))
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}


/* ------------------------------------------------------------------ login & sessions */

function hash_(password, salt) {
  var s = salt + '|' + password;
  for (var i = 0; i < 300; i++) {
    s = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8));
  }
  return s;
}

function newSalt_() { return Utilities.getUuid().replace(/-/g, ''); }

function login(username, password) {
  var key = 'FAIL_' + String(username || '').trim().toUpperCase();
  var cache = CacheService.getScriptCache();
  var fails = Number(cache.get(key) || 0);
  if (fails >= 5) throw new Error('Too many wrong attempts. Try again in 10 minutes.');
  var row = findBy_('Users', 'Username', String(username || '').trim(), true);
  if (!row || String(row.Active) !== 'TRUE' || hash_(String(password || ''), row.Salt) !== row.PasswordHash) {
    cache.put(key, String(fails + 1), 600);
    if (row && String(row.Active) !== 'TRUE') throw new Error('This account is inactive. Please contact HR.');
    throw new Error('Wrong username or password.');
  }
  cache.remove(key);
  var token = Utilities.getUuid();
  var sess = { username: row.Username, name: row.Name, role: row.Role, employeeId: row.EmployeeID || '',
               branches: row.Branches || '', email: row.Email || '', mustChange: String(row.MustChange) === 'TRUE' };
  cache.put('S_' + token, JSON.stringify(sess), SESSION_HOURS * 3600);
  update_('Users', row._row, { LastLogin: stamp_() });
  audit_(sess, 'LOGIN', 'Users', row.Username, '');
  return { token: token, me: me_(sess) };
}

function logout(token) {
  CacheService.getScriptCache().remove('S_' + token);
  return true;
}

function session_(token) {
  if (!token) throw new Error('SESSION: Please log in.');
  var cache = CacheService.getScriptCache();
  var raw = cache.get('S_' + token);
  if (!raw) throw new Error('SESSION: Your session expired. Please log in again.');
  cache.put('S_' + token, raw, SESSION_HOURS * 3600);
  return JSON.parse(raw);
}

function me_(u) {
  var emp = u.employeeId ? findBy_('Employees', 'EmployeeID', u.employeeId) : null;
  return {
    username: u.username, name: u.name, role: u.role, roleLabel: ROLE_LABELS[u.role] || u.role,
    employeeId: u.employeeId, branches: mgrBranches_(u), mustChange: !!u.mustChange,
    employee: emp ? { EmployeeID: emp.EmployeeID, FullName: fullName_(emp), Position: emp.Position, Branch: emp.Branch } : null,
    title: setting_('portal_title', 'RB ABC HRIS'),
    company: setting_('company_name', 'RB ABC HOLDING OPC')
  };
}

function changePassword_(u, p) {
  var row = findBy_('Users', 'Username', u.username, true);
  need_(row, 'Account not found.');
  need_(hash_(String(p.current || ''), row.Salt) === row.PasswordHash, 'Current password is wrong.');
  var next = String(p.next || '');
  need_(next.length >= 8, 'New password must be at least 8 characters.');
  need_(next === String(p.confirm || ''), 'New passwords do not match.');
  need_(next !== p.current, 'Choose a password different from the current one.');
  var salt = newSalt_();
  update_('Users', row._row, { Salt: salt, PasswordHash: hash_(next, salt), MustChange: 'FALSE' });
  u.mustChange = false;
  audit_(u, 'PASSWORD CHANGED', 'Users', u.username, '');
  return 'Password changed.';
}

/* ------------------------------------------------------------------ router */

/**
 * The browser calls api(token, action, payload) for everything after login.
 * Each action receives the session user and the payload. Handlers in other files are
 * named as strings: Apps Script loads the files one by one, so they are looked up at call time.
 */
var ACTIONS = {
  me: function (u) { return me_(u); },
  changePassword: 'changePassword_',

  dashboard: 'dashboard_',
  notifications: 'notifications_',

  employeesList: 'employeesList_',
  employeeGet: 'employeeGet_',
  employeeSave: 'employeeSave_',
  employeeSetStatus: 'employeeSetStatus_',
  lookups: 'lookups_',

  attendanceToday: 'attendanceToday_',
  attendanceList: 'attendanceList_',
  attendanceMine: 'attendanceMine_',
  attendanceLog: 'attendanceLog_',
  attendanceManual: 'attendanceManual_',
  attendanceSummary: 'attendanceSummary_',
  correctionSubmit: 'correctionSubmit_',
  correctionsList: 'correctionsList_',

  leaveList: 'leaveList_',
  leaveSubmit: 'leaveSubmit_',
  leaveBalances: 'leaveBalances_',
  leaveCreditsSave: 'leaveCreditsSave_',

  overtimeList: 'overtimeList_',
  overtimeSubmit: 'overtimeSubmit_',

  approve: 'approve_',
  cancelRequest: 'cancelRequest_',

  payrollPeriods: 'payrollPeriods_',
  payrollPeriodCreate: 'payrollPeriodCreate_',
  payrollGenerate: 'payrollGenerate_',
  payrollLines: 'payrollLines_',
  payrollLineSave: 'payrollLineSave_',
  payrollSetStatus: 'payrollSetStatus_',
  payslipsMine: 'payslipsMine_',

  jobsList: 'jobsList_',
  jobSave: 'jobSave_',
  applicantsList: 'applicantsList_',
  applicantSave: 'applicantSave_',
  applicantStage: 'applicantStage_',
  applicantHire: 'applicantHire_',

  evaluationsList: 'evaluationsList_',
  evaluationSave: 'evaluationSave_',

  trainingsList: 'trainingsList_',
  trainingSave: 'trainingSave_',

  documentsList: 'documentsList_',
  documentUpload: 'documentUpload_',
  documentDelete: 'documentDelete_',
  fileUrl: 'fileUrl_',

  requestsList: 'requestsList_',
  requestSubmit: 'requestSubmit_',
  requestAction: 'requestAction_',

  orgGet: 'orgGet_',
  orgSave: 'orgSave_',
  orgDelete: 'orgDelete_',

  report: 'report_',

  settingsGet: 'settingsGet_',
  settingsSave: 'settingsSave_',
  usersList: 'usersList_',
  userSave: 'userSave_',
  userResetPassword: 'userResetPassword_',
  roles: function () { return { roles: ROLES.map(function (r) { return { id: r, label: ROLE_LABELS[r] }; }), matrix: ROLE_MATRIX }; },
  auditList: 'auditList_'
};

function api(token, action, payload) {
  var u = session_(token);
  var fn = ACTIONS.hasOwnProperty(action) ? ACTIONS[action] : null;
  if (typeof fn === 'string') fn = globalThis[fn];
  if (typeof fn !== 'function') throw new Error('Unknown action: ' + action);
  if (u.mustChange && action !== 'changePassword' && action !== 'me') {
    throw new Error('Please change your temporary password first.');
  }
  var out = fn(u, payload || {});
  if (action === 'changePassword') {
    CacheService.getScriptCache().put('S_' + token, JSON.stringify(u), SESSION_HOURS * 3600);
  }
  // google.script.run cannot send Date objects reliably; everything goes back as plain JSON
  return JSON.parse(JSON.stringify(out === undefined ? null : out));
}


/* ================================================================== SECTION: 2. sheet tables, files, audit, e-mail */

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


/* ================================================================== SECTION: 3. HR modules */

/* =====================================================================
 * Employees, attendance, leave, overtime, approvals, recruitment,
 * performance, training, documents, requests, organization, settings, users
 * ===================================================================== */

var EMPLOYMENT_TYPES = ['Regular', 'Probationary', 'Contractual', 'Project-based', 'Part-time', 'Intern'];
var EMPLOYEE_STATUSES = ['Active', 'On Leave', 'Suspended', 'Resigned', 'Terminated', 'End of Contract', 'Retired'];
var ACTIVE_STATUSES = ['Active', 'On Leave', 'Suspended'];
var LEAVE_TYPES = ['Vacation Leave', 'Sick Leave', 'Emergency Leave', 'Maternity Leave', 'Paternity Leave', 'Bereavement Leave', 'Other Leave'];
var REQUEST_TYPES = ['Certificate of Employment', 'Certificate of Compensation', 'Salary Certificate', 'Employment Verification',
  'ID Replacement', 'Schedule Change', 'Other HR Request'];
var REQUEST_STATUSES = ['Submitted', 'In Review', 'Approved', 'Completed', 'Rejected'];
var DOC_TYPES = ['Employment Contract', 'Resume', 'Valid ID', 'Government ID', 'Medical Certificate', 'Training Certificate',
  'PRC License', 'DOH Certificate', 'NBI Clearance', 'Other Document'];
var STAGES = ['Applied', 'Screening', 'Interview', 'Assessment', 'Final Interview', 'Job Offer', 'Hired', 'Rejected', 'Withdrawn'];
var EVAL_CRITERIA = [['Attendance', 'Attendance'], ['PatientService', 'Patient Service'], ['ClinicalCompliance', 'Clinical Compliance'],
  ['Documentation', 'Documentation'], ['Teamwork', 'Teamwork']];

/* Sensitive employee fields: HR (and the employee) only. */
var SENSITIVE = ['BirthDate', 'CivilStatus', 'Address', 'EmergencyName', 'EmergencyRelation', 'EmergencyContact',
  'SalaryType', 'BasicSalary', 'Allowance', 'SSS', 'PhilHealth', 'PagIBIG', 'TIN', 'BankAccount', 'SeparationReason', 'Remarks'];

function fullName_(e) {
  if (!e) return '';
  return [e.FirstName, e.MiddleName ? e.MiddleName.charAt(0) + '.' : '', e.LastName, e.Suffix].filter(String).join(' ');
}

function isActiveEmp_(e) { return ACTIVE_STATUSES.indexOf(e.Status) >= 0; }

function emp_(id) {
  var e = findBy_('Employees', 'EmployeeID', id, true);
  need_(e, 'Employee ' + id + ' not found.');
  return e;
}

/** Employees this account may see, as objects safe to send to the browser. */
function visibleEmployees_(u) {
  return table_('Employees').filter(function (e) { return canSeeEmp_(u, e); });
}

function publicEmp_(u, e) {
  var o = strip_(e);
  o.FullName = fullName_(e);
  if (!isHR_(u) && e.EmployeeID !== u.employeeId) SENSITIVE.forEach(function (k) { delete o[k]; });
  return o;
}

/** Rows of a request sheet the account may see: HR all · manager own branches · employee own. */
function scoped_(u, rows) {
  if (isHR_(u)) return rows;
  var br = mgrBranches_(u);
  return rows.filter(function (r) {
    return r.EmployeeID === u.employeeId || (isMgr_(u) && br.indexOf(r.Branch) >= 0);
  });
}

function byNewest_(key) { return function (a, b) { return String(b[key]).localeCompare(String(a[key])); }; }

/* ------------------------------------------------------------------ lookups */

function lookups_(u) {
  return {
    hqs: table_('HQs').map(strip_).sort(function (a, b) { return num_(a.Sort) - num_(b.Sort); }),
    branches: table_('Branches').filter(function (b) { return String(b.Active) !== 'FALSE'; })
      .map(function (b) { return { Branch: b.Branch, Code: b.Code, Type: b.Type, HQ: b.HQ, Lat: b.Lat, Lng: b.Lng, Radius: b.Radius }; }),
    departments: table_('Departments').filter(function (d) { return String(d.Active) !== 'FALSE'; }).map(function (d) { return d.Department; }),
    positions: table_('Positions').filter(function (p) { return String(p.Active) !== 'FALSE'; }).map(function (p) { return { Position: p.Position, Department: p.Department }; }),
    employees: visibleEmployees_(u).filter(isActiveEmp_).map(function (e) {
      return { EmployeeID: e.EmployeeID, FullName: fullName_(e), Branch: e.Branch, Position: e.Position };
    }).sort(function (a, b) { return a.FullName.localeCompare(b.FullName); }),
    employmentTypes: EMPLOYMENT_TYPES, statuses: EMPLOYEE_STATUSES, leaveTypes: LEAVE_TYPES, requestTypes: REQUEST_TYPES,
    requestStatuses: REQUEST_STATUSES, docTypes: DOC_TYPES, stages: STAGES,
    criteria: EVAL_CRITERIA.map(function (c) { return { key: c[0], label: c[1] }; }),
    shift: setting_('default_shift', { start: '08:00', end: '17:00', graceMins: 15, restDays: 'Sun' })
  };
}

/* ------------------------------------------------------------------ employees */

function employeesList_(u, p) {
  var q = String(p.q || '').toLowerCase();
  return visibleEmployees_(u).filter(function (e) {
    if (p.status === 'active' && !isActiveEmp_(e)) return false;
    if (p.status && p.status !== 'active' && e.Status !== p.status) return false;
    if (p.branch && e.Branch !== p.branch) return false;
    if (p.hq && e.HQ !== p.hq) return false;
    if (p.type && e.EmploymentType !== p.type) return false;
    if (q && (e.EmployeeID + ' ' + fullName_(e) + ' ' + e.Position + ' ' + e.Branch).toLowerCase().indexOf(q) < 0) return false;
    return true;
  }).map(function (e) {
    return { EmployeeID: e.EmployeeID, FullName: fullName_(e), Position: e.Position, Department: e.Department, Branch: e.Branch,
             HQ: e.HQ, EmploymentType: e.EmploymentType, Status: e.Status, DateHired: e.DateHired, Email: e.Email, Contact: e.Contact };
  }).sort(function (a, b) { return a.EmployeeID.localeCompare(b.EmployeeID); });
}

function employeeGet_(u, p) {
  var e = emp_(p.id);
  need_(canSeeEmp_(u, e), 'You cannot open this employee.');
  var id = e.EmployeeID;
  var own = function (name) { return table_(name).filter(function (r) { return r.EmployeeID === id; }).map(strip_); };
  var showDocs = isHR_(u) || u.employeeId === id || isMgr_(u);
  return {
    employee: publicEmp_(u, e),
    canEdit: isHR_(u),
    canSeeSensitive: isHR_(u) || u.employeeId === id,
    account: isHR_(u) ? (function () { var a = findBy_('Users', 'EmployeeID', id); return a ? { Username: a.Username, Role: a.Role, Active: a.Active } : null; })() : null,
    documents: showDocs ? own('Documents').sort(byNewest_('UploadedAt')) : [],
    trainings: own('Trainings').sort(byNewest_('Date')),
    evaluations: own('Evaluations').sort(byNewest_('Date')),
    leaves: own('Leaves').sort(byNewest_('StartDate')).slice(0, 20),
    balances: leaveBalanceFor_(id, today_().slice(0, 4)),
    attendance: own('Attendance').sort(byNewest_('Date')).slice(0, 31)
  };
}

function employeeSave_(u, p) {
  needHR_(u);
  var e = p.employee || {};
  ['LastName', 'FirstName'].forEach(function (k) { need_(String(e[k] || '').trim(), 'Enter the ' + (k === 'LastName' ? 'last' : 'first') + ' name.'); });
  need_(String(e.Position || '').trim(), 'Choose the position.');
  need_(String(e.Branch || '').trim(), 'Choose the branch / office.');
  need_(isDate_(e.DateHired), 'Enter the date hired.');
  need_(EMPLOYMENT_TYPES.indexOf(e.EmploymentType) >= 0, 'Choose the employment type.');
  ['BirthDate', 'RegularizationDate', 'ContractEnd', 'SeparationDate'].forEach(function (k) {
    need_(!e[k] || isDate_(e[k]), k.replace(/([A-Z])/g, ' $1').trim() + ' must be a date.');
  });
  ['ShiftStart', 'ShiftEnd'].forEach(function (k) { need_(!e[k] || isTime_(e[k]), 'Shift times must be like 08:00.'); });
  need_(!e.Email || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e.Email), 'Enter a valid e-mail address.');
  need_(!e.BasicSalary || num_(e.BasicSalary) >= 0, 'Basic salary must be a number.');
  var br = findBy_('Branches', 'Branch', e.Branch);
  need_(br, 'Unknown branch / office.');
  var fields = SCHEMA.Employees.filter(function (k) { return ['EmployeeID', 'CreatedAt', 'UpdatedAt'].indexOf(k) < 0; });
  var rec = {};
  fields.forEach(function (k) { rec[k] = e[k] === undefined ? '' : String(e[k]).trim(); });
  rec.HQ = br.HQ;
  rec.Status = EMPLOYEE_STATUSES.indexOf(rec.Status) >= 0 ? rec.Status : 'Active';
  rec.SalaryType = rec.SalaryType === 'Daily' ? 'Daily' : 'Monthly';
  rec.UpdatedAt = stamp_();
  return locked_(function () {
    if (e.EmployeeID) {
      var cur = emp_(e.EmployeeID);
      update_('Employees', cur._row, rec);
      audit_(u, 'UPDATE', 'Employees', cur.EmployeeID, fullName_(rec));
      return { id: cur.EmployeeID, msg: 'Employee saved.' };
    }
    rec.EmployeeID = String(e.NewID || '').trim() || nextEmployeeId_();
    need_(!findBy_('Employees', 'EmployeeID', rec.EmployeeID, true), 'Employee ID ' + rec.EmployeeID + ' already exists.');
    rec.CreatedAt = stamp_();
    insert_('Employees', rec);
    audit_(u, 'CREATE', 'Employees', rec.EmployeeID, fullName_(rec));
    return { id: rec.EmployeeID, msg: 'Employee ' + rec.EmployeeID + ' added.' };
  });
}

function employeeSetStatus_(u, p) {
  needHR_(u);
  need_(EMPLOYEE_STATUSES.indexOf(p.status) >= 0, 'Choose a status.');
  return locked_(function () {
    var e = emp_(p.id);
    var patch = { Status: p.status, UpdatedAt: stamp_() };
    if (ACTIVE_STATUSES.indexOf(p.status) < 0) {
      need_(isDate_(p.date), 'Enter the separation date.');
      patch.SeparationDate = p.date; patch.SeparationReason = String(p.reason || '');
      var acct = findBy_('Users', 'EmployeeID', e.EmployeeID);
      if (acct) update_('Users', acct._row, { Active: 'FALSE' });
    } else if (p.status === 'Active' && e.EmploymentType === 'Probationary' && p.regularize) {
      patch.EmploymentType = 'Regular'; patch.RegularizationDate = isDate_(p.date) ? p.date : today_();
    }
    update_('Employees', e._row, patch);
    audit_(u, 'STATUS ' + p.status.toUpperCase(), 'Employees', e.EmployeeID, p.reason || '');
    return 'Status updated.';
  });
}

/* ------------------------------------------------------------------ attendance */

function shiftOf_(e) {
  var d = setting_('default_shift', { start: '08:00', end: '17:00', graceMins: 15, restDays: 'Sun' });
  return { start: e.ShiftStart || d.start, end: e.ShiftEnd || d.end, grace: num_(d.graceMins),
           rest: String(e.RestDays || d.restDays || '').split(',').map(function (s) { return s.trim(); }).filter(String) };
}

function holidayOn_(date) { return findBy_('Holidays', 'Date', date); }

function onLeave_(empId, date) {
  return table_('Leaves').some(function (l) {
    return l.EmployeeID === empId && l.Status === 'Approved' && l.StartDate <= date && l.EndDate >= date;
  });
}

function distanceM_(lat1, lng1, lat2, lng2) {
  var R = 6371000, toR = Math.PI / 180;
  var dLat = (lat2 - lat1) * toR, dLng = (lng2 - lng1) * toR;
  var a = Math.pow(Math.sin(dLat / 2), 2) + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.pow(Math.sin(dLng / 2), 2);
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

/** Late / undertime / hours / OT of one attendance row. */
function computeDay_(e, rec) {
  var sh = shiftOf_(e);
  var out = { LateMins: 0, UndertimeMins: 0, Hours: '', OTHours: 0, Status: 'Present' };
  if (rec.TimeIn) {
    var late = mins_(rec.TimeIn) - mins_(sh.start);
    out.LateMins = late > sh.grace ? late : 0;
    if (out.LateMins) out.Status = 'Late';
  }
  if (rec.TimeIn && rec.TimeOut) {
    var worked = mins_(rec.TimeOut) - mins_(rec.TimeIn);
    if (worked < 0) worked += 24 * 60;                      // overnight shift
    var shiftLen = mins_(sh.end) - mins_(sh.start); if (shiftLen <= 0) shiftLen += 24 * 60;
    var breakMins = shiftLen > 6 * 60 ? 60 : 0;
    out.Hours = round2_(Math.max(0, worked - (worked > 6 * 60 ? breakMins : 0)) / 60);
    var under = mins_(sh.end) - mins_(rec.TimeOut);
    out.UndertimeMins = under > 0 && under < 12 * 60 ? under : 0;
    var ot = mins_(rec.TimeOut) - mins_(sh.end);
    out.OTHours = ot >= 30 && ot < 12 * 60 ? round2_(ot / 60) : 0;
  } else if (rec.TimeIn) {
    out.Status = rec.Date < today_() ? 'Incomplete' : (out.LateMins ? 'Late' : 'Present');
  }
  if (holidayOn_(rec.Date)) out.Status += ' (Holiday)';
  else if (sh.rest.indexOf(dayName_(rec.Date)) >= 0) out.Status += ' (Rest Day)';
  return out;
}

/** Selfie time in / out by the employee. p: { action, lat, lng, accuracy, selfie: {name, mime, data} } */
function attendanceLog_(u, p) {
  need_(u.employeeId, 'This account is not linked to an employee record. Ask HR to link it.');
  var e = emp_(u.employeeId);
  need_(isActiveEmp_(e), 'Your employee record is not active.');
  var action = String(p.action || '').toUpperCase();
  need_(action === 'IN' || action === 'OUT', 'Choose TIME IN or TIME OUT.');
  var lat = Number(p.lat), lng = Number(p.lng), acc = Number(p.accuracy || 0);
  need_(isFinite(lat) && isFinite(lng) && !(lat === 0 && lng === 0), 'Cannot get your location. Turn on GPS and allow location, then try again.');
  need_(!(acc > 150), 'GPS signal too weak (±' + Math.round(acc) + ' m). Go near a window or door and try again.');
  need_(p.selfie && p.selfie.data, 'Take a selfie first.');
  var site = findBy_('Branches', 'Branch', e.Branch);
  var dist = '', remark = '';
  if (site && site.Lat !== '' && site.Lng !== '') {
    dist = distanceM_(lat, lng, Number(site.Lat), Number(site.Lng));
    var radius = num_(site.Radius) || 150;
    need_(dist <= radius, 'Too far from ' + e.Branch + ' (' + dist + ' m away, must be within ' + radius + ' m).');
  } else {
    remark = 'Branch location not set — not verified';
  }
  var date = today_(), time = nowTime_();
  return locked_(function () {
    var rows = table_('Attendance').filter(function (r) { return r.EmployeeID === e.EmployeeID && r.Date === date; });
    var open = rows.filter(function (r) { return r.TimeIn && !r.TimeOut; })[0];
    var selfie = saveFile_(p.selfie, 'Selfies/' + date, e.EmployeeID + ' ' + action + ' ' + time.replace(':', ''));
    if (action === 'IN') {
      need_(!open, 'You already timed in at ' + (open ? open.TimeIn : '') + ' today. Use TIME OUT.');
      need_(!rows.length, 'Your attendance today is already complete. File an attendance correction if needed.');
      var rec = { ID: nextId_('AT'), Date: date, EmployeeID: e.EmployeeID, EmployeeName: fullName_(e), Branch: e.Branch, TimeIn: time,
                  InLat: lat, InLng: lng, InDistance: dist, InSelfie: selfie, Source: 'Selfie', Remarks: remark };
      var c = computeDay_(e, rec);
      rec.LateMins = c.LateMins; rec.Status = c.Status;
      insert_('Attendance', rec);
      return 'TIME IN recorded at ' + time + (c.LateMins ? ' (late ' + c.LateMins + ' min)' : '') + '.';
    }
    need_(open, 'No TIME IN today. Use TIME IN first, or file an attendance correction.');
    var upd = { TimeOut: time, OutLat: lat, OutLng: lng, OutDistance: dist, OutSelfie: selfie };
    var merged = Object.assign({}, open, upd);
    var c2 = computeDay_(e, merged);
    upd.Hours = c2.Hours; upd.LateMins = c2.LateMins; upd.UndertimeMins = c2.UndertimeMins; upd.OTHours = c2.OTHours; upd.Status = c2.Status;
    if (remark && open.Remarks.indexOf(remark) < 0) upd.Remarks = [open.Remarks, remark].filter(String).join(' · ');
    update_('Attendance', open._row, upd);
    return 'TIME OUT recorded at ' + time + ' (' + c2.Hours + ' hrs' + (c2.UndertimeMins ? ', undertime ' + c2.UndertimeMins + ' min' : '') +
      (c2.OTHours ? ', ' + c2.OTHours + ' hrs beyond shift — file an OT request to be paid' : '') + ').';
  });
}

function attendanceMine_(u) {
  need_(u.employeeId, 'This account is not linked to an employee record.');
  var e = emp_(u.employeeId);
  var date = today_();
  var rows = table_('Attendance').filter(function (r) { return r.EmployeeID === e.EmployeeID; }).sort(byNewest_('Date'));
  return {
    today: date, shift: shiftOf_(e), branch: e.Branch,
    site: (function () { var b = findBy_('Branches', 'Branch', e.Branch); return b ? { Lat: b.Lat, Lng: b.Lng, Radius: b.Radius } : null; })(),
    todayRow: rows.filter(function (r) { return r.Date === date; }).map(strip_)[0] || null,
    recent: rows.slice(0, 31).map(strip_),
    corrections: table_('Corrections').filter(function (r) { return r.EmployeeID === e.EmployeeID; }).sort(byNewest_('CreatedAt')).slice(0, 20).map(strip_)
  };
}

/** HR enters or fixes a day directly. */
function attendanceManual_(u, p) {
  needHR_(u);
  var e = emp_(p.employeeId);
  need_(isDate_(p.date), 'Enter the date.');
  need_(isTime_(p.timeIn), 'Enter the time in (e.g. 08:00).');
  need_(!p.timeOut || isTime_(p.timeOut), 'Time out must be like 17:00.');
  return locked_(function () { return writeDay_(u, e, p.date, p.timeIn, p.timeOut, 'Manual', p.remarks || 'Entered by HR'); });
}

function writeDay_(u, e, date, tin, tout, source, remarks) {
  var cur = table_('Attendance').filter(function (r) { return r.EmployeeID === e.EmployeeID && r.Date === date; })[0];
  var rec = { Date: date, EmployeeID: e.EmployeeID, EmployeeName: fullName_(e), Branch: e.Branch, TimeIn: tin, TimeOut: tout || '' };
  var c = computeDay_(e, rec);
  rec.Hours = c.Hours; rec.LateMins = c.LateMins; rec.UndertimeMins = c.UndertimeMins; rec.OTHours = c.OTHours; rec.Status = c.Status;
  rec.Source = source; rec.Remarks = remarks;
  if (cur) update_('Attendance', cur._row, rec);
  else { rec.ID = nextId_('AT'); insert_('Attendance', rec); }
  audit_(u, source.toUpperCase(), 'Attendance', e.EmployeeID, date + ' ' + tin + '–' + (tout || ''));
  return 'Attendance for ' + fullName_(e) + ' on ' + date + ' saved.';
}

/** Today's board: present / late / absent / on leave / rest day / holiday for the visible employees. */
function attendanceToday_(u, p) {
  var date = isDate_(p.date) ? p.date : today_();
  var emps = visibleEmployees_(u).filter(function (e) { return e.Status === 'Active' || e.Status === 'On Leave'; });
  if (p.branch) emps = emps.filter(function (e) { return e.Branch === p.branch; });
  var att = {};
  table_('Attendance').forEach(function (r) { if (r.Date === date) att[r.EmployeeID] = r; });
  var hol = holidayOn_(date);
  var counts = { Present: 0, Late: 0, Absent: 0, 'On Leave': 0, 'Rest Day': 0, Holiday: 0, 'Not yet in': 0 };
  var list = emps.map(function (e) {
    var r = att[e.EmployeeID], st;
    if (r) st = r.LateMins > 0 ? 'Late' : 'Present';
    else if (onLeave_(e.EmployeeID, date)) st = 'On Leave';
    else if (hol) st = 'Holiday';
    else if (shiftOf_(e).rest.indexOf(dayName_(date)) >= 0) st = 'Rest Day';
    else if (date === today_() && nowTime_() < shiftOf_(e).end) st = 'Not yet in';
    else st = 'Absent';
    counts[st]++;
    return { EmployeeID: e.EmployeeID, FullName: fullName_(e), Branch: e.Branch, Position: e.Position, State: st,
             TimeIn: r ? r.TimeIn : '', TimeOut: r ? r.TimeOut : '', Hours: r ? r.Hours : '', LateMins: r ? r.LateMins : '',
             Remarks: r ? r.Remarks : '' };
  });
  return { date: date, holiday: hol ? hol.Name : '', counts: counts, list: list };
}

function attendanceList_(u, p) {
  var from = isDate_(p.from) ? p.from : addDays_(today_(), -6), to = isDate_(p.to) ? p.to : today_();
  need_(daysBetween_(from, to) <= 92, 'Choose up to 3 months at a time.');
  var ids = {};
  visibleEmployees_(u).forEach(function (e) { ids[e.EmployeeID] = e; });
  return table_('Attendance').filter(function (r) {
    return ids[r.EmployeeID] && r.Date >= from && r.Date <= to && (!p.branch || r.Branch === p.branch) && (!p.employeeId || r.EmployeeID === p.employeeId);
  }).sort(function (a, b) { return (b.Date + b.TimeIn).localeCompare(a.Date + a.TimeIn); }).map(strip_);
}

/** Monthly summary per employee: days present, late, undertime, absences, leave, OT. */
function attendanceSummary_(u, p) {
  var month = /^\d{4}-\d{2}$/.test(String(p.month || '')) ? p.month : today_().slice(0, 7);
  var from = month + '-01';
  var d = parseDate_(from); d.setMonth(d.getMonth() + 1); d.setDate(0);
  var to = fmtDate_(d);
  var last = to < today_() ? to : today_();
  var emps = visibleEmployees_(u).filter(isActiveEmp_);
  if (p.branch) emps = emps.filter(function (e) { return e.Branch === p.branch; });
  var att = {};
  table_('Attendance').forEach(function (r) { if (r.Date >= from && r.Date <= to) (att[r.EmployeeID] = att[r.EmployeeID] || {})[r.Date] = r; });
  var rows = emps.map(function (e) {
    var s = { EmployeeID: e.EmployeeID, FullName: fullName_(e), Branch: e.Branch, WorkDays: 0, Present: 0, Late: 0, LateMins: 0,
              UndertimeMins: 0, Absent: 0, Leave: 0, Hours: 0, OTHours: 0, Incomplete: 0 };
    var sh = shiftOf_(e);
    for (var day = from; day <= last; day = addDays_(day, 1)) {
      if (e.DateHired && day < e.DateHired) continue;
      var r = (att[e.EmployeeID] || {})[day];
      var rest = sh.rest.indexOf(dayName_(day)) >= 0 || !!holidayOn_(day);
      if (!rest) s.WorkDays++;
      if (r) {
        s.Present++; if (num_(r.LateMins) > 0) { s.Late++; s.LateMins += num_(r.LateMins); }
        s.UndertimeMins += num_(r.UndertimeMins); s.Hours += num_(r.Hours); s.OTHours += num_(r.OTHours);
        if (!r.TimeOut && day < today_()) s.Incomplete++;
      } else if (!rest) {
        if (onLeave_(e.EmployeeID, day)) s.Leave++; else if (day < today_()) s.Absent++;
      }
    }
    s.Hours = round2_(s.Hours); s.OTHours = round2_(s.OTHours);
    return s;
  });
  return { month: month, from: from, to: to, rows: rows };
}

/* ------------------------------------------------------------------ approvals (leave, overtime, corrections) */

/** First step: the branch manager when one covers the branch (and is not the requester), else HR. */
function firstStatus_(e) {
  var mgrs = managerUsers_(e.Branch).filter(function (m) { return m.EmployeeID !== e.EmployeeID; });
  return mgrs.length ? 'Pending Manager' : 'Pending HR';
}

function notifyFirst_(e, status, what, html) {
  if (status === 'Pending Manager') mail_(managerUsers_(e.Branch).map(function (m) { return m.Email; }), what + ' for approval — ' + fullName_(e), html);
  else mail_(hrEmails_(), what + ' for HR review — ' + fullName_(e), html);
}

function requesterEmp_(u, p) {
  // Employees file for themselves; HR and managers may file on behalf of an employee they manage.
  var id = p.employeeId && (isHR_(u) || isMgr_(u)) ? p.employeeId : u.employeeId;
  need_(id, 'This account is not linked to an employee record. Ask HR to link it.');
  var e = emp_(id);
  need_(id === u.employeeId || canManage_(u, e), 'You cannot file for this employee.');
  need_(isActiveEmp_(e), 'The employee record is not active.');
  return e;
}

var APPROVAL_SHEETS = { leave: 'Leaves', overtime: 'Overtime', correction: 'Corrections' };

/** p: { kind: leave|overtime|correction, id, decision: approve|reject, note } */
function approve_(u, p) {
  var name = APPROVAL_SHEETS[p.kind];
  need_(name, 'Unknown request.');
  var approveIt = p.decision === 'approve';
  need_(approveIt || p.decision === 'reject', 'Choose approve or reject.');
  need_(approveIt || String(p.note || '').trim(), 'Give the reason for rejecting.');
  return locked_(function () {
    var r = findBy_(name, 'ID', p.id);
    need_(r, 'Request not found.');
    var e = emp_(r.EmployeeID);
    var patch = {}, msg;
    if (r.Status === 'Pending Manager') {
      need_(canManage_(u, e), 'Only the branch manager or HR can act on this.');
      if (isHR_(u)) {
        patch = { ManagerBy: u.name + ' (HR)', ManagerAt: stamp_(), ManagerNote: p.note || '', HRBy: u.name, HRAt: stamp_(), HRNote: p.note || '',
                  Status: approveIt ? 'Approved' : 'Rejected' };
      } else {
        patch = { ManagerBy: u.name, ManagerAt: stamp_(), ManagerNote: p.note || '', Status: approveIt ? 'Pending HR' : 'Rejected' };
      }
    } else if (r.Status === 'Pending HR') {
      needHR_(u);
      patch = { HRBy: u.name, HRAt: stamp_(), HRNote: p.note || '', Status: approveIt ? 'Approved' : 'Rejected' };
    } else {
      throw new Error('This request is already ' + r.Status + '.');
    }
    if (patch.Status === 'Approved' && p.kind === 'leave') checkBalance_(r);
    update_(name, r._row, patch);
    if (patch.Status === 'Approved' && p.kind === 'correction') {
      writeDay_(u, e, r.Date, r.TimeIn, r.TimeOut, 'Correction', 'Correction ' + r.ID + ': ' + r.Reason);
    }
    if (patch.Status === 'Approved' && p.kind === 'leave' && r.StartDate <= today_() && r.EndDate >= today_() && e.Status === 'Active') {
      update_('Employees', e._row, { Status: 'On Leave' });
    }
    audit_(u, (approveIt ? 'APPROVE' : 'REJECT') + ' → ' + patch.Status, name, r.ID, p.note || '');
    var label = { leave: r.LeaveType, overtime: 'Overtime request', correction: 'Attendance correction' }[p.kind];
    msg = label + ' ' + r.ID + ' — ' + patch.Status + '.';
    mail_(employeeEmail_(r.EmployeeID), label + ' ' + patch.Status, '<p>' + esc_(label) + ' <b>' + esc_(r.ID) + '</b> is now <b>' + esc_(patch.Status) + '</b>.</p>' +
      (p.note ? '<p>Note: ' + esc_(p.note) + '</p>' : ''));
    if (patch.Status === 'Pending HR') mail_(hrEmails_(), label + ' for HR review — ' + r.EmployeeName, '<p>' + esc_(u.name) + ' endorsed ' + esc_(r.ID) + '.</p>');
    return msg;
  });
}

function cancelRequest_(u, p) {
  var name = APPROVAL_SHEETS[p.kind];
  need_(name, 'Unknown request.');
  return locked_(function () {
    var r = findBy_(name, 'ID', p.id);
    need_(r, 'Request not found.');
    need_(r.EmployeeID === u.employeeId || isHR_(u), 'You can only cancel your own requests.');
    need_(r.Status === 'Pending Manager' || r.Status === 'Pending HR', 'Only pending requests can be cancelled.');
    update_(name, r._row, { Status: 'Cancelled' });
    audit_(u, 'CANCEL', name, r.ID, '');
    return 'Request ' + r.ID + ' cancelled.';
  });
}

function approvalList_(u, name, p) {
  var rows = scoped_(u, table_(name));
  if (p.status === 'pending') rows = rows.filter(function (r) { return r.Status === 'Pending Manager' || r.Status === 'Pending HR'; });
  else if (p.status === 'mine') rows = rows.filter(function (r) { return r.EmployeeID === u.employeeId; });
  else if (p.status === 'action') rows = rows.filter(function (r) { return canAct_(u, r); });
  else if (p.status) rows = rows.filter(function (r) { return r.Status === p.status; });
  if (p.branch) rows = rows.filter(function (r) { return r.Branch === p.branch; });
  return rows.sort(byNewest_('CreatedAt')).slice(0, 500).map(function (r) {
    var o = strip_(r); o.canAct = canAct_(u, r); o.canCancel = (r.EmployeeID === u.employeeId || isHR_(u)) && /^Pending/.test(r.Status); return o;
  });
}

function canAct_(u, r) {
  if (r.Status === 'Pending HR') return isHR_(u);
  if (r.Status === 'Pending Manager') {
    var e = findBy_('Employees', 'EmployeeID', r.EmployeeID);
    return canManage_(u, e);
  }
  return false;
}

/* ------------------------------------------------------------------ leave */

function leaveDays_(e, from, to, halfDay) {
  var sh = shiftOf_(e), n = 0;
  for (var d = from; d <= to; d = addDays_(d, 1)) {
    if (sh.rest.indexOf(dayName_(d)) >= 0 || holidayOn_(d)) continue;
    n++;
  }
  return halfDay && n === 1 ? 0.5 : n;
}

function defaultCredits_() {
  return setting_('leave_credits', { 'Vacation Leave': 5, 'Sick Leave': 5, 'Emergency Leave': 3, 'Maternity Leave': 105,
    'Paternity Leave': 7, 'Bereavement Leave': 3, 'Other Leave': 0 });
}

function leaveBalanceFor_(empId, year) {
  var def = defaultCredits_();
  var own = {};
  table_('LeaveCredits').forEach(function (c) { if (c.EmployeeID === empId && String(c.Year) === String(year)) own[c.LeaveType] = num_(c.Credits); });
  return LEAVE_TYPES.map(function (t) {
    var credits = own.hasOwnProperty(t) ? own[t] : num_(def[t]);
    var used = 0, pending = 0;
    table_('Leaves').forEach(function (l) {
      if (l.EmployeeID !== empId || l.LeaveType !== t || String(l.StartDate).slice(0, 4) !== String(year)) return;
      if (l.Status === 'Approved') used += num_(l.Days);
      if (/^Pending/.test(l.Status)) pending += num_(l.Days);
    });
    return { LeaveType: t, Credits: credits, Used: used, Pending: pending, Balance: round2_(credits - used) };
  });
}

function checkBalance_(r) {
  if (r.LeaveType === 'Other Leave') return;
  var b = leaveBalanceFor_(r.EmployeeID, String(r.StartDate).slice(0, 4)).filter(function (x) { return x.LeaveType === r.LeaveType; })[0];
  if (String(setting_('leave_allow_negative', 'FALSE')).toUpperCase() === 'TRUE') return;
  need_(b.Balance >= num_(r.Days), 'Not enough ' + r.LeaveType + ' balance (' + b.Balance + ' day(s) left). File it as Other Leave (without pay) instead.');
}

function leaveSubmit_(u, p) {
  var e = requesterEmp_(u, p);
  need_(LEAVE_TYPES.indexOf(p.type) >= 0, 'Choose the leave type.');
  need_(isDate_(p.start) && isDate_(p.end), 'Enter the start and end dates.');
  need_(p.start <= p.end, 'The end date is before the start date.');
  need_(daysBetween_(p.start, p.end) <= 120, 'A leave can be up to 120 days.');
  need_(String(p.reason || '').trim(), 'Enter the reason.');
  var days = leaveDays_(e, p.start, p.end, !!p.halfDay);
  need_(days > 0, 'The dates fall on rest days or holidays only.');
  return locked_(function () {
    var overlap = table_('Leaves').some(function (l) {
      return l.EmployeeID === e.EmployeeID && ['Rejected', 'Cancelled'].indexOf(l.Status) < 0 && l.StartDate <= p.end && l.EndDate >= p.start;
    });
    need_(!overlap, 'There is already a leave filed on these dates.');
    var r = { ID: nextId_('LV'), EmployeeID: e.EmployeeID, EmployeeName: fullName_(e), Branch: e.Branch, LeaveType: p.type,
              StartDate: p.start, EndDate: p.end, Days: days, Reason: String(p.reason).trim(), Status: firstStatus_(e), CreatedAt: stamp_() };
    if (isHR_(u) && p.employeeId && p.employeeId !== u.employeeId) r.Status = 'Pending HR';
    var bal = leaveBalanceFor_(e.EmployeeID, p.start.slice(0, 4)).filter(function (x) { return x.LeaveType === p.type; })[0];
    r.AttachmentId = saveFile_(p.attachment, 'Leave/' + e.EmployeeID, r.ID);
    insert_('Leaves', r);
    audit_(u, 'SUBMIT', 'Leaves', r.ID, p.type + ' ' + p.start + '–' + p.end);
    notifyFirst_(e, r.Status, 'Leave request', '<p><b>' + esc_(r.EmployeeName) + '</b> (' + esc_(e.Branch) + ') filed <b>' + esc_(p.type) + '</b>, ' +
      esc_(p.start) + ' to ' + esc_(p.end) + ' (' + days + ' day/s).</p><p>Reason: ' + esc_(r.Reason) + '</p>');
    return 'Leave ' + r.ID + ' submitted (' + days + ' day/s) — ' + r.Status + '.' +
      (bal && p.type !== 'Other Leave' && bal.Balance < days ? ' Note: only ' + bal.Balance + ' day(s) of balance left.' : '');
  });
}

function leaveList_(u, p) { return approvalList_(u, 'Leaves', p); }

function leaveBalances_(u, p) {
  var year = String(p.year || today_().slice(0, 4));
  if (p.employeeId) {
    var e = emp_(p.employeeId);
    need_(canSeeEmp_(u, e), 'You cannot see this employee.');
    return [{ EmployeeID: e.EmployeeID, FullName: fullName_(e), Branch: e.Branch, balances: leaveBalanceFor_(e.EmployeeID, year) }];
  }
  return visibleEmployees_(u).filter(isActiveEmp_).map(function (e) {
    return { EmployeeID: e.EmployeeID, FullName: fullName_(e), Branch: e.Branch, balances: leaveBalanceFor_(e.EmployeeID, year) };
  });
}

/** HR sets an employee's credits for a year. p: { employeeId, year, credits: { type: n } } */
function leaveCreditsSave_(u, p) {
  needHR_(u);
  var e = emp_(p.employeeId);
  var year = String(p.year || today_().slice(0, 4));
  return locked_(function () {
    Object.keys(p.credits || {}).forEach(function (t) {
      need_(LEAVE_TYPES.indexOf(t) >= 0, 'Unknown leave type ' + t);
      var cur = table_('LeaveCredits').filter(function (c) { return c.EmployeeID === e.EmployeeID && String(c.Year) === year && c.LeaveType === t; })[0];
      var v = num_(p.credits[t]);
      if (cur) update_('LeaveCredits', cur._row, { Credits: v });
      else insert_('LeaveCredits', { EmployeeID: e.EmployeeID, Year: year, LeaveType: t, Credits: v });
    });
    audit_(u, 'LEAVE CREDITS', 'LeaveCredits', e.EmployeeID, year + ' ' + JSON.stringify(p.credits));
    return 'Leave credits saved.';
  });
}

/* ------------------------------------------------------------------ overtime */

function overtimeSubmit_(u, p) {
  var e = requesterEmp_(u, p);
  need_(isDate_(p.date), 'Enter the date.');
  need_(isTime_(p.start) && isTime_(p.end), 'Enter the start and end time (e.g. 17:00).');
  var m = mins_(p.end) - mins_(p.start); if (m <= 0) m += 24 * 60;
  var hours = round2_(m / 60);
  need_(hours >= 0.5 && hours <= 12, 'Overtime must be between 30 minutes and 12 hours.');
  need_(String(p.reason || '').trim(), 'Enter the reason.');
  need_(daysBetween_(p.date, today_()) <= 30, 'Overtime must be filed within 30 days.');
  return locked_(function () {
    var dup = table_('Overtime').some(function (o) { return o.EmployeeID === e.EmployeeID && o.Date === p.date && ['Rejected', 'Cancelled'].indexOf(o.Status) < 0; });
    need_(!dup, 'There is already an overtime request on ' + p.date + '.');
    var r = { ID: nextId_('OT'), EmployeeID: e.EmployeeID, EmployeeName: fullName_(e), Branch: e.Branch, Date: p.date, StartTime: p.start,
              EndTime: p.end, Hours: hours, Reason: String(p.reason).trim(), Status: firstStatus_(e), CreatedAt: stamp_() };
    if (isHR_(u) && p.employeeId && p.employeeId !== u.employeeId) r.Status = 'Pending HR';
    insert_('Overtime', r);
    audit_(u, 'SUBMIT', 'Overtime', r.ID, p.date + ' ' + hours + ' hrs');
    notifyFirst_(e, r.Status, 'Overtime request', '<p><b>' + esc_(r.EmployeeName) + '</b> filed overtime on ' + esc_(p.date) + ', ' +
      esc_(p.start) + '–' + esc_(p.end) + ' (' + hours + ' hrs).</p><p>Reason: ' + esc_(r.Reason) + '</p>');
    return 'Overtime ' + r.ID + ' submitted (' + hours + ' hrs) — ' + r.Status + '.';
  });
}

function overtimeList_(u, p) { return approvalList_(u, 'Overtime', p); }

/* ------------------------------------------------------------------ attendance corrections */

function correctionSubmit_(u, p) {
  var e = requesterEmp_(u, p);
  need_(isDate_(p.date) && p.date <= today_(), 'Enter the date (today or earlier).');
  need_(isTime_(p.timeIn), 'Enter the correct time in.');
  need_(!p.timeOut || isTime_(p.timeOut), 'Time out must be like 17:00.');
  need_(String(p.reason || '').trim(), 'Enter the reason.');
  return locked_(function () {
    var r = { ID: nextId_('AC'), EmployeeID: e.EmployeeID, EmployeeName: fullName_(e), Branch: e.Branch, Date: p.date, TimeIn: p.timeIn,
              TimeOut: p.timeOut || '', Reason: String(p.reason).trim(), Status: firstStatus_(e), CreatedAt: stamp_() };
    insert_('Corrections', r);
    audit_(u, 'SUBMIT', 'Corrections', r.ID, p.date);
    notifyFirst_(e, r.Status, 'Attendance correction', '<p><b>' + esc_(r.EmployeeName) + '</b> asks to correct ' + esc_(p.date) + ' to ' +
      esc_(p.timeIn) + '–' + esc_(p.timeOut || '') + '.</p><p>Reason: ' + esc_(r.Reason) + '</p>');
    return 'Attendance correction ' + r.ID + ' submitted — ' + r.Status + '.';
  });
}

function correctionsList_(u, p) { return approvalList_(u, 'Corrections', p); }

/* ------------------------------------------------------------------ recruitment */

function jobsList_(u) {
  needHR_(u);
  var apps = table_('Applicants');
  return table_('Jobs').map(function (j) {
    var o = strip_(j);
    var mine = apps.filter(function (a) { return a.JobID === j.JobID; });
    o.Applicants = mine.length;
    o.Hired = mine.filter(function (a) { return a.Stage === 'Hired'; }).length;
    return o;
  }).sort(byNewest_('PostedDate'));
}

function jobSave_(u, p) {
  needHR_(u);
  var j = p.job || {};
  need_(String(j.Title || '').trim(), 'Enter the job title.');
  need_(num_(j.Slots) >= 1, 'Slots must be at least 1.');
  var rec = { Title: String(j.Title).trim(), Position: j.Position || '', Department: j.Department || '', Branch: j.Branch || '',
              HQ: j.Branch ? ((findBy_('Branches', 'Branch', j.Branch) || {}).HQ || '') : (j.HQ || ''),
              Slots: num_(j.Slots), Description: j.Description || '', Status: ['Open', 'On Hold', 'Closed', 'Filled'].indexOf(j.Status) >= 0 ? j.Status : 'Open' };
  return locked_(function () {
    if (j.JobID) {
      var cur = findBy_('Jobs', 'JobID', j.JobID); need_(cur, 'Job not found.');
      update_('Jobs', cur._row, rec);
      audit_(u, 'UPDATE', 'Jobs', j.JobID, rec.Title);
      return 'Job opening saved.';
    }
    rec.JobID = nextId_('JOB'); rec.PostedDate = today_(); rec.CreatedBy = u.name;
    insert_('Jobs', rec);
    audit_(u, 'CREATE', 'Jobs', rec.JobID, rec.Title);
    return 'Job opening ' + rec.JobID + ' posted.';
  });
}

function applicantsList_(u, p) {
  needHR_(u);
  return table_('Applicants').filter(function (a) {
    return (!p.jobId || a.JobID === p.jobId) && (!p.stage || a.Stage === p.stage);
  }).sort(byNewest_('UpdatedAt')).map(strip_);
}

function applicantSave_(u, p) {
  needHR_(u);
  var a = p.applicant || {};
  need_(String(a.Name || '').trim(), 'Enter the applicant\'s name.');
  var job = findBy_('Jobs', 'JobID', a.JobID);
  need_(job, 'Choose the job opening.');
  need_(!a.Email || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a.Email), 'Enter a valid e-mail address.');
  var rec = { JobID: job.JobID, JobTitle: job.Title, Name: String(a.Name).trim(), Email: a.Email || '', Contact: a.Contact || '',
              Address: a.Address || '', Source: a.Source || '', Score: a.Score || '', Notes: a.Notes || '', UpdatedAt: stamp_() };
  return locked_(function () {
    if (a.ApplicantID) {
      var cur = findBy_('Applicants', 'ApplicantID', a.ApplicantID); need_(cur, 'Applicant not found.');
      if (p.resume && p.resume.data) rec.ResumeId = saveFile_(p.resume, 'Recruitment/' + job.JobID, cur.ApplicantID);
      update_('Applicants', cur._row, rec);
      audit_(u, 'UPDATE', 'Applicants', cur.ApplicantID, rec.Name);
      return 'Applicant saved.';
    }
    rec.ApplicantID = nextId_('APP'); rec.Stage = 'Applied'; rec.AppliedDate = today_();
    rec.ResumeId = saveFile_(p.resume, 'Recruitment/' + job.JobID, rec.ApplicantID);
    insert_('Applicants', rec);
    audit_(u, 'CREATE', 'Applicants', rec.ApplicantID, rec.Name + ' → ' + job.Title);
    return 'Applicant ' + rec.ApplicantID + ' added.';
  });
}

function applicantStage_(u, p) {
  needHR_(u);
  need_(STAGES.indexOf(p.stage) >= 0 && p.stage !== 'Hired', 'Choose a stage (use Hire to make the employee profile).');
  return locked_(function () {
    var a = findBy_('Applicants', 'ApplicantID', p.id); need_(a, 'Applicant not found.');
    need_(a.Stage !== 'Hired', 'This applicant is already hired.');
    update_('Applicants', a._row, { Stage: p.stage, UpdatedAt: stamp_(),
      Notes: p.note ? [a.Notes, today_() + ' ' + p.stage + ': ' + p.note].filter(String).join('\n') : a.Notes });
    audit_(u, 'STAGE ' + p.stage, 'Applicants', a.ApplicantID, p.note || '');
    return a.Name + ' moved to ' + p.stage + '.';
  });
}

/** Hired → new employee profile (Probationary) from the applicant. */
function applicantHire_(u, p) {
  needHR_(u);
  return locked_(function () {
    var a = findBy_('Applicants', 'ApplicantID', p.id); need_(a, 'Applicant not found.');
    need_(a.Stage !== 'Hired', 'This applicant is already hired.');
    var job = findBy_('Jobs', 'JobID', a.JobID) || {};
    var branch = p.branch || job.Branch;
    need_(branch && findBy_('Branches', 'Branch', branch), 'Choose the branch / office of the new hire.');
    need_(isDate_(p.dateHired), 'Enter the date hired.');
    var parts = String(a.Name).trim().split(/\s+/);
    var rec = { EmployeeID: nextEmployeeId_(), FirstName: parts.length > 1 ? parts.slice(0, -1).join(' ') : parts[0],
                LastName: parts.length > 1 ? parts[parts.length - 1] : '', Email: a.Email, Contact: a.Contact, Address: a.Address,
                Position: job.Position || job.Title, Department: job.Department || '', Branch: branch,
                HQ: findBy_('Branches', 'Branch', branch).HQ, DateHired: p.dateHired, EmploymentType: 'Probationary', Status: 'Active',
                SalaryType: 'Monthly', BasicSalary: num_(p.salary) || '', CreatedAt: stamp_(), UpdatedAt: stamp_() };
    insert_('Employees', rec);
    update_('Applicants', a._row, { Stage: 'Hired', EmployeeID: rec.EmployeeID, UpdatedAt: stamp_() });
    if (a.ResumeId) insert_('Documents', { DocID: nextId_('DOC'), EmployeeID: rec.EmployeeID, EmployeeName: fullName_(rec), DocType: 'Resume',
      FileName: 'Resume (from application)', FileId: a.ResumeId, UploadedBy: u.name, UploadedAt: stamp_() });
    var hired = table_('Applicants').filter(function (x) { return x.JobID === a.JobID && x.Stage === 'Hired'; }).length;
    if (job.JobID && hired >= num_(job.Slots)) update_('Jobs', findBy_('Jobs', 'JobID', job.JobID)._row, { Status: 'Filled' });
    audit_(u, 'HIRE', 'Applicants', a.ApplicantID, '→ ' + rec.EmployeeID);
    return { id: rec.EmployeeID, msg: a.Name + ' hired as ' + rec.EmployeeID + '. Complete the employee profile.' };
  });
}

/* ------------------------------------------------------------------ performance */

function ratingOf_(score) {
  return score >= 90 ? 'Outstanding' : score >= 80 ? 'Very Good' : score >= 70 ? 'Good' : score >= 60 ? 'Needs Improvement' : 'Unsatisfactory';
}

function evaluationsList_(u, p) {
  return scoped_(u, table_('Evaluations')).filter(function (r) { return !p.employeeId || r.EmployeeID === p.employeeId; })
    .sort(byNewest_('Date')).map(strip_);
}

function evaluationSave_(u, p) {
  var ev = p.evaluation || {};
  var e = emp_(ev.EmployeeID);
  need_(canManage_(u, e), 'Only HR or the employee\'s branch manager can evaluate.');
  need_(String(ev.Period || '').trim(), 'Enter the evaluation period (e.g. Jan–Jun 2026).');
  var rec = { EmployeeID: e.EmployeeID, EmployeeName: fullName_(e), Position: e.Position, Branch: e.Branch, Period: String(ev.Period).trim(),
              Evaluator: u.name, Remarks: ev.Remarks || '', Date: today_() };
  var total = 0;
  EVAL_CRITERIA.forEach(function (c) {
    var v = Number(ev[c[0]]);
    need_(isFinite(v) && v >= 0 && v <= 100, c[1] + ' must be 0–100.');
    rec[c[0]] = v; total += v;
  });
  rec.Overall = round2_(total / EVAL_CRITERIA.length);
  rec.Rating = ratingOf_(rec.Overall);
  return locked_(function () {
    if (ev.EvalID) {
      var cur = findBy_('Evaluations', 'EvalID', ev.EvalID); need_(cur, 'Evaluation not found.');
      update_('Evaluations', cur._row, rec);
    } else { rec.EvalID = nextId_('EV'); insert_('Evaluations', rec); }
    audit_(u, 'EVALUATE', 'Evaluations', rec.EvalID || ev.EvalID, rec.Overall + ' ' + rec.Rating);
    return 'Evaluation saved: ' + rec.Overall + '% — ' + rec.Rating + '.';
  });
}

/* ------------------------------------------------------------------ training */

function trainingState_(t) {
  if (t.Status === 'Cancelled') return 'Cancelled';
  if (t.Date > today_()) return 'Upcoming';
  if (t.ExpiryDate) {
    if (t.ExpiryDate < today_()) return 'Expired';
    if (daysBetween_(today_(), t.ExpiryDate) <= num_(setting_('renewal_alert_days', 60))) return 'For Renewal';
  }
  return 'Completed';
}

function trainingsList_(u, p) {
  return scoped_(u, table_('Trainings').map(function (t) {
    var e = findBy_('Employees', 'EmployeeID', t.EmployeeID); t.Branch = e ? e.Branch : ''; return t;
  })).filter(function (t) { return !p.employeeId || t.EmployeeID === p.employeeId; })
    .map(function (t) { var o = strip_(t); o.State = trainingState_(t); return o; }).sort(byNewest_('Date'));
}

function trainingSave_(u, p) {
  needHR_(u);
  var t = p.training || {};
  need_(String(t.Title || '').trim(), 'Enter the training title.');
  need_(isDate_(t.Date), 'Enter the training date.');
  need_(!t.ExpiryDate || isDate_(t.ExpiryDate), 'Expiry must be a date.');
  var ids = t.TrainingID ? [t.EmployeeID] : (Array.isArray(t.EmployeeIDs) && t.EmployeeIDs.length ? t.EmployeeIDs : [t.EmployeeID]);
  need_(ids.length && ids[0], 'Choose the employee(s).');
  return locked_(function () {
    var n = 0;
    ids.forEach(function (id) {
      var e = emp_(id);
      var rec = { EmployeeID: e.EmployeeID, EmployeeName: fullName_(e), Title: String(t.Title).trim(), Date: t.Date, Trainer: t.Trainer || '',
                  Location: t.Location || '', ExpiryDate: t.ExpiryDate || '', Status: t.Status || 'Completed', Remarks: t.Remarks || '' };
      if (p.certificate && p.certificate.data) rec.CertificateId = saveFile_(p.certificate, 'Trainings/' + e.EmployeeID, rec.Title);
      if (t.TrainingID) {
        var cur = findBy_('Trainings', 'TrainingID', t.TrainingID); need_(cur, 'Training not found.');
        update_('Trainings', cur._row, rec);
      } else { rec.TrainingID = nextId_('TR'); insert_('Trainings', rec); }
      n++;
    });
    audit_(u, t.TrainingID ? 'UPDATE' : 'CREATE', 'Trainings', t.TrainingID || '', t.Title + ' × ' + n);
    return 'Training saved for ' + n + ' employee(s).';
  });
}

/* ------------------------------------------------------------------ documents */

function docState_(d) {
  if (!d.ExpiryDate) return 'Valid';
  var left = daysBetween_(today_(), d.ExpiryDate);
  return left < 0 ? 'Expired' : left <= num_(setting_('document_alert_days', 30)) ? 'Expiring' : 'Valid';
}

function documentsList_(u, p) {
  var rows = table_('Documents').filter(function (d) {
    var e = findBy_('Employees', 'EmployeeID', d.EmployeeID);
    return canSeeEmp_(u, e) && (!p.employeeId || d.EmployeeID === p.employeeId) && (!p.type || d.DocType === p.type);
  }).map(function (d) {
    var o = strip_(d); o.State = docState_(d);
    o.DaysLeft = d.ExpiryDate ? daysBetween_(today_(), d.ExpiryDate) : '';
    return o;
  });
  if (p.expiring) rows = rows.filter(function (d) { return d.State !== 'Valid'; });
  return rows.sort(function (a, b) { return String(a.ExpiryDate || '9999').localeCompare(String(b.ExpiryDate || '9999')); });
}

/** HR uploads for anyone; an employee uploads own documents. */
function documentUpload_(u, p) {
  var e = emp_(p.employeeId || u.employeeId);
  need_(isHR_(u) || e.EmployeeID === u.employeeId, 'You can only upload your own documents.');
  need_(DOC_TYPES.indexOf(p.docType) >= 0, 'Choose the document type.');
  need_(p.file && p.file.data, 'Choose the file.');
  need_(!p.issueDate || isDate_(p.issueDate), 'Issue date must be a date.');
  need_(!p.expiryDate || isDate_(p.expiryDate), 'Expiry date must be a date.');
  return locked_(function () {
    var rec = { DocID: nextId_('DOC'), EmployeeID: e.EmployeeID, EmployeeName: fullName_(e), DocType: p.docType,
                FileName: String(p.file.name || p.docType).slice(0, 120), IssueDate: p.issueDate || '', ExpiryDate: p.expiryDate || '',
                UploadedBy: u.name, UploadedAt: stamp_(), Remarks: p.remarks || '' };
    rec.FileId = saveFile_(p.file, 'Documents/' + e.EmployeeID, p.docType);
    insert_('Documents', rec);
    audit_(u, 'UPLOAD', 'Documents', rec.DocID, e.EmployeeID + ' ' + p.docType);
    return 'Document uploaded.';
  });
}

function documentDelete_(u, p) {
  needHR_(u);
  return locked_(function () {
    var d = findBy_('Documents', 'DocID', p.id); need_(d, 'Document not found.');
    try { DriveApp.getFileById(d.FileId).setTrashed(true); } catch (e) { /* already gone */ }
    deleteRow_('Documents', d._row);
    audit_(u, 'DELETE', 'Documents', d.DocID, d.EmployeeID + ' ' + d.DocType);
    return 'Document deleted.';
  });
}

/**
 * Short-lived view of a stored file (selfie, document, certificate, attachment, resume) as a data URL,
 * after checking the account may see the record that points to it.
 */
function fileUrl_(u, p) {
  var id = String(p.fileId || '');
  need_(id, 'No file.');
  var owner = null;
  [['Documents', 'FileId'], ['Trainings', 'CertificateId'], ['Leaves', 'AttachmentId'], ['Requests', 'AttachmentId'],
   ['Attendance', 'InSelfie'], ['Attendance', 'OutSelfie']].some(function (x) {
    var r = findBy_(x[0], x[1], id); if (r) { owner = r.EmployeeID; return true; } return false;
  });
  var allowed;
  if (owner) allowed = canSeeEmp_(u, findBy_('Employees', 'EmployeeID', owner));
  else allowed = isHR_(u) && !!findBy_('Applicants', 'ResumeId', id);
  need_(allowed, 'You cannot open this file.');
  var f = DriveApp.getFileById(id);
  var blob = f.getBlob();
  need_(blob.getBytes().length <= MAX_FILE_MB * 1024 * 1024, 'File too large to preview.');
  return { name: f.getName(), mime: blob.getContentType(), data: 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes()) };
}

/* ------------------------------------------------------------------ employee requests */

function requestsList_(u, p) {
  var rows = isHR_(u) ? table_('Requests') : table_('Requests').filter(function (r) { return r.EmployeeID === u.employeeId; });
  if (p.status === 'open') rows = rows.filter(function (r) { return ['Submitted', 'In Review', 'Approved'].indexOf(r.Status) >= 0; });
  else if (p.status) rows = rows.filter(function (r) { return r.Status === p.status; });
  return rows.sort(byNewest_('CreatedAt')).map(strip_);
}

function requestSubmit_(u, p) {
  var e = requesterEmp_(u, p);
  need_(REQUEST_TYPES.indexOf(p.type) >= 0, 'Choose the request type.');
  need_(String(p.details || '').trim(), 'Enter the details (purpose, number of copies, etc.).');
  return locked_(function () {
    var r = { RequestID: nextId_('RQ'), EmployeeID: e.EmployeeID, EmployeeName: fullName_(e), Branch: e.Branch, Type: p.type,
              Details: String(p.details).trim(), Status: 'Submitted', CreatedAt: stamp_(), UpdatedAt: stamp_() };
    r.AttachmentId = saveFile_(p.attachment, 'Requests/' + e.EmployeeID, r.RequestID);
    insert_('Requests', r);
    audit_(u, 'SUBMIT', 'Requests', r.RequestID, p.type);
    mail_(hrEmails_(), p.type + ' — ' + r.EmployeeName, '<p><b>' + esc_(r.EmployeeName) + '</b> (' + esc_(e.Branch) + ') requested <b>' + esc_(p.type) +
      '</b>.</p><p>' + esc_(r.Details) + '</p>');
    return 'Request ' + r.RequestID + ' submitted to HR.';
  });
}

/** HR moves a request: In Review → Approved → Completed, or Rejected. */
function requestAction_(u, p) {
  needHR_(u);
  need_(['In Review', 'Approved', 'Completed', 'Rejected'].indexOf(p.status) >= 0, 'Choose the new status.');
  need_(p.status !== 'Rejected' || String(p.note || '').trim(), 'Give the reason for rejecting.');
  return locked_(function () {
    var r = findBy_('Requests', 'RequestID', p.id); need_(r, 'Request not found.');
    need_(['Completed', 'Rejected'].indexOf(r.Status) < 0, 'This request is already ' + r.Status + '.');
    update_('Requests', r._row, { Status: p.status, HRBy: u.name, HRNote: p.note || r.HRNote, UpdatedAt: stamp_() });
    audit_(u, 'REQUEST ' + p.status.toUpperCase(), 'Requests', r.RequestID, p.note || '');
    mail_(employeeEmail_(r.EmployeeID), r.Type + ' — ' + p.status, '<p>Your request <b>' + esc_(r.RequestID) + '</b> (' + esc_(r.Type) + ') is now <b>' +
      esc_(p.status) + '</b>.</p>' + (p.note ? '<p>' + esc_(p.note) + '</p>' : ''));
    return 'Request ' + r.RequestID + ' — ' + p.status + '.';
  });
}

/* ------------------------------------------------------------------ organization (HQs, branches, departments, positions, holidays) */

var ORG = {
  hqs: { sheet: 'HQs', key: 'HQ' },
  branches: { sheet: 'Branches', key: 'Branch' },
  departments: { sheet: 'Departments', key: 'Department' },
  positions: { sheet: 'Positions', key: 'Position' },
  holidays: { sheet: 'Holidays', key: 'Date' }
};

function orgGet_(u) {
  need_(isHR_(u) || isMgr_(u), 'Not available for your account.');
  var emps = table_('Employees').filter(isActiveEmp_);
  var count = function (k, v) { return emps.filter(function (e) { return e[k] === v; }).length; };
  return {
    hqs: table_('HQs').map(function (r) { var o = strip_(r); o.Employees = count('HQ', r.HQ); return o; })
      .sort(function (a, b) { return num_(a.Sort) - num_(b.Sort); }),
    branches: table_('Branches').map(function (r) { var o = strip_(r); o.Employees = count('Branch', r.Branch); return o; }),
    departments: table_('Departments').map(function (r) { var o = strip_(r); o.Employees = count('Department', r.Department); return o; }),
    positions: table_('Positions').map(function (r) { var o = strip_(r); o.Employees = count('Position', r.Position); return o; }),
    holidays: table_('Holidays').map(strip_).sort(function (a, b) { return a.Date.localeCompare(b.Date); }),
    canEdit: isHR_(u)
  };
}

/** p: { kind, original (key value when editing), row } */
function orgSave_(u, p) {
  needHR_(u);
  var cfg = ORG[p.kind]; need_(cfg, 'Unknown list.');
  var row = p.row || {};
  var key = String(row[cfg.key] || '').trim();
  need_(key, 'Enter the ' + cfg.key.toLowerCase() + '.');
  if (p.kind === 'holidays') { need_(isDate_(key), 'Enter the holiday date.'); need_(['Regular', 'Special'].indexOf(row.Type) >= 0, 'Choose Regular or Special.'); }
  if (p.kind === 'branches') {
    need_(findBy_('HQs', 'HQ', row.HQ), 'Choose the HQ.');
    need_(row.Lat === '' || row.Lat === undefined || isFinite(Number(row.Lat)), 'Latitude must be a number.');
    need_(row.Lng === '' || row.Lng === undefined || isFinite(Number(row.Lng)), 'Longitude must be a number.');
  }
  var rec = {};
  SCHEMA[cfg.sheet].forEach(function (h) { if (row[h] !== undefined) rec[h] = String(row[h]).trim(); });
  rec[cfg.key] = key;
  return locked_(function () {
    var cur = p.original ? findBy_(cfg.sheet, cfg.key, p.original) : null;
    var clash = findBy_(cfg.sheet, cfg.key, key);
    need_(!clash || (cur && clash._row === cur._row), key + ' already exists.');
    if (cur) {
      update_(cfg.sheet, cur._row, rec);
      if (p.original !== key) renameRefs_(p.kind, p.original, key);
    } else insert_(cfg.sheet, rec);
    if (p.kind === 'branches') {   // keep the employees' HQ in step with their branch
      table_('Employees').forEach(function (e) { if (e.Branch === key && e.HQ !== rec.HQ) update_('Employees', e._row, { HQ: rec.HQ }); });
    }
    audit_(u, cur ? 'UPDATE' : 'CREATE', cfg.sheet, key, '');
    return 'Saved.';
  });
}

function renameRefs_(kind, from, to) {
  var map = { branches: [['Employees', 'Branch'], ['Jobs', 'Branch']], hqs: [['Employees', 'HQ'], ['Branches', 'HQ']],
              departments: [['Employees', 'Department'], ['Positions', 'Department']], positions: [['Employees', 'Position']] }[kind] || [];
  map.forEach(function (m) {
    table_(m[0]).forEach(function (r) { if (r[m[1]] === from) { var o = {}; o[m[1]] = to; update_(m[0], r._row, o); } });
  });
}

function orgDelete_(u, p) {
  needHR_(u);
  var cfg = ORG[p.kind]; need_(cfg, 'Unknown list.');
  return locked_(function () {
    var cur = findBy_(cfg.sheet, cfg.key, p.key); need_(cur, 'Not found.');
    var usedBy = { branches: 'Branch', hqs: 'HQ', departments: 'Department', positions: 'Position' }[p.kind];
    if (usedBy) need_(!table_('Employees').some(function (e) { return e[usedBy] === p.key; }), 'Still used by employees — set it inactive instead.');
    deleteRow_(cfg.sheet, cur._row);
    audit_(u, 'DELETE', cfg.sheet, p.key, '');
    return 'Deleted.';
  });
}

/* ------------------------------------------------------------------ settings, users, audit */

function settingsGet_(u) {
  needSuper_(u);
  return table_('Settings').map(strip_);
}

function settingsSave_(u, p) {
  needSuper_(u);
  return locked_(function () {
    (p.settings || []).forEach(function (s) {
      var v = String(s.Value === undefined ? '' : s.Value);
      if (/^[\[{]/.test(v.trim())) { try { JSON.parse(v); } catch (e) { throw new Error('Setting ' + s.Key + ' is not valid JSON.'); } }
      var cur = findBy_('Settings', 'Key', s.Key);
      if (cur) { if (cur.Value !== v) update_('Settings', cur._row, { Value: v }); }
      else insert_('Settings', { Key: s.Key, Value: v, Note: s.Note || '' });
    });
    audit_(u, 'UPDATE', 'Settings', '', '');
    return 'Settings saved.';
  });
}

function usersList_(u) {
  needSuper_(u);
  return table_('Users').map(function (r) {
    return { Username: r.Username, Name: r.Name, Email: r.Email, Role: r.Role, RoleLabel: ROLE_LABELS[r.Role] || r.Role,
             EmployeeID: r.EmployeeID, Branches: r.Branches, Active: r.Active, MustChange: r.MustChange, LastLogin: r.LastLogin };
  });
}

/** p: { user: {Username, Name, Email, Role, EmployeeID, Branches, Active}, isNew, password } */
function userSave_(u, p) {
  needSuper_(u);
  var x = p.user || {};
  var username = String(x.Username || '').trim();
  need_(/^[A-Za-z0-9._-]{2,40}$/.test(username), 'Username: 2–40 letters, numbers, dot, dash or underscore.');
  need_(String(x.Name || '').trim(), 'Enter the name.');
  need_(ROLES.indexOf(x.Role) >= 0, 'Choose the role.');
  need_(!x.Email || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x.Email), 'Enter a valid e-mail address.');
  if (x.EmployeeID) need_(findBy_('Employees', 'EmployeeID', x.EmployeeID), 'Employee ' + x.EmployeeID + ' not found.');
  need_(x.Role !== 'EMPLOYEE' || x.EmployeeID, 'Link an employee record to an Employee account.');
  var branches = String(x.Branches || '').split(',').map(function (s) { return s.trim(); }).filter(String);
  branches.forEach(function (b) { need_(findBy_('Branches', 'Branch', b), 'Unknown branch: ' + b); });
  need_(x.Role !== 'BRANCH_MANAGER' || branches.length, 'Choose the branch(es) this manager covers.');
  return locked_(function () {
    var cur = findBy_('Users', 'Username', username, true);
    if (x.EmployeeID) {
      var other = findBy_('Users', 'EmployeeID', x.EmployeeID);
      need_(!other || (cur && other._row === cur._row), 'Employee ' + x.EmployeeID + ' already has account ' + (other ? other.Username : '') + '.');
    }
    var rec = { Name: String(x.Name).trim(), Email: x.Email || '', Role: x.Role, EmployeeID: x.EmployeeID || '',
                Branches: branches.join(', '), Active: String(x.Active) === 'false' || x.Active === false || x.Active === 'FALSE' ? 'FALSE' : 'TRUE' };
    if (cur) {
      need_(!p.isNew, 'Username ' + username + ' is taken.');
      need_(!(cur.Username === u.username && (rec.Role !== 'SUPER_ADMIN' || rec.Active !== 'TRUE')), 'You cannot remove your own Super Admin access.');
      update_('Users', cur._row, rec);
      audit_(u, 'UPDATE', 'Users', username, rec.Role);
      return 'Account saved.';
    }
    var pw = String(p.password || '');
    need_(pw.length >= 8, 'Temporary password: at least 8 characters.');
    rec.Username = username; rec.Salt = newSalt_(); rec.PasswordHash = hash_(pw, rec.Salt); rec.MustChange = 'TRUE'; rec.CreatedAt = stamp_();
    insert_('Users', rec);
    audit_(u, 'CREATE', 'Users', username, rec.Role);
    return 'Account ' + username + ' created. They change the temporary password at first login.';
  });
}

function userResetPassword_(u, p) {
  needSuper_(u);
  var pw = String(p.password || '');
  need_(pw.length >= 8, 'Temporary password: at least 8 characters.');
  return locked_(function () {
    var cur = findBy_('Users', 'Username', p.username, true); need_(cur, 'Account not found.');
    var salt = newSalt_();
    update_('Users', cur._row, { Salt: salt, PasswordHash: hash_(pw, salt), MustChange: 'TRUE' });
    audit_(u, 'RESET PASSWORD', 'Users', cur.Username, '');
    return 'Password reset. ' + cur.Username + ' must change it at the next login.';
  });
}

function auditList_(u, p) {
  needSuper_(u);
  var sh = sheet_('AuditLog');
  var last = sh.getLastRow();
  if (last < 2) return [];
  var n = Math.min(1000, last - 1);
  var vals = sh.getRange(last - n + 1, 1, n, SCHEMA.AuditLog.length).getValues().reverse();
  var q = String(p.q || '').toLowerCase();
  return vals.map(function (r) {
    var o = {}; SCHEMA.AuditLog.forEach(function (h, i) { o[h] = cell_(r[i]); }); return o;
  }).filter(function (o) { return !q || JSON.stringify(o).toLowerCase().indexOf(q) >= 0; }).slice(0, 500);
}


/* ================================================================== SECTION: 4. payroll */

/* =====================================================================
 * Payroll: semi-monthly periods, computation, approval, payslips.
 * Rates live in Settings → payroll (JSON) so HR / Accounting can update
 * them when SSS, PhilHealth, Pag-IBIG or BIR tables change.
 *
 *   Draft ──submit──▶ For Approval ──approve──▶ Approved ──release──▶ Released
 *     ▲                    │
 *     └──────return────────┘
 * ===================================================================== */

var PAYROLL_DEFAULTS = {
  workDaysPerYear: 261,          // monthly-paid daily rate = salary × 12 ÷ this
  dailyToMonthly: 26,            // daily-paid monthly basis for contributions = daily × this
  hoursPerDay: 8,
  otRate: 1.25,                  // ordinary day
  otRestSpecialRate: 1.69,       // rest day or special holiday
  otRegularHolidayRate: 2.6,     // regular holiday
  regularHolidayPremium: 1.0,    // extra pay (× daily) for working a regular holiday
  specialHolidayPremium: 0.3,    // extra pay (× daily) for working a special holiday
  deductAbsences: true,
  deductLate: true,
  allowancesTaxable: false,
  contributionsSplit: 'half',    // 'half' = half each cut-off · 'second' = all on the 16th–end cut-off
  sss: { rate: 0.05, minMSC: 5000, maxMSC: 35000 },
  philhealth: { rate: 0.025, floor: 10000, ceiling: 100000 },
  pagibig: { rate: 0.02, lowRate: 0.01, lowLimit: 1500, maxBase: 10000 },
  taxTable: [                    // BIR semi-monthly withholding (TRAIN, 2023 onwards)
    { over: 0, base: 0, rate: 0 },
    { over: 10417, base: 0, rate: 0.15 },
    { over: 16667, base: 937.5, rate: 0.2 },
    { over: 33333, base: 4270.7, rate: 0.25 },
    { over: 83333, base: 16770.7, rate: 0.3 },
    { over: 333333, base: 91770.7, rate: 0.35 }
  ]
};

var PERIOD_STATUSES = ['Draft', 'For Approval', 'Approved', 'Released'];
var EDITABLE_LINE = ['HolidayPay', 'NightDiff', 'Allowances', 'AbsentDays', 'LateMins', 'OtherDeductions', 'Remarks', 'Status'];

function payCfg_() {
  var c = setting_('payroll', {});
  var out = JSON.parse(JSON.stringify(PAYROLL_DEFAULTS));
  for (var k in c) if (c.hasOwnProperty(k)) out[k] = c[k];
  return out;
}

function period_(id) {
  var p = findBy_('PayrollPeriods', 'PeriodID', id);
  need_(p, 'Payroll period not found.');
  return p;
}

/* ------------------------------------------------------------------ periods */

function payrollPeriods_(u) {
  need_(isHR_(u) || isMgr_(u), 'Payroll is not available for your account.');
  var lines = table_('Payroll');
  return table_('PayrollPeriods').map(function (p) {
    var o = strip_(p);
    var mine = lines.filter(function (l) { return l.PeriodID === p.PeriodID && (isHR_(u) || mgrBranches_(u).indexOf(l.Branch) >= 0); });
    o.Employees = mine.length;
    o.Processed = mine.filter(function (l) { return l.Status === 'Processed'; }).length;
    if (isHR_(u)) {
      o.Gross = round2_(mine.reduce(function (a, l) { return a + num_(l.GrossPay); }, 0));
      o.Deductions = round2_(mine.reduce(function (a, l) { return a + num_(l.TotalDeductions); }, 0));
      o.Net = round2_(mine.reduce(function (a, l) { return a + num_(l.NetPay); }, 0));
    }
    return o;
  }).sort(byNewest_('StartDate'));
}

/** p: { start, end, payDate, label } — defaults to the next semi-monthly cut-off. */
function payrollPeriodCreate_(u, p) {
  needHR_(u);
  var start = p.start, end = p.end;
  if (!isDate_(start) || !isDate_(end)) {
    var last = table_('PayrollPeriods').map(function (x) { return x.EndDate; }).sort().pop();
    start = last ? addDays_(last, 1) : today_().slice(0, 8) + (Number(today_().slice(8)) <= 15 ? '01' : '16');
    if (Number(start.slice(8)) <= 15) end = start.slice(0, 8) + '15';
    else { var d = parseDate_(start); d.setMonth(d.getMonth() + 1); d.setDate(0); end = fmtDate_(d); }
  }
  need_(start <= end, 'The end date is before the start date.');
  need_(daysBetween_(start, end) <= 31, 'A payroll period can be up to 31 days.');
  return locked_(function () {
    var overlap = table_('PayrollPeriods').some(function (x) { return x.StartDate <= end && x.EndDate >= start; });
    need_(!overlap, 'This period overlaps an existing payroll period.');
    var s = parseDate_(start), e = parseDate_(end);
    var label = p.label || (Utilities.formatDate(s, TZ, 'MMMM d') + '–' + Utilities.formatDate(e, TZ, 'd, yyyy'));
    var rec = { PeriodID: 'PAY-' + start.replace(/-/g, '').slice(0, 6) + (Number(start.slice(8)) <= 15 ? 'A' : 'B'), Label: label,
                StartDate: start, EndDate: end, PayDate: isDate_(p.payDate) ? p.payDate : end,
                Status: 'Draft', CreatedBy: u.name, CreatedAt: stamp_() };
    if (findBy_('PayrollPeriods', 'PeriodID', rec.PeriodID)) rec.PeriodID = nextId_('PAY');
    insert_('PayrollPeriods', rec);
    audit_(u, 'CREATE', 'PayrollPeriods', rec.PeriodID, label);
    return { id: rec.PeriodID, msg: 'Payroll period ' + label + ' created. Generate the payroll next.' };
  });
}

/* ------------------------------------------------------------------ computation */

function monthlyBasis_(line, cfg) {
  return line.SalaryType === 'Daily' ? num_(line.BasicSalary) * cfg.dailyToMonthly : num_(line.BasicSalary);
}

function contributions_(monthly, cfg) {
  var msc = Math.min(cfg.sss.maxMSC, Math.max(cfg.sss.minMSC, Math.floor((monthly + 250) / 500) * 500));
  var ph = Math.min(cfg.philhealth.ceiling, Math.max(cfg.philhealth.floor, monthly)) * cfg.philhealth.rate;
  var pi = Math.min(monthly, cfg.pagibig.maxBase) * (monthly <= cfg.pagibig.lowLimit ? cfg.pagibig.lowRate : cfg.pagibig.rate);
  return { sss: msc * cfg.sss.rate, philhealth: ph, pagibig: pi };
}

function withholding_(taxable, cfg) {
  var row = null;
  cfg.taxTable.forEach(function (t) { if (taxable > t.over) row = t; });
  return row ? Math.max(0, row.base + (taxable - row.over) * row.rate) : 0;
}

/** Recomputes the money columns of a line from its rates and inputs. */
function recalc_(line, period, cfg) {
  var daily = num_(line.DailyRate), hourly = num_(line.HourlyRate);
  line.AbsenceDeduction = round2_(cfg.deductAbsences && line.SalaryType !== 'Daily' ? num_(line.AbsentDays) * daily : 0);
  line.LateDeduction = round2_(cfg.deductLate ? num_(line.LateMins) / 60 * hourly : 0);
  var gross = num_(line.BasicPay) + num_(line.OTPay) + num_(line.HolidayPay) + num_(line.NightDiff) + num_(line.Allowances)
    - line.AbsenceDeduction - line.LateDeduction;
  line.GrossPay = round2_(Math.max(0, gross));
  var c = contributions_(monthlyBasis_(line, cfg), cfg);
  var share = cfg.contributionsSplit === 'second' ? (Number(String(period.EndDate).slice(8)) > 15 ? 1 : 0) : 0.5;
  line.SSS = round2_(c.sss * share);
  line.PhilHealth = round2_(c.philhealth * share);
  line.PagIBIG = round2_(c.pagibig * share);
  var taxable = line.GrossPay - (cfg.allowancesTaxable ? 0 : num_(line.Allowances)) - line.SSS - line.PhilHealth - line.PagIBIG;
  line.Tax = round2_(withholding_(Math.max(0, taxable), cfg));
  line.TotalDeductions = round2_(line.SSS + line.PhilHealth + line.PagIBIG + line.Tax + num_(line.OtherDeductions));
  line.NetPay = round2_(line.GrossPay - line.TotalDeductions);
  line.UpdatedAt = stamp_();
  return line;
}

/** Builds one employee's line for the period from salary, attendance, approved leave and approved overtime. */
function computeLine_(e, period, cfg, keep) {
  var monthlyPaid = e.SalaryType !== 'Daily';
  var salary = num_(e.BasicSalary);
  var daily = monthlyPaid ? salary * 12 / cfg.workDaysPerYear : salary;
  var hourly = daily / cfg.hoursPerDay;
  var from = e.DateHired && e.DateHired > period.StartDate ? e.DateHired : period.StartDate;
  var to = e.SeparationDate && e.SeparationDate < period.EndDate ? e.SeparationDate : period.EndDate;
  var countTo = to < today_() ? to : (today_() >= from ? today_() : to);
  var sh = shiftOf_(e);
  var att = {};
  table_('Attendance').forEach(function (r) { if (r.EmployeeID === e.EmployeeID && r.Date >= from && r.Date <= to) att[r.Date] = r; });
  var workDays = 0, worked = 0, paidLeave = 0, absent = 0, lateMins = 0, holidayPay = 0, regHolidaysOff = 0;
  for (var d = from; d <= to; d = addDays_(d, 1)) {
    var hol = holidayOn_(d), rest = sh.rest.indexOf(dayName_(d)) >= 0, r = att[d];
    if (r) {
      worked++;
      lateMins += num_(r.LateMins) + num_(r.UndertimeMins);
      if (hol) holidayPay += daily * (hol.Type === 'Regular' ? cfg.regularHolidayPremium : cfg.specialHolidayPremium);
    }
    if (hol || rest) { if (hol && hol.Type === 'Regular' && !rest && !r) regHolidaysOff++; continue; }
    workDays++;
    if (r) continue;
    var lv = table_('Leaves').filter(function (l) { return l.EmployeeID === e.EmployeeID && l.Status === 'Approved' && l.StartDate <= d && l.EndDate >= d; })[0];
    if (lv && lv.LeaveType !== 'Other Leave') paidLeave += num_(lv.Days) < 1 ? 0.5 : 1;
    else if (d <= countTo) absent++;
  }
  var fullPeriod = from === period.StartDate && to === period.EndDate;
  var basicPay = monthlyPaid ? (fullPeriod ? salary / 2 : daily * workDays) : daily * (worked + paidLeave);
  if (!monthlyPaid) holidayPay += daily * regHolidaysOff;   // daily-paid get unworked regular holidays

  var otHours = 0, otPay = 0;
  table_('Overtime').forEach(function (o) {
    if (o.EmployeeID !== e.EmployeeID || o.Status !== 'Approved' || o.Date < period.StartDate || o.Date > period.EndDate) return;
    if (o.PayrollPeriod && o.PayrollPeriod !== period.PeriodID) return;
    var hol = holidayOn_(o.Date), rest = sh.rest.indexOf(dayName_(o.Date)) >= 0;
    var rate = hol && hol.Type === 'Regular' ? cfg.otRegularHolidayRate : (hol || rest ? cfg.otRestSpecialRate : cfg.otRate);
    otHours += num_(o.Hours); otPay += num_(o.Hours) * hourly * rate;
  });

  var line = {
    PeriodID: period.PeriodID, EmployeeID: e.EmployeeID, EmployeeName: fullName_(e), Branch: e.Branch, Position: e.Position,
    SalaryType: monthlyPaid ? 'Monthly' : 'Daily', BasicSalary: salary, DailyRate: round2_(daily), HourlyRate: round2_(hourly),
    WorkDays: workDays, DaysWorked: worked, LeaveDays: paidLeave, BasicPay: round2_(basicPay), OTHours: round2_(otHours), OTPay: round2_(otPay),
    HolidayPay: round2_(holidayPay), NightDiff: keep ? keep.NightDiff : 0, Allowances: round2_(num_(e.Allowance) / 2),
    AbsentDays: absent, LateMins: lateMins, OtherDeductions: keep ? keep.OtherDeductions : 0, Status: 'Pending',
    Remarks: keep ? keep.Remarks : ''
  };
  return recalc_(line, period, cfg);
}

function payrollGenerate_(u, p) {
  needHR_(u);
  return locked_(function () {
    var period = period_(p.periodId);
    need_(period.Status === 'Draft', 'Only a Draft payroll can be generated again.');
    var cfg = payCfg_();
    var existing = {};
    table_('Payroll').forEach(function (l) { if (l.PeriodID === period.PeriodID) existing[l.EmployeeID] = l; });
    var emps = table_('Employees').filter(function (e) {
      return num_(e.BasicSalary) > 0 && (!e.DateHired || e.DateHired <= period.EndDate) &&
        (isActiveEmp_(e) || (e.SeparationDate && e.SeparationDate >= period.StartDate));
    });
    var head = SCHEMA.Payroll;
    var lines = emps.map(function (e) { return computeLine_(e, period, cfg, existing[e.EmployeeID]); });
    // rewrite this period's rows in one go
    var sh = sheet_('Payroll');
    var rowsToDelete = table_('Payroll').filter(function (l) { return l.PeriodID === period.PeriodID; }).map(function (l) { return l._row; }).sort(function (a, b) { return b - a; });
    rowsToDelete.forEach(function (r) { sh.deleteRow(r); });
    if (lines.length) {
      var vals = lines.map(function (l) { return head.map(function (h) { return l[h] === undefined ? '' : String(l[h]); }); });
      sh.getRange(sh.getLastRow() + 1, 1, vals.length, head.length).setNumberFormat('@').setValues(vals);
    }
    delete _cache.Payroll;
    var skipped = table_('Employees').filter(function (e) { return isActiveEmp_(e) && !(num_(e.BasicSalary) > 0); }).length;
    audit_(u, 'GENERATE', 'Payroll', period.PeriodID, lines.length + ' lines');
    return 'Payroll generated for ' + lines.length + ' employee(s).' + (skipped ? ' ' + skipped + ' active employee(s) have no basic salary and were skipped.' : '');
  });
}

var LIMITED_LINE = ['PeriodID', 'EmployeeID', 'EmployeeName', 'Branch', 'Position', 'WorkDays', 'DaysWorked', 'LeaveDays', 'AbsentDays', 'LateMins', 'OTHours', 'Status'];

function payrollLines_(u, p) {
  var period = period_(p.periodId);
  need_(isHR_(u) || isMgr_(u), 'Payroll is not available for your account.');
  var br = mgrBranches_(u);
  var lines = table_('Payroll').filter(function (l) { return l.PeriodID === period.PeriodID && (isHR_(u) || br.indexOf(l.Branch) >= 0); });
  if (p.branch) lines = lines.filter(function (l) { return l.Branch === p.branch; });
  return {
    period: strip_(period), limited: !isHR_(u), editable: isHR_(u) && period.Status === 'Draft',
    lines: lines.map(function (l) {
      if (isHR_(u)) return strip_(l);
      var o = {}; LIMITED_LINE.forEach(function (k) { o[k] = l[k]; }); return o;
    }).sort(function (a, b) { return (a.Branch + a.EmployeeName).localeCompare(b.Branch + b.EmployeeName); })
  };
}

/** p: { periodId, employeeId, edits } or { periodId, processAll: true } */
function payrollLineSave_(u, p) {
  needHR_(u);
  return locked_(function () {
    var period = period_(p.periodId);
    need_(period.Status === 'Draft', 'The payroll is ' + period.Status + ' — return it to Draft to edit.');
    var cfg = payCfg_();
    if (p.processAll) {
      var n = 0;
      table_('Payroll').forEach(function (l) {
        if (l.PeriodID === period.PeriodID && l.Status !== 'Processed') { update_('Payroll', l._row, { Status: 'Processed' }); n++; }
      });
      audit_(u, 'PROCESS ALL', 'Payroll', period.PeriodID, n + ' lines');
      return n + ' line(s) marked processed.';
    }
    var line = table_('Payroll').filter(function (l) { return l.PeriodID === period.PeriodID && l.EmployeeID === p.employeeId; })[0];
    need_(line, 'Payroll line not found.');
    var ed = p.edits || {};
    var rec = strip_(line);
    EDITABLE_LINE.forEach(function (k) {
      if (!ed.hasOwnProperty(k)) return;
      if (k === 'Remarks') rec[k] = String(ed[k]).slice(0, 300);
      else if (k === 'Status') rec[k] = ed[k] === 'Processed' ? 'Processed' : 'Pending';
      else { var v = Number(ed[k]); need_(isFinite(v) && v >= 0, k + ' must be a number 0 or more.'); rec[k] = v; }
    });
    recalc_(rec, period, cfg);
    update_('Payroll', line._row, rec);
    audit_(u, 'EDIT LINE', 'Payroll', period.PeriodID, p.employeeId + ' ' + JSON.stringify(ed));
    return { msg: 'Saved. Net pay ₱' + rec.NetPay.toFixed(2) + '.', line: rec };
  });
}

/** p: { periodId, action: submit|approve|return|release, note } */
function payrollSetStatus_(u, p) {
  needHR_(u);
  return locked_(function () {
    var period = period_(p.periodId);
    var lines = table_('Payroll').filter(function (l) { return l.PeriodID === period.PeriodID; });
    var patch = {};
    if (p.action === 'submit') {
      need_(period.Status === 'Draft', 'Only a Draft payroll can be submitted.');
      need_(lines.length, 'Generate the payroll first.');
      var pending = lines.filter(function (l) { return l.Status !== 'Processed'; }).length;
      need_(!pending, pending + ' line(s) are still Pending. Review them or use "Mark all processed".');
      patch.Status = 'For Approval';
    } else if (p.action === 'approve') {
      need_(period.Status === 'For Approval', 'Only a payroll For Approval can be approved.');
      need_(isSuper_(u) || period.CreatedBy !== u.name || String(setting_('payroll_self_approval', 'FALSE')).toUpperCase() === 'TRUE',
        'Another HR Admin or the Super Admin must approve the payroll you prepared.');
      patch.Status = 'Approved'; patch.ApprovedBy = u.name; patch.ApprovedAt = stamp_();
    } else if (p.action === 'return') {
      need_(period.Status === 'For Approval' || (period.Status === 'Approved' && isSuper_(u)), 'This payroll cannot be returned now.');
      need_(String(p.note || '').trim(), 'Give the reason for returning.');
      patch.Status = 'Draft'; patch.ApprovedBy = ''; patch.ApprovedAt = '';
    } else if (p.action === 'release') {
      need_(period.Status === 'Approved', 'Approve the payroll before releasing payslips.');
      patch.Status = 'Released'; patch.ReleasedAt = stamp_();
      table_('Overtime').forEach(function (o) {
        if (o.Status === 'Approved' && !o.PayrollPeriod && o.Date >= period.StartDate && o.Date <= period.EndDate &&
            lines.some(function (l) { return l.EmployeeID === o.EmployeeID; })) update_('Overtime', o._row, { PayrollPeriod: period.PeriodID });
      });
      lines.forEach(function (l) {
        mail_(employeeEmail_(l.EmployeeID), 'Payslip — ' + period.Label, '<p>Your payslip for <b>' + esc_(period.Label) +
          '</b> is ready. Open <b>My payslips</b> in the HRIS to view or print it.</p>');
      });
    } else throw new Error('Unknown action.');
    update_('PayrollPeriods', period._row, patch);
    audit_(u, 'PAYROLL ' + String(p.action).toUpperCase(), 'PayrollPeriods', period.PeriodID, p.note || '');
    return 'Payroll ' + period.Label + ' — ' + patch.Status + '.';
  });
}

function payslipsMine_(u) {
  need_(u.employeeId, 'This account is not linked to an employee record.');
  var released = {};
  table_('PayrollPeriods').forEach(function (p) { if (p.Status === 'Released') released[p.PeriodID] = p; });
  return table_('Payroll').filter(function (l) { return l.EmployeeID === u.employeeId && released[l.PeriodID]; })
    .map(function (l) { var o = strip_(l); o.Period = strip_(released[l.PeriodID]); return o; })
    .sort(function (a, b) { return String(b.Period.StartDate).localeCompare(String(a.Period.StartDate)); });
}


/* ================================================================== SECTION: 5. dashboard, notifications, reports */

/* =====================================================================
 * Dashboard, notification center and downloadable HR reports
 * ===================================================================== */

var PIPELINE = ['Applied', 'Screening', 'Interview', 'Assessment', 'Final Interview', 'Job Offer', 'Hired'];

function countBy_(rows, key) {
  var m = {};
  rows.forEach(function (r) { var k = r[key] || '—'; m[k] = (m[k] || 0) + 1; });
  return Object.keys(m).map(function (k) { return { label: k, value: m[k] }; }).sort(function (a, b) { return b.value - a.value; });
}

function birthdayToday_(e) {
  return e.BirthDate && String(e.BirthDate).slice(5) === today_().slice(5);
}

function dashboard_(u) {
  var t = today_();
  if (!isHR_(u) && !isMgr_(u)) return selfDashboard_(u);
  var all = visibleEmployees_(u);
  var active = all.filter(isActiveEmp_);
  var board = attendanceToday_(u, {});
  var pendLeave = approvalList_(u, 'Leaves', { status: 'action' }).length;
  var pendOt = approvalList_(u, 'Overtime', { status: 'action' }).length;
  var pendCorr = approvalList_(u, 'Corrections', { status: 'action' }).length;
  var docs = documentsList_(u, { expiring: true });
  var yearStart = t.slice(0, 4) + '-01-01';

  // attendance trend: present per day, last 21 days (rest days / holidays included as they fall)
  var ids = {}; active.forEach(function (e) { ids[e.EmployeeID] = 1; });
  var perDay = {};
  table_('Attendance').forEach(function (r) { if (ids[r.EmployeeID] && r.Date >= addDays_(t, -20)) perDay[r.Date] = (perDay[r.Date] || 0) + 1; });
  var trend = [];
  for (var i = 20; i >= 0; i--) { var d = addDays_(t, -i); trend.push({ label: d.slice(5), value: perDay[d] || 0 }); }

  var out = {
    scope: isHR_(u) ? 'All HQs and branches' : mgrBranches_(u).join(', '),
    cards: {
      total: all.filter(function (e) { return e.Status !== 'Resigned' && e.Status !== 'Terminated' && e.Status !== 'End of Contract' && e.Status !== 'Retired'; }).length,
      active: active.filter(function (e) { return e.Status === 'Active'; }).length,
      onLeave: board.counts['On Leave'],
      absentToday: board.counts.Absent,
      present: board.counts.Present + board.counts.Late,
      late: board.counts.Late,
      newHires: active.filter(function (e) { return e.DateHired && e.DateHired >= addDays_(t, -30); }).length,
      probationary: active.filter(function (e) { return e.EmploymentType === 'Probationary'; }).length,
      regular: active.filter(function (e) { return e.EmploymentType === 'Regular'; }).length,
      resigned: all.filter(function (e) { return ACTIVE_STATUSES.indexOf(e.Status) < 0 && e.SeparationDate >= yearStart; }).length,
      pendingLeave: pendLeave, pendingOvertime: pendOt, pendingCorrections: pendCorr,
      expiringDocuments: docs.length,
      birthdays: active.filter(birthdayToday_).map(function (e) { return fullName_(e) + ' (' + e.Branch + ')'; })
    },
    charts: {
      byType: countBy_(active, 'EmploymentType'),
      byHQ: countBy_(active, 'HQ'),
      byBranch: countBy_(active, 'Branch').slice(0, 12),
      trend: trend
    },
    today: { date: board.date, holiday: board.holiday, counts: board.counts },
    notifications: notifications_(u)
  };
  if (isHR_(u)) {
    var apps = table_('Applicants');
    out.cards.pendingApplications = apps.filter(function (a) { return ['Hired', 'Rejected', 'Withdrawn'].indexOf(a.Stage) < 0; }).length;
    out.cards.openJobs = table_('Jobs').filter(function (j) { return j.Status === 'Open'; }).length;
    out.cards.pendingPayroll = table_('PayrollPeriods').filter(function (p) { return p.Status !== 'Released'; }).length;
    out.cards.openRequests = table_('Requests').filter(function (r) { return ['Submitted', 'In Review', 'Approved'].indexOf(r.Status) >= 0; }).length;
    out.charts.pipeline = PIPELINE.map(function (s) {
      var idx = PIPELINE.indexOf(s);
      // an applicant counts in every stage up to the one reached (funnel)
      return { label: s, value: apps.filter(function (a) { var k = PIPELINE.indexOf(a.Stage); return k >= idx; }).length +
        (s === 'Applied' ? apps.filter(function (a) { return PIPELINE.indexOf(a.Stage) < 0; }).length : 0) };
    });
    var cur = table_('PayrollPeriods').filter(function (p) { return p.StartDate <= t; }).sort(byNewest_('StartDate'))[0];
    if (cur) {
      var lines = table_('Payroll').filter(function (l) { return l.PeriodID === cur.PeriodID; });
      out.payroll = { Label: cur.Label, Status: cur.Status, Employees: lines.length,
        Processed: lines.filter(function (l) { return l.Status === 'Processed'; }).length,
        Gross: round2_(lines.reduce(function (a, l) { return a + num_(l.GrossPay); }, 0)),
        Deductions: round2_(lines.reduce(function (a, l) { return a + num_(l.TotalDeductions); }, 0)),
        Net: round2_(lines.reduce(function (a, l) { return a + num_(l.NetPay); }, 0)) };
    }
  }
  return out;
}

function selfDashboard_(u) {
  need_(u.employeeId, 'This account is not linked to an employee record. Ask HR to link it.');
  var e = emp_(u.employeeId);
  var mine = attendanceMine_(u);
  return {
    self: true,
    employee: publicEmp_(u, e),
    todayRow: mine.todayRow, shift: mine.shift,
    balances: leaveBalanceFor_(e.EmployeeID, today_().slice(0, 4)),
    pending: {
      leave: table_('Leaves').filter(function (r) { return r.EmployeeID === e.EmployeeID && /^Pending/.test(r.Status); }).length,
      overtime: table_('Overtime').filter(function (r) { return r.EmployeeID === e.EmployeeID && /^Pending/.test(r.Status); }).length,
      requests: table_('Requests').filter(function (r) { return r.EmployeeID === e.EmployeeID && ['Completed', 'Rejected'].indexOf(r.Status) < 0; }).length
    },
    trainings: trainingsList_(u, { employeeId: e.EmployeeID }).filter(function (x) { return x.State !== 'Completed'; }).slice(0, 5),
    documents: documentsList_(u, { employeeId: e.EmployeeID, expiring: true }),
    payslip: payslipsMine_(u)[0] || null,
    notifications: notifications_(u)
  };
}

/** Notification center: what needs attention for this account. */
function notifications_(u) {
  var n = [];
  var add = function (tone, text, page) { n.push({ tone: tone, text: text, page: page }); };
  var t = today_();
  if (isHR_(u) || isMgr_(u)) {
    var lv = approvalList_(u, 'Leaves', { status: 'action' }).length;
    var ot = approvalList_(u, 'Overtime', { status: 'action' }).length;
    var ac = approvalList_(u, 'Corrections', { status: 'action' }).length;
    if (lv) add('warn', lv + ' leave request(s) need your approval.', 'leave');
    if (ot) add('warn', ot + ' overtime request(s) need your approval.', 'overtime');
    if (ac) add('warn', ac + ' attendance correction(s) are pending.', 'attendance');
    var docs = documentsList_(u, { expiring: true });
    var expired = docs.filter(function (d) { return d.State === 'Expired'; }).length;
    if (expired) add('bad', expired + ' employee document(s) have expired.', 'documents');
    if (docs.length - expired) add('warn', (docs.length - expired) + ' employee document(s) expire within ' + setting_('document_alert_days', 30) + ' days.', 'documents');
    docs.slice(0, 5).forEach(function (d) {
      add(d.State === 'Expired' ? 'bad' : 'warn', d.DocType + ' of ' + d.EmployeeName + (d.State === 'Expired' ? ' expired ' + d.ExpiryDate : ' expires in ' + d.DaysLeft + ' day(s)') + '.', 'documents');
    });
    var tr = trainingsList_(u, {}).filter(function (x) { return x.State === 'For Renewal' || x.State === 'Expired'; }).length;
    if (tr) add('warn', tr + ' training certificate(s) are expired or due for renewal.', 'training');
    var emps = visibleEmployees_(u).filter(isActiveEmp_);
    var contracts = emps.filter(function (e) { return e.ContractEnd && e.ContractEnd >= t && e.ContractEnd <= addDays_(t, 30); }).length;
    if (contracts) add('warn', contracts + ' contract(s) end within 30 days.', 'employees');
    var regular = emps.filter(function (e) {
      return e.EmploymentType === 'Probationary' && e.DateHired && daysBetween_(e.DateHired, t) >= 150 && daysBetween_(e.DateHired, t) <= 180;
    }).length;
    if (regular) add('info', regular + ' probationary employee(s) reach 6 months soon — evaluate for regularization.', 'performance');
    emps.filter(birthdayToday_).forEach(function (e) { add('info', '🎂 Happy birthday, ' + fullName_(e) + '!', 'employees'); });
  }
  if (isHR_(u)) {
    var fin = table_('Applicants').filter(function (a) { return a.Stage === 'Final Interview'; }).length;
    if (fin) add('info', fin + ' applicant(s) are ready for final interview.', 'recruitment');
    var rq = table_('Requests').filter(function (r) { return r.Status === 'Submitted'; }).length;
    if (rq) add('warn', rq + ' new employee request(s) to process.', 'requests');
    var pay = table_('PayrollPeriods').filter(function (p) { return p.Status === 'For Approval'; }).length;
    if (pay) add('warn', pay + ' payroll period(s) waiting for approval.', 'payroll');
  }
  if (u.employeeId) {
    table_('Leaves').concat(table_('Overtime')).filter(function (r) {
      return r.EmployeeID === u.employeeId && ['Approved', 'Rejected'].indexOf(r.Status) >= 0 && String(r.HRAt || r.ManagerAt).slice(0, 10) >= addDays_(t, -3);
    }).forEach(function (r) { add(r.Status === 'Approved' ? 'ok' : 'bad', (r.LeaveType || 'Overtime') + ' ' + r.ID + ' was ' + r.Status.toLowerCase() + '.', r.LeaveType ? 'leave' : 'overtime'); });
    table_('Requests').filter(function (r) { return r.EmployeeID === u.employeeId && r.Status === 'Completed' && String(r.UpdatedAt).slice(0, 10) >= addDays_(t, -3); })
      .forEach(function (r) { add('ok', r.Type + ' (' + r.RequestID + ') is completed.', 'requests'); });
    documentsList_(u, { employeeId: u.employeeId, expiring: true }).forEach(function (d) {
      add('warn', 'Your ' + d.DocType + (d.State === 'Expired' ? ' has expired.' : ' expires in ' + d.DaysLeft + ' day(s).'), 'documents');
    });
  }
  return n;
}

/* ------------------------------------------------------------------ reports */

var REPORTS = {
  masterlist: { group: 'Employee', title: 'Employee Masterlist' },
  byBranch: { group: 'Employee', title: 'Employees by Branch' },
  byHQ: { group: 'Employee', title: 'Employees by HQ' },
  byPosition: { group: 'Employee', title: 'Employees by Position' },
  active: { group: 'Employee', title: 'Active Employees' },
  resigned: { group: 'Employee', title: 'Resigned / Separated Employees' },
  newHires: { group: 'Employee', title: 'New Hires', range: true },
  dailyAttendance: { group: 'Attendance', title: 'Daily Attendance', date: true },
  monthlyAttendance: { group: 'Attendance', title: 'Monthly Attendance', month: true },
  late: { group: 'Attendance', title: 'Late Report', range: true },
  absence: { group: 'Attendance', title: 'Absence Report', month: true },
  overtime: { group: 'Attendance', title: 'Overtime Report', range: true },
  exceptions: { group: 'Attendance', title: 'Attendance Exceptions', range: true },
  leaveUtilization: { group: 'Leave', title: 'Leave Utilization', year: true },
  leaveBalance: { group: 'Leave', title: 'Leave Balance', year: true },
  leaveByBranch: { group: 'Leave', title: 'Leave by Branch', year: true },
  leaveByEmployee: { group: 'Leave', title: 'Leave by Employee', year: true },
  payrollRegister: { group: 'Payroll', title: 'Payroll Register', period: true, hr: true },
  salarySummary: { group: 'Payroll', title: 'Salary Summary by Branch', period: true, hr: true },
  contributions: { group: 'Payroll', title: 'Government Contributions', period: true, hr: true },
  deductions: { group: 'Payroll', title: 'Deductions', period: true, hr: true },
  otSummary: { group: 'Payroll', title: 'Overtime Summary', period: true, hr: true }
};

function report_(u, p) {
  need_(isHR_(u) || isMgr_(u), 'Reports are not available for your account.');
  if (p.list) return Object.keys(REPORTS).filter(function (k) { return isHR_(u) || !REPORTS[k].hr; })
    .map(function (k) { var o = JSON.parse(JSON.stringify(REPORTS[k])); o.id = k; return o; });
  var cfg = REPORTS[p.type]; need_(cfg, 'Unknown report.');
  if (cfg.hr) needHR_(u);
  var t = today_();
  var from = isDate_(p.from) ? p.from : t.slice(0, 8) + '01', to = isDate_(p.to) ? p.to : t;
  var year = String(p.year || t.slice(0, 4));
  var emps = visibleEmployees_(u);
  var cols, rows, sub = '';
  var empRow = function (e) { return [e.EmployeeID, fullName_(e), e.Position, e.Department, e.Branch, e.HQ, e.EmploymentType, e.Status, e.DateHired, e.Email, e.Contact]; };
  var empCols = ['Employee ID', 'Name', 'Position', 'Department', 'Branch', 'HQ', 'Employment type', 'Status', 'Date hired', 'E-mail', 'Contact'];
  var sorted = function (k) { return emps.slice().sort(function (a, b) { return (String(a[k]) + fullName_(a)).localeCompare(String(b[k]) + fullName_(b)); }); };

  switch (p.type) {
    case 'masterlist':
      cols = empCols.concat(isHR_(u) ? ['Birth date', 'SSS', 'PhilHealth', 'Pag-IBIG', 'TIN', 'Salary type', 'Basic salary'] : []);
      rows = sorted('EmployeeID').map(function (e) { return empRow(e).concat(isHR_(u) ? [e.BirthDate, e.SSS, e.PhilHealth, e.PagIBIG, e.TIN, e.SalaryType, e.BasicSalary] : []); });
      break;
    case 'byBranch': cols = empCols; rows = sorted('Branch').filter(isActiveEmp_).map(empRow); break;
    case 'byHQ': cols = empCols; rows = sorted('HQ').filter(isActiveEmp_).map(empRow); break;
    case 'byPosition': cols = empCols; rows = sorted('Position').filter(isActiveEmp_).map(empRow); break;
    case 'active': cols = empCols; rows = sorted('EmployeeID').filter(isActiveEmp_).map(empRow); break;
    case 'resigned':
      cols = empCols.concat(['Separation date', 'Reason']);
      rows = sorted('SeparationDate').filter(function (e) { return !isActiveEmp_(e); })
        .map(function (e) { return empRow(e).concat([e.SeparationDate, isHR_(u) ? e.SeparationReason : '']); });
      break;
    case 'newHires':
      sub = from + ' to ' + to; cols = empCols;
      rows = sorted('DateHired').filter(function (e) { return e.DateHired >= from && e.DateHired <= to; }).map(empRow);
      break;
    case 'dailyAttendance':
      var date = isDate_(p.date) ? p.date : t; sub = date;
      cols = ['Employee ID', 'Name', 'Branch', 'Position', 'Status', 'Time in', 'Time out', 'Hours', 'Late (min)', 'Remarks'];
      rows = attendanceToday_(u, { date: date }).list.map(function (r) { return [r.EmployeeID, r.FullName, r.Branch, r.Position, r.State, r.TimeIn, r.TimeOut, r.Hours, r.LateMins, r.Remarks]; });
      break;
    case 'monthlyAttendance':
    case 'absence':
      var s = attendanceSummary_(u, { month: p.month }); sub = s.month;
      cols = ['Employee ID', 'Name', 'Branch', 'Work days', 'Present', 'Late (times)', 'Late (min)', 'Undertime (min)', 'Absent', 'On leave', 'Incomplete', 'Hours', 'OT hours (beyond shift)'];
      rows = s.rows.filter(function (r) { return p.type !== 'absence' || r.Absent > 0; })
        .map(function (r) { return [r.EmployeeID, r.FullName, r.Branch, r.WorkDays, r.Present, r.Late, r.LateMins, r.UndertimeMins, r.Absent, r.Leave, r.Incomplete, r.Hours, r.OTHours]; });
      break;
    case 'late':
      sub = from + ' to ' + to;
      cols = ['Date', 'Employee ID', 'Name', 'Branch', 'Time in', 'Late (min)', 'Undertime (min)'];
      rows = attendanceList_(u, { from: from, to: to }).filter(function (r) { return num_(r.LateMins) > 0 || num_(r.UndertimeMins) > 0; })
        .map(function (r) { return [r.Date, r.EmployeeID, r.EmployeeName, r.Branch, r.TimeIn, r.LateMins, r.UndertimeMins]; });
      break;
    case 'overtime':
      sub = from + ' to ' + to;
      cols = ['OT no.', 'Date', 'Employee ID', 'Name', 'Branch', 'Start', 'End', 'Hours', 'Reason', 'Status', 'Payroll period'];
      rows = scoped_(u, table_('Overtime')).filter(function (o) { return o.Date >= from && o.Date <= to; })
        .map(function (o) { return [o.ID, o.Date, o.EmployeeID, o.EmployeeName, o.Branch, o.StartTime, o.EndTime, o.Hours, o.Reason, o.Status, o.PayrollPeriod]; });
      break;
    case 'exceptions':
      sub = from + ' to ' + to;
      cols = ['Date', 'Employee ID', 'Name', 'Branch', 'Time in', 'Time out', 'Exception', 'Source', 'Remarks'];
      rows = attendanceList_(u, { from: from, to: to }).filter(function (r) {
        return (!r.TimeOut && r.Date < t) || r.Source !== 'Selfie' || /not verified/i.test(r.Remarks);
      }).map(function (r) {
        var ex = !r.TimeOut && r.Date < t ? 'No time out' : r.Source !== 'Selfie' ? r.Source + ' entry' : 'Location not verified';
        return [r.Date, r.EmployeeID, r.EmployeeName, r.Branch, r.TimeIn, r.TimeOut, ex, r.Source, r.Remarks];
      });
      break;
    case 'leaveUtilization':
    case 'leaveByEmployee':
      sub = year;
      cols = ['Leave no.', 'Employee ID', 'Name', 'Branch', 'Leave type', 'From', 'To', 'Days', 'Status', 'Reason'];
      rows = scoped_(u, table_('Leaves')).filter(function (l) { return String(l.StartDate).slice(0, 4) === year && (p.type === 'leaveByEmployee' || l.Status === 'Approved'); })
        .sort(function (a, b) { return p.type === 'leaveByEmployee' ? (a.EmployeeName + a.StartDate).localeCompare(b.EmployeeName + b.StartDate) : a.StartDate.localeCompare(b.StartDate); })
        .map(function (l) { return [l.ID, l.EmployeeID, l.EmployeeName, l.Branch, l.LeaveType, l.StartDate, l.EndDate, l.Days, l.Status, l.Reason]; });
      break;
    case 'leaveBalance':
      sub = year;
      cols = ['Employee ID', 'Name', 'Branch'].concat(LEAVE_TYPES.map(function (x) { return x + ' (bal / credits)'; }));
      rows = leaveBalances_(u, { year: year }).map(function (r) {
        return [r.EmployeeID, r.FullName, r.Branch].concat(r.balances.map(function (b) { return b.Balance + ' / ' + b.Credits; }));
      });
      break;
    case 'leaveByBranch':
      sub = year;
      var m = {};
      scoped_(u, table_('Leaves')).forEach(function (l) {
        if (String(l.StartDate).slice(0, 4) !== year || l.Status !== 'Approved') return;
        m[l.Branch] = m[l.Branch] || {}; m[l.Branch][l.LeaveType] = (m[l.Branch][l.LeaveType] || 0) + num_(l.Days);
      });
      cols = ['Branch'].concat(LEAVE_TYPES).concat(['Total days']);
      rows = Object.keys(m).sort().map(function (b) {
        var vals = LEAVE_TYPES.map(function (x) { return m[b][x] || 0; });
        return [b].concat(vals).concat([vals.reduce(function (a, v) { return a + v; }, 0)]);
      });
      break;
    default:
      var period = period_(p.periodId); sub = period.Label + ' (' + period.Status + ')';
      var lines = table_('Payroll').filter(function (l) { return l.PeriodID === period.PeriodID; })
        .sort(function (a, b) { return (a.Branch + a.EmployeeName).localeCompare(b.Branch + b.EmployeeName); });
      if (p.type === 'payrollRegister') {
        cols = ['Employee ID', 'Name', 'Branch', 'Position', 'Basic pay', 'OT pay', 'Holiday pay', 'Night diff', 'Allowances', 'Absences', 'Late / undertime',
                'Gross', 'SSS', 'PhilHealth', 'Pag-IBIG', 'Tax', 'Other deductions', 'Total deductions', 'Net pay'];
        rows = lines.map(function (l) { return [l.EmployeeID, l.EmployeeName, l.Branch, l.Position, l.BasicPay, l.OTPay, l.HolidayPay, l.NightDiff, l.Allowances,
          l.AbsenceDeduction, l.LateDeduction, l.GrossPay, l.SSS, l.PhilHealth, l.PagIBIG, l.Tax, l.OtherDeductions, l.TotalDeductions, l.NetPay]; });
      } else if (p.type === 'salarySummary') {
        var g = {};
        lines.forEach(function (l) {
          var x = g[l.Branch] = g[l.Branch] || [0, 0, 0, 0];
          x[0]++; x[1] += num_(l.GrossPay); x[2] += num_(l.TotalDeductions); x[3] += num_(l.NetPay);
        });
        cols = ['Branch', 'Employees', 'Gross', 'Deductions', 'Net'];
        rows = Object.keys(g).sort().map(function (b) { return [b, g[b][0], round2_(g[b][1]), round2_(g[b][2]), round2_(g[b][3])]; });
      } else if (p.type === 'contributions') {
        cols = ['Employee ID', 'Name', 'SSS no.', 'SSS (EE)', 'PhilHealth no.', 'PhilHealth (EE)', 'Pag-IBIG no.', 'Pag-IBIG (EE)', 'TIN', 'Tax withheld'];
        rows = lines.map(function (l) { var e = findBy_('Employees', 'EmployeeID', l.EmployeeID) || {};
          return [l.EmployeeID, l.EmployeeName, e.SSS, l.SSS, e.PhilHealth, l.PhilHealth, e.PagIBIG, l.PagIBIG, e.TIN, l.Tax]; });
      } else if (p.type === 'deductions') {
        cols = ['Employee ID', 'Name', 'Branch', 'Absent days', 'Absences', 'Late / undertime (min)', 'Late / undertime', 'SSS', 'PhilHealth', 'Pag-IBIG', 'Tax', 'Other', 'Total'];
        rows = lines.map(function (l) { return [l.EmployeeID, l.EmployeeName, l.Branch, l.AbsentDays, l.AbsenceDeduction, l.LateMins, l.LateDeduction,
          l.SSS, l.PhilHealth, l.PagIBIG, l.Tax, l.OtherDeductions, l.TotalDeductions]; });
      } else {
        cols = ['Employee ID', 'Name', 'Branch', 'OT hours', 'Hourly rate', 'OT pay'];
        rows = lines.filter(function (l) { return num_(l.OTHours) > 0; }).map(function (l) { return [l.EmployeeID, l.EmployeeName, l.Branch, l.OTHours, l.HourlyRate, l.OTPay]; });
      }
  }
  var out = { title: cfg.title, subtitle: sub, columns: cols, rows: rows, generated: stamp_(), by: u.name };
  audit_(u, 'REPORT', 'Reports', p.type, sub);
  if (p.toSheet) out.url = reportToSheet_(out);
  return out;
}

/** Saves a report as a new Google Sheet in "HRIS Files/Reports" and returns its link. */
function reportToSheet_(r) {
  var ss = SpreadsheetApp.create(r.title + (r.subtitle ? ' — ' + r.subtitle : '') + ' (' + today_() + ')');
  var sh = ss.getSheets()[0];
  var data = [r.columns].concat(r.rows.map(function (x) { return x.map(function (v) { return v === null || v === undefined ? '' : v; }); }));
  sh.getRange(1, 1, data.length, r.columns.length).setValues(data);
  sh.getRange(1, 1, 1, r.columns.length).setFontWeight('bold').setBackground('#1B2A6B').setFontColor('#ffffff');
  sh.setFrozenRows(1);
  var file = DriveApp.getFileById(ss.getId());
  filesFolder_('Reports').addFile(file);
  try { DriveApp.getRootFolder().removeFile(file); } catch (e) { /* stays in My Drive too */ }
  return ss.getUrl();
}


/* ================================================================== SECTION: 6. setup and daily job */

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
