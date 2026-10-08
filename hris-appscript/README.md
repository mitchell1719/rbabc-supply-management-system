# RB ABC HRIS — Google Apps Script

A Human Resources Information System that runs as a **Google Apps Script web app** on a **Google Sheet** in your
Google Drive. The sheet is the database, and uploaded files (selfies, documents, certificates, resumes) go to a
**HRIS Files** folder next to it.

```
Code.gs          the whole server side: web app, login / sessions, roles & permissions, sheet tables,
                 employees, attendance, leave, overtime, payroll, recruitment, performance, training,
                 documents, requests, organization, reports, settings, setup() and dailyJobs()
Index.html       the whole page: styles, login, sidebar, dashboard and every module screen
appsscript.json  manifest (Manila time zone, V8, web app settings)
```

## Install in Google Drive

1. In the Drive folder for the HRIS, make a new **Google Sheet** and name it, for example, `RB ABC HRIS (Database)`.
2. In the sheet, open **Extensions → Apps Script**.
3. In the editor, open **Project Settings** (gear) and tick **Show "appsscript.json" manifest file in editor**.
4. Paste the files:
   * **Code.gs**: replace the contents of the `Code.gs` the editor started with.
   * **Index.html**: click **+ → HTML**, name it `Index`, and replace its contents.
   * **appsscript.json**: replace its contents.
5. Choose **setup** in the function list and click **Run**. Accept the permissions (Sheets, Drive, Gmail send, triggers).
   This creates every sheet tab and the starting HQs, branches, departments, positions, 2026 holidays and settings.
   It also makes the first **Super Admin** account: username `admin`, password `rbabc@hris`.
6. Choose **installTriggers** and click **Run**. This sets up the nightly job at about 12:30 AM Manila time.
7. Click **Deploy → New deployment → Web app** and set:
   * Execute as: **Me**
   * Who has access: **Anyone**

   Then click **Deploy** and copy the web app URL. That URL is the HRIS.
8. Open the URL and log in as `admin` with the password `rbabc@hris`. You will be asked to choose a new one.

**Default password:** `rbabc@hris` is the starting password for the admin and is pre-filled for new accounts and
password resets (`DEFAULT_PASSWORD` in `Code.gs`, `DEFAULT_PW` in `Index.html`). Everyone must change it at
first login. **Forgot the admin password?** Run `resetAdminPassword()` from the editor: `admin` goes back to
`rbabc@hris`.

After you change the code later, use **Deploy → Manage deployments → Edit → Version: New version**. This keeps the
same URL. If an update adds sheet columns, run `setup()` again. It is safe: it only adds missing tabs, columns and
starting rows.

## Import the RB ABC Directory

The HRIS can load your existing **RB ABC - Directory** spreadsheet, so you don't retype everyone.

1. In **HR Settings**, set `directory_source` to the directory's link. It is pre-filled with the link you gave.
   A Google Sheet works directly. An Excel file (`.xlsx`) is converted to a Google Sheet copy in `HRIS Files/Directory`.
2. Click **HR Settings → Import from directory…** (or **Directory → Import from directory**). You can also run
   `importDirectory()` from the editor.

What it does:
* **People tabs** (RB Execom, RB Supply Officer, RB Office Staff, RB Nurses LUZ / VIS / MIN) become **Employees**.
  It brings in name, gender, position, branch, contact, e-mail, address, birth date, date of appointment, employee or
  ID number, TIN, SSS, PhilHealth, Pag-IBIG, bank account, emergency contact and resignation date.
  Execom and office staff go to **Central Office**, and Supply Officers go to their HQ.
* **RB Branches** tabs fill in each branch's code, address, phone, e-mail and date opened. Branches the HRIS doesn't
  have yet are added.
* **RB Managers** sets each branch's manager and creates a **Branch Manager** account covering their branches.
* Every active employee gets an **Employee** account. The username is first initial + last name (e.g. `jsoquite`)
  and the password is **`rbabc@hris`**, which they must change at first login. **User Management** lists the usernames.
* Partners, Cirquolus (which holds passwords), CSR and info tabs are **not** imported. The Directory page shows the
  Emergency Contact Numbers, Government Offices and Runners tabs read-only.

You can run it again after the directory changes. It matches people by employee number or name, adds new ones, and
fills only empty fields, so edits made in the HRIS are kept. The account that deployed the web app must be able to
open the directory file.

## Can't log in?

Run **`checkLogin()`** in the Apps Script editor and read the Execution log. It checks the spreadsheet, the `admin`
account, whether the password is still `rbabc@hris`, and the 10-minute lock after 5 wrong tries.
**`resetAdminPassword()`** sets `admin` back to `rbabc@hris` and clears the lock. After pasting new code, always use
**Deploy → Manage deployments → Edit → Version: New version**. Otherwise the web app link keeps running the old code.

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

Every rule is checked on the server (`api()` in `Code.gs`), so hiding a button is never the only protection.
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
