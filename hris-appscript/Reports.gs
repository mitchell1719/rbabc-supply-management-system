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
