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
