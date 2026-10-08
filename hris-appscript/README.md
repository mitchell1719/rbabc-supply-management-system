# RB ABC HRIS — Google Apps Script

A Human Resources Information System that runs as a **Google Apps Script web app** on a **Google Sheet** in your
Google Drive. The sheet is the database, and uploaded files (selfies, documents, certificates, resumes) go to a
**HRIS Files** folder next to it.

```
Code.gs        web app entry, login / sessions, router, roles & permissions
Db.gs          sheet "tables" (schema, read / insert / update), ids, Drive files, audit log, e-mail
Hris.gs        employees, attendance, leave, overtime, approvals, recruitment, performance,
               training, documents, employee requests, organization, settings, users
Payroll.gs     payroll periods, computation (SSS, PhilHealth, Pag-IBIG, BIR tax), approval, payslips
Reports.gs     dashboard, notification center, downloadable reports
Setup.gs       setup() — creates the sheets and starting data; dailyJobs() — nightly maintenance
Index.html     page shell (sidebar, header, login)
Styles.html    styles
App.html       browser: session, navigation, dialogs, tables, charts, CSV / print
Pages.html     dashboard, employees, profile, attendance, leave, overtime, payroll, payslips
Pages2.html    recruitment, performance, training, documents, requests, departments, positions,
               branches, holidays, organizational structure, reports, settings, users, roles, audit logs
appsscript.json  manifest (Manila time zone, V8, web app settings)
```

## Install in Google Drive

1. In the Drive folder for the HRIS, make a new **Google Sheet** and name it, for example, `RB ABC HRIS (Database)`.
2. In the sheet, open **Extensions → Apps Script**.
3. In the editor, open **Project Settings** (gear) and tick **Show "appsscript.json" manifest file in editor**.
4. Create the files with the same names and paste in their contents:
   * Script files (**+ → Script**): `Code`, `Db`, `Hris`, `Payroll`, `Reports`, `Setup`. The editor adds `.gs` itself.
   * HTML files (**+ → HTML**): `Index`, `Styles`, `App`, `Pages`, `Pages2`.
   * Replace the contents of `appsscript.json`.
   * Delete the empty `Code.gs` the editor started with, or paste `Code.gs` into it.
5. Choose **setup** in the function list and click **Run**. Accept the permissions (Sheets, Drive, Gmail send, triggers).
   This creates every sheet tab and the starting HQs, branches, departments, positions, 2026 holidays and settings.
   It also makes the first **Super Admin** account. Open **Execution log** to see its username (`admin`) and
   temporary password.
6. Choose **installTriggers** and click **Run**. This sets up the nightly job at about 12:30 AM Manila time.
7. Click **Deploy → New deployment → Web app** and set:
   * Execute as: **Me**
   * Who has access: **Anyone**

   Then click **Deploy** and copy the web app URL. That URL is the HRIS.
8. Open the URL and log in as `admin` with the temporary password. You will be asked to choose a new one.

After you change the code later, use **Deploy → Manage deployments → Edit → Version: New version**. This keeps the
same URL. If an update adds sheet columns, run `setup()` again. It is safe: it only adds missing tabs, columns and
starting rows.

## First steps after installing

1. **HR Settings** (Super Admin): check `company_name`, `default_shift` (08:00–17:00, 15-minute grace period, Sunday
   rest day) and `leave_credits`. Have Accounting confirm the **payroll** rates before the first payroll.
2. **Branches**: open each branch on a phone inside the branch and tap **Use my current location**. This sets its GPS
   point and radius so selfie attendance can check that people are on site.
3. **Holidays**: check the 2026 list against the official Proclamation. Add the Eid holidays and any local holidays.
4. **Employees → + New employee**: add everyone. Employee IDs start at `RB-0001`, and the prefix is a setting.
5. **User Management**: create the accounts.
   * **HR Admin**: the HR team.
   * **Branch Manager**: tick the branches they cover. Link their own employee record so they can file their own
     leave and overtime too.
   * **Employee**: link to the employee record. One account per employee.

   New accounts get a temporary password, and the person must change it at first login.

## What is in it

