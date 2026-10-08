# RB ABC Supply Management System

The RB ABC Supply Office Portal (previously a Google Apps Script web app on Google Sheets) rebuilt as an
**Angular** web app with a **Supabase** (Postgres) database.

```
supabase/
  migrations/        database schema, row level security and every workflow as SQL functions
  seed.sql           HQs, branches, settings, refrigerators, attendance sites, employees, DSM groups, starter products
  functions/         Edge Functions: send-emails (e-mail outbox → Resend), admin-users (create / edit accounts)
  tests/             runs all migrations + an end-to-end workflow test on a plain Postgres
scripts/
  create-users.mjs   creates the starting accounts (Admin, HQs, RNS, Finance, one per branch)
web/                 the Angular app
hris-appscript/      RB ABC HRIS — separate Google Apps Script web app on a Google Sheet (see hris-appscript/README.md)
```

## What is in it

| Area | Who | What |
| --- | --- | --- |
| Purchase requisitions (PRS) | Branch → RNS → HQ | Branch submits; RNS reviews, approves or returns; branch fixes and resubmits; HQ sees it after approval. Scanned PRS upload. E-mails at every step. |
| Vial wastage | Branch, RNS, HQ, Admin | Daily ARV wastage by volume (ID 0.2 mL, booster 0.1 mL, IM 1 vial), flagged above the set ratio. |
| Ref temperature | Branch, HQ, RNS, Admin | AM / PM readings per refrigerator, out-of-range alerts, monthly chart. |
| Deliveries | HQ → Branch → HQ | Delivery note from HQ inventory batches (with PRS lookup, partial deliveries, substitutes), branch receiving report, HQ validation; validated deliveries post to the branch stock card. Printable DN / RR. |
| Inventory | HQ, Admin | Central Warehouse + HQ stock from a stock ledger, CW purchase-order log, transfers CW → HQ, HQ receiving, expiry alerts, HQ price per unit. |
| Stock card | Branch, RNS, HQ, Admin | Daily received / used per item and batch, beginning balances, running balances, edit lock by RNS / Admin, utilization dashboard + CSV. |
| Ordered items | HQ, Admin | Ordered vs delivered vs pending per item from approved PRS, CSV. |
| Statement of Account | HQ → Admin → Finance | One SOA per DSM / BM group from validated deliveries, unit cost from the HQ price → PO of the batch → CW cost, attachments, approval, e-mail to Finance and the DSM / OIC (RNS copied) with a view-only DN & RR link, Finance receive / process / return. Printable. |
| Purchase orders | Admin → Finance | PO from the CW log, header details, submit to Finance, Finance receive / process / return. Printable. |
| Report | Admin | Purchases by supplier / item, distribution by month / region / branch / item. |
| Monday report | Admin | Wins · For cascading · For escalation per week. Printable. |
| Attendance | HQ logger, Admin monitor | TIME IN / OUT with GPS radius check and selfie, midnight auto-close, overtime remark; Admin summary, selfies, CSV. |
| Chat | everyone | Rooms per HQ / RNS / Admin and direct messages, attachments, video-call link, realtime. |
| Admin setup | Admin | Accounts, branches + RNS, HQs, quick links, DSM groups, products, stock card items, employees, attendance sites, refrigerators, settings, e-mail outbox, login log, JSON backup. |

Every rule (who may see what, who may do what, numbering such as `CEBU HQ 001-2026`, `DAN BRR 001-2026`,
`SOA CEBU 001-2026`, `PO CW 001-2026`) is enforced **in the database** (row level security + `security definer`
functions), so the browser cannot get around it.

## 1. Create the Supabase project

