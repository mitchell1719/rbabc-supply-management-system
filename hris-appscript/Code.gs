/**
 * RB ABC HRIS — Google Apps Script web app on a Google Sheet.
 *
 * Code.gs     web app entry, login / sessions, router, roles & permissions
 * Db.gs       sheet "tables": read, insert, update, ids, files, audit log
 * Hris.gs     employees, attendance, leave, overtime, recruitment, performance,
 *             training, documents, requests, organization, settings, users
 * Payroll.gs  payroll periods, computation (SSS, PhilHealth, Pag-IBIG, tax), payslips
 * Reports.gs  dashboard, notifications, downloadable reports
 * Setup.gs    setup(): creates every sheet, seeds HQs / branches / settings and the first admin
 *
 * Every rule (who may see or change what) is checked here on the server; the
 * browser only shows what the server returns.
 */

var TZ = 'Asia/Manila';
var SESSION_HOURS = 6;

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
  var t = HtmlService.createTemplateFromFile('Index');
  return t.evaluate()
    .setTitle(setting_('portal_title', 'RB ABC HRIS'))
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
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