| Module | What it does |
| --- | --- |
| Dashboard | Total / active / on leave / absent today, new hires, probationary, regular, resigned, pending applications, leave, overtime, payroll, expiring documents, birthdays. Charts: employment type, employees by HQ, 3-week attendance trend, hiring pipeline. Payroll summary of the current period. |
| Employees | Masterlist with search and filters, CSV. Profile with personal, employment and government information, documents, leave, attendance, training and performance. Status changes: separation deactivates the account; probationary staff can be regularized. |
| Attendance | Selfie + GPS time in / out checked against the branch radius. Late, undertime, and hours beyond the shift are computed from the employee's shift (or the default). Rest days and holidays are marked. Today's board (present, late, absent, on leave, rest day). Records with selfies, monthly summary, manual entry by HR, attendance correction workflow. Time-ins with no time-out are closed as Incomplete each night. |
| Leave | Vacation, sick, emergency, maternity, paternity, bereavement and other leave, with an attachment. Rest days and holidays are not counted, and half days are allowed. Workflow: **Employee → Branch Manager → HR → Approved / Rejected**. Yearly credits come from the default or are set per employee. The balance is checked before HR approves. |
| Overtime | Workflow: **Employee → Manager → HR → Approved → Payroll**. Approved hours are paid in that period and tagged with the period when payslips are released. |
| Payroll | Semi-monthly periods. Generate builds each line from salary (monthly or daily), attendance (absences, late / undertime), paid leave, approved overtime (ordinary, rest day / special and regular holiday rates), holiday premiums and the allowance. Then it computes SSS, PhilHealth, Pag-IBIG and withholding tax. HR can adjust night differential, allowances, other deductions and so on. Flow: **Draft → For Approval → Approved** (by another HR Admin or the Super Admin) **→ Released**. Printable payslips. Branch Managers see a limited view with no amounts; employees see only their own released payslips. |
| Recruitment | Job openings and applicants with resumes. Pipeline: Applied → Screening → Interview → Assessment → Final Interview → Job Offer → **Hire**, which creates a Probationary employee profile and copies the resume to their documents. |
| Performance | Attendance, patient service, clinical compliance, documentation and teamwork, each scored 0–100. Overall score and rating: Outstanding, Very Good, Good, Needs Improvement or Unsatisfactory. Branch Managers evaluate their own branches. |
| Training | Record one training for several employees at once, with certificate file and expiry. Shows Completed, Upcoming, Expired and For Renewal. |
| Documents | Repository for each employee: contract, resume, IDs, medical certificate, PRC license, DOH certificate and so on. Expiry alerts, and a weekly digest to HR every Monday. |
| Employee requests | COE, certificate of compensation, salary certificate, employment verification, ID replacement, schedule change and others. Flow: **Submitted → In Review → Approved → Completed**. |
| Management | Departments, positions, branches (with GPS), holidays, and an organizational structure tree (company → HQ → branch → employees). |
| Reports | Employee, attendance, leave and payroll reports (22 in all). View them on screen, download as CSV, print, or save as a Google Sheet in `HRIS Files/Reports`. |
| Notifications | Bell icon and sidebar badges for approvals waiting on you, expiring documents and certificates, contracts ending, probationary staff reaching 6 months, final interviews, payroll waiting for approval and birthdays. E-mails go out at each workflow step and can be turned off in settings. |
| Settings | HR settings, user management, the roles & permissions matrix and the audit log of every change. |

## Roles

| | Super Admin | HR Admin | Branch Manager | Employee |
| --- | --- | --- | --- | --- |
| Employees | Edit | Edit | View their branches (no salary / gov. IDs) | Own profile |
| Attendance | All | All | Their branches + approve corrections | Own (selfie time in / out) |
| Leave / overtime | Approve | Final approval | First-level approval | Own requests |
| Payroll | All | Prepare, approve (not their own), release | Limited view (no amounts) | Own released payslips |
| Recruitment, requests | All | All | — | Own requests |
| Reports | All | All | Their branches (no payroll) | — |
| HR settings, users, audit log | ✓ | — | — | — |

Every rule is checked on the server (`Code.gs` → `api()`), so hiding a button is never the only protection.
Requests go straight to HR when no Branch Manager account covers the employee's branch. They also go straight to HR
when the requester is the manager.

## Notes

* **Passwords** are salted and hashed in the `Users` sheet. **Sessions** last 6 hours. Five wrong passwords lock the
  username for 10 minutes.
* **Keep the spreadsheet private.** It holds salaries and government numbers. Share it only with the HRIS owner. Users
  reach the data through the web app, which runs as the owner.
* **Payroll rates** (`payroll` setting): the SSS 5% employee share has an MSC of 5,000–35,000. PhilHealth is 2.5% of
  10,000–100,000. Pag-IBIG is 2% up to 10,000. The BIR semi-monthly table is the 2023+ TRAIN table. Monthly-paid daily
  rate = salary × 12 ÷ 261. OT is 125%, 169% on a rest day or special holiday, and 260% on a regular holiday.
  Contributions are split in half across the two cut-offs. Update these when the agencies change their tables, and
  have Accounting confirm them before the first payroll.
* **Quotas**: consumer Gmail accounts can send about 100 e-mails a day from Apps Script; Google Workspace accounts get
  more. With a few hundred employees a Sheet is fine. Archive old Attendance rows to another sheet once a year.
* **Selfies on phones**: the file picker opens the front camera, and GPS must be allowed for the page.