1. Create a project at <https://supabase.com> (region: Singapore is closest to the Philippines).
2. Install the [Supabase CLI](https://supabase.com/docs/guides/cli) and link it:
   ```bash
   supabase login
   supabase link --project-ref <your-project-ref>
   ```
3. Create the database (tables, policies, functions, storage buckets):
   ```bash
   supabase db push
   ```
4. Load the starting data — open **SQL Editor** in the dashboard, paste `supabase/seed.sql` and run it
   (or `psql "<connection string>" -f supabase/seed.sql`). Review the branches, e-mails and settings first.
5. **Authentication → Sign In / Providers → Email**: keep Email enabled, turn **off** “Allow new users to sign up”
   and “Confirm email”. Accounts are made only by the Admin (usernames log in as `<username>@rbabc.local`
   behind the scenes; nobody needs a real mailbox for it).

## 2. Create the accounts

```bash
cd scripts
npm install
SUPABASE_URL=https://<ref>.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<service role key> \
DEFAULT_PASSWORD='<a starting password>' \
npm run create-users
```

This makes `SUPPLY OFFICE` (Admin), `CEBU HQ`, `CDO HQ`, `DAVAO HQ`, `PASIG HQ`, the RNS accounts, `FINANCE`
and one account per branch named after its short name (e.g. `DANAO`), and assigns each branch to its RNS.
Everyone changes the password after the first login. Later accounts are made in **Admin setup → Accounts**.
Keep the service role key secret — never put it in the web app.

## 3. Edge Functions and e-mail

E-mails are queued in `email_outbox` by the workflows and sent by the `send-emails` function through
[Resend](https://resend.com) (free tier is enough; verify your sending domain there).

```bash
supabase secrets set RESEND_API_KEY=<resend key> \
  MAIL_FROM="RB ABC Supply Office <supply@your-domain.com>" \
  CRON_SECRET=<any long random text>
supabase functions deploy send-emails --no-verify-jwt
supabase functions deploy admin-users --no-verify-jwt   # it checks the Admin's session itself
```

Then schedule the jobs (SQL Editor; enable the `pg_cron` and `pg_net` extensions under **Database → Extensions** first):

```sql
-- send queued e-mails every 5 minutes
select cron.schedule('send-emails', '*/5 * * * *', $$
  select net.http_post(
    url     := 'https://<ref>.supabase.co/functions/v1/send-emails',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', '<CRON_SECRET>'),
    body    := '{}'::jsonb)
$$);

-- 12:01 AM Manila (16:01 UTC): close yesterday's TIME IN without TIME OUT
select cron.schedule('attendance-autoclose', '1 16 * * *', $$ select public.attendance_autoclose() $$);
```

## 4. Settings

In **Admin setup → Settings** (or the `app_settings` table) set at least:

* `portal_url` — the address where the web app is published (used in e-mails and the SOA DN & RR link)
* `finance_email` — where approved SOAs and POs go
* `supply_director_email`, `supply_director_name`
* `soa_signers`, `po_signers` — names printed on the documents
* `wastage`, `temperature`, `attendance_ot_hours`

Also set each HQ's Supply Officer e-mail (**HQs**), the RNS e-mails (**Accounts**), the DSM / OIC e-mails
(**DSM groups**) and the GPS position of each HQ (**Attendance sites** → open it on a phone inside the HQ
and tap “Use my current location”).

## 5. Run and publish the web app

Put the project URL and the **anon** key (Project Settings → API) in `web/src/environments/environment.ts`, then:

```bash
cd web
npm install
npm start              # http://localhost:4200
npm run build          # output: web/dist/rbabc-portal/browser
```

Publish `web/dist/rbabc-portal/browser` on any static host (Netlify, Vercel, Cloudflare Pages, Firebase Hosting…).
It is a single-page app: all paths must serve `index.html` (`public/_redirects` does this on Netlify / Cloudflare;
on Vercel add a rewrite of `/(.*)` to `/index.html`). Then put the published address in Authentication →
URL Configuration → Site URL and in the `portal_url` setting.

## Tests

`supabase/tests/run.sh` applies every migration and the seed to an empty Postgres (15+) with a small stub of the
Supabase `auth` / `storage` schemas, then runs `workflow_test.sql`, which signs in as each role and walks through
PRS → delivery → receiving → validation → stock card → SOA → Finance, PO, inventory, wastage, temperature,
attendance and chat, checking the row level security on the way.

```bash
PGHOST=localhost PGPORT=5432 PGUSER=postgres supabase/tests/run.sh
```

## Differences from the Apps Script version

* Data lives in Postgres instead of Google Sheets, so the “Open sheet” buttons are gone; use the Supabase
  Table Editor, the CSV downloads, or **Admin setup → Backup** (all tables as one JSON file). Supabase also keeps
  daily database backups.
* Documents (DN, RR, SOA, PO, Monday report) are printed or saved as PDF from the browser's print dialog.
* E-mails go through the outbox + Resend instead of `MailApp`; failed sends are retried and listed in **Admin setup → E-mail outbox**.
* Files (PRS scans, chat attachments, SOA attachments, selfies, profile photos) are in Supabase Storage with access rules per role.
* The rule-based help chatbot was not carried over.
