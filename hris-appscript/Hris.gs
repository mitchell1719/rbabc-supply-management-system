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
