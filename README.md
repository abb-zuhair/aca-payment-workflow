# ACA Payment Request Workflow — Test Production

Digital replacement for Sama Educational Co.'s paper Payment Request form.
Requestor submits → **Accountant → Budget Supervisor → Finance Manager** approve
with their own logins → completed form prints with an "ALL APPROVALS COMPLETE"
banner for the final physical signature.

Stack: Node.js + Express + SQLite (better-sqlite3) + vanilla JS frontend.
No build step. One process. Verified by `e2e-test.sh` (185 automated checks).

---

## 1. Run locally (5 minutes)

```bash
npm install
ADMIN_PASSWORD='PickAStrongOne!' node server.js
# open http://localhost:3000  — log in as  admin / PickAStrongOne!
```

First run creates the `admin` account and the SQLite database in `./data/`.

### Locked out? Reset the admin password

If you know the current password, use the 🔑 icon in the app's top bar
("Change password"). If you're actually locked out, run this against the
same `DATA_DIR` the app uses (stop the server first):

```bash
node reset-admin-password.js NewPassword123!
```

On Railway:

```bash
railway run node reset-admin-password.js NewPassword123!
```

This only touches the admin's password hash — no other data is affected —
and forces a fresh password to be set on next login.

## Backups (important)

All data — users, requests, approvals, settings, and the audit log — lives in
one SQLite file, `payments.db`, inside `DATA_DIR`. On Railway that must be a
mounted **Volume** at the same path as `DATA_DIR` (e.g. `/data`); without a
Volume, the file is wiped on every deploy. Verify the Volume exists before
entering real data.

Take backups regularly:

- **In the app:** Admin → 📜 Audit Log → **Download database backup**. This
  streams a consistent snapshot (`.db` file) you can save anywhere. It uses
  SQLite's backup API, so it safely includes recent writes held in the WAL.
- Store copies off the server (your PC, OneDrive, etc.). The download does not
  include locally-stored attachment files; attachments kept on OneDrive are
  safe in OneDrive regardless.

To **restore** a backup: stop the app, replace `DATA_DIR/payments.db` with your
backup file (and remove any `payments.db-wal` / `payments.db-shm` sidecar files
next to it), then start the app. On Railway, upload the file onto the Volume via
`railway run` or the Railway shell, then redeploy. Test the restore on a
throwaway instance first if the data is critical.

Optional: run the automated test suite (starts its own server on port 3456,
wipes and recreates `./data`):

```bash
bash e2e-test.sh
```

## 2. Deploy to Railway (test production)

1. Push this folder to a GitHub repo (or `railway init` from the CLI).
2. Create a new Railway service from the repo. Railway auto-detects Node
   and runs `npm start`.
3. **Add a Volume** to the service and mount it at `/data` — this is critical,
   otherwise the database and uploaded invoices are wiped on every deploy.
4. Set environment variables:

   | Variable | Value |
   |---|---|
   | `DATA_DIR` | `/data` |
   | `ADMIN_PASSWORD` | a strong password (used only on first boot) |
   | `SESSION_SECRET` | any long random string |
   | `NODE_ENV` | `production` |

5. Deploy, open the generated URL, log in as `admin`, change the password
   when prompted, then go to **User Management** and add your real users.

## 3. First-day checklist (as admin)

1. Log in as `admin` → you'll be forced to set a new password.
2. **User Management** → add each person with their role and a temporary
   password. They'll be forced to set their own on first login.
3. **Workflow Settings**:
   - Approval chain: leave all three stages on, or set thresholds
     (e.g. Finance Manager only for amounts ≥ 1,000 KWD).
   - Routing: assign which Accountant / Budget Supervisor / Finance Manager
     handles each requester (or set the ⭐ Default row).
4. Ask a requestor to submit a real (small) payment request with a scanned
   invoice attached and walk it through the chain.
5. Once approved, the Accountant's **🖨 Ready to print** tab has the form:
   Print / Save as PDF → collect the physical signature → file it.

## 4. Approval chain, teams, and print customization (new)

> **Upgrading an existing deployment?** The database migrates itself on
> first boot after this update — existing users, requests, and history are
> preserved, and the `supervisor` role becomes available immediately. No
> manual steps needed, but back up your Railway volume first as routine
> practice before any redeploy.

**Supervisor stage.** The chain is now
**Supervisor → Accountant → Budget Supervisor → Finance Manager**, in that order.
Toggle any stage off or set its minimum amount in Workflow Settings, same as before.

**Groups / Teams.** In User Management → Teams, create a team for any approver
role (Supervisor / Accountant / Budget Supervisor / Finance Manager) with a
policy:
- **Any member decides** — the first team member to act sets the outcome for
  that stage (useful for backup cover, e.g. either of two accountants).
- **All members must approve (parallel)** — every member must approve, in any
  order, before the request advances. A single rejection from any member
  rejects the request immediately. The request detail view shows a live
  ✅/⬜ checklist of who has voted.

Assign a team to a requester's stage in Workflow Settings → Routing, the same
place you assign individual people — teams appear in a separate "Teams" group
in the dropdown. Routing (person or team) is frozen onto each request at
submission, so changing team membership or routing later never affects
requests already in flight.

**Configurable stage order.** Admin → ⚙ Workflow Settings lets you **reorder**
the four approval stages with ↑/↓ arrows, not just toggle them. For example,
move Accountant to the end so the sequence becomes Supervisor → Budget
Supervisor → Finance Manager → Accountant. The numbered badges show the live
sequence. Changes apply to new requests only — in-flight requests keep the
order they started with.

**Budget tab for the Budget Supervisor.** Budget Supervisors get a 💰 Budget
tab in their own queue showing the live budget lines across the departments
they can access (Department / Budget / Utilized / Held / Available) with a
search box — read-only; only Admin registers or configures workbooks.

**Searchable budget picker.** On the request form, after choosing a
department, each budget line is a type-to-search field (by code or
description); the admin and Budget Supervisor line tables are searchable by
department, code, or description too.

**Budget Supervisor can edit before deciding.** While a request sits at the
Budget Supervisor stage, that approver (or an admin) can open **✎ Edit
request** and adjust the payee, amount, currency, payment method,
description, budget line, and custom fields — everything except the requester
and their attachments. Earlier approvals are kept; the edit is recorded in the
activity log and audit trail. Team members can edit even after casting their
own vote, while the stage is still open.

**Self-service signature & stamp.** Each approver uploads their own signature
and stamp via the 🖋 button in the top bar. They then appear automatically on
the printed form next to that person's name in the Digital Approvals grid.
PNG with a transparent background works best; images are served only to
logged-in users.

**Customizable print form.** Admin → 🖨 Print Form lets you edit, with a live
preview: organization name, logo letter(s), form title, an optional header
note, which sections appear (Finance Use Only, Digital Approvals, image
attachments as extra pages, the "all approvals complete" banner), and the
final signature block's instruction line, signatory label, and an optional
footer note. Saved settings apply the next time anyone prints a form.

**Custom form fields.** Admin → 📝 Form Fields lets you add extra fields to
the New Payment Request form — text, long text, number, date, or dropdown,
each optionally required. New fields appear immediately on the requestor
form, in the review drawer, on the printed form (toggle-able), and as a
"Custom Fields" column in the Excel export. Field values are frozen onto
each request at submission time, so deleting or editing a field later never
changes or erases what was already submitted on past requests.

**Logo upload.** Admin → 🖨 Print Form → upload a PNG/JPG/WEBP (max 2 MB).
It replaces the letter-mark circle in the app header, the login screen, and
the printed form everywhere at once. Remove it to revert to the letter mark.
The logo is served from an unauthenticated endpoint (just the image, nothing
sensitive) so it shows even before anyone logs in.

**Recall, send back, and cancel.** A request in progress isn't stuck:
- The **requester** (or an admin) can **recall** their own request any time
  before it's fully approved. Recalling pulls it out of the queue, clears every
  approval given so far, and returns it to the start of the chain for rework.
- Any **approver** at the current stage can **send a request back** (a reason
  is required). This has the same effect — approvals cleared, back to the
  start — so the requester can fix it and resubmit through the chain.
- An **admin** can **cancel** a request outright (reason required). Cancelling
  is a terminal state, shown as "Cancelled" with its own dashboard filter.
- In every case, any budget hold the request was carrying is released
  automatically, and nothing is written to a budget sheet. Recall and cancel
  are both blocked once a payment has been finalized. These actions appear in
  the request drawer under the approval box, and each is written to the
  activity log and audit trail.

**Attachment storage on OneDrive/SharePoint.** By default, uploaded files
(PDFs and images on each request) are stored on the app server's disk — which,
on a hosted platform like Railway, consumes your volume. Admin → 💰 Budget →
**Attachment storage** lets you point uploads at **one shared
OneDrive/SharePoint folder** instead: paste the folder's share link (the same
Graph app registration and `Files.ReadWrite.All` permission as the budget
workbooks). From then on, new uploads are streamed straight to that folder via
Microsoft Graph and only a reference is kept in the database, so the server
stays lean. Files are named `<request-id>__<index>__<original-name>` so they're
identifiable in the folder. Files already stored locally keep working — each
attachment remembers where it lives, so the app serves cloud files from
OneDrive and older files from disk transparently. If a OneDrive upload ever
fails at submit time, the file falls back to local storage and the event is
logged, so an attachment is never lost.

**Multi-department budget integration.** Admin → 💰 Budget lets you register
**one workbook per department** — IT, HR, Maintenance, and so on — each with
its own OneDrive link (or a local copy for testing). Every workbook is the
"… Tracker" / "… Log" sheet-pair style, self-maintaining via its own SUMIF
formulas. Global policy (block vs. warn on over-budget) and whether a budget
line is mandatory are set once and apply across all departments.

**Per-user department access.** In the same tab, a grid lets you tick which
departments each requester (or Budget Supervisor) may charge. Leave a person's
row entirely unticked to give them access to **all** departments (the
default). Access is enforced server-side: a user can neither see nor charge a
department they aren't granted.

**Picking budget lines on a request.** The requester first chooses a
department (only the ones they can access appear), then allocates the request
amount across **one or more budget lines within that department** — a split.
Each line is a type-to-search picker showing the live available balance, and a
running summary confirms the split adds up to the request total (submission is
blocked until it balances). Splitting across different departments in a single
request is intentionally not allowed; keep one request to one department.

**Two-phase lifecycle: reserve, then deduct.** This mirrors real accounting —
a commitment is reserved as soon as it's approved internally, but only becomes
an actual expenditure once the payment is truly issued:
- The moment the **Budget Supervisor approves**, each split line's amount is
  **blocked (reserved)** against that line. Everyone immediately sees the
  reduced "available" balance, so the same money can't be double-booked — but
  nothing is written to any Log sheet yet.
- Once fully approved, the Accountant sees the request in the **💳 Finalize
  Payment** tab. Finalizing — optionally noting a cheque/transfer reference —
  **appends one row per split line to that department workbook's matching Log
  sheet** (Date, Ref/PRQ No. = the request reference, vendor/description,
  Unique Code, Amount). The workbook's own SUMIF formulas do the deduction;
  the app never edits tracker cells or the log's formula columns.
- Hold and real deduction are mutually exclusive per line, so "available"
  never double-counts: it drops at the hold and stays put when finalizing
  moves that amount from "held" to "utilized". Rejection releases holds.
- Sync status shows on the request. If OneDrive was unreachable at finalize
  time, the failure is logged and Admin/Accountant get a **Retry budget sync**
  button. Double-writes and double-finalizes are blocked.
- The Excel export's **Budget Line** column lists every split line with its
  amount and department; **Payment Finalized** and **Budget Sync** columns
  record who/when/where.

Two connection modes per department:
- **OneDrive / SharePoint (recommended):** paste the workbook's share link.
  Uses the Microsoft Graph workbook API, which edits ranges in place — safe
  for the live master file. Requires the same Entra app registration as email
  plus the **Files.ReadWrite.All application permission** (admin consent), or
  Sites.Selected scoped to the specific site.
- **Local file (testing):** a path to an .xlsx on the server. This mode
  rewrites the whole file via exceljs, so use it only with copies — keep the
  real masters on OneDrive.

**Fully customizable print layout.** Admin → 🖨 Print Form → **Form layout**
goes beyond section toggles: every individual field on the printed form —
Department, Payee Name, Amount, Finance Use fields, custom fields, all of
them — can be independently shown or hidden, relabeled, and reordered with
the ↑/↓ arrows. You can also add your own **section headers** (dividers to
group fields) and **fixed text rows** (a label + text that appears on every
printed form, e.g. a disclaimer or board-resolution reference), and delete
those again if no longer needed. Standard and custom-data fields can't be
deleted outright (so you never lose the ability to bring one back) — hide
them instead, then use "Show a hidden field" to restore them. A live preview
updates as you edit. "Reset layout to default" restores the original field
set, order, and visibility.

## 5. Email notifications (Microsoft Graph)

The app emails the right people automatically:
- **Stage change** → the assigned approver (or all active users of that role) gets
  "[Action needed] Payment request ACA-… awaiting Accountant approval"
- **All approvals complete** → the requestor + accountant(s) get
  "[Approved] … ready for printing & final signature"
- **Rejection** → the requestor gets the stage and written reason

Without configuration the app still works — every email that *would* have been
sent is recorded in the Audit Log instead, so you can verify recipients before
going live.

### One-time Entra setup (you have admin access)

1. **Entra admin center → App registrations → New registration**
   (e.g. "ACA Payment Workflow"), single tenant.
2. **API permissions → Add → Microsoft Graph → Application permissions →
   `Mail.Send`** → Grant admin consent.
3. **Certificates & secrets → New client secret** — copy the value.
4. Create or pick a sending mailbox, e.g. `payments@aca.edu.kw`.
5. **Strongly recommended:** restrict the app to that one mailbox with an
   Exchange Online application access policy, otherwise `Mail.Send` app
   permission can send as anyone in the tenant:
   ```powershell
   New-ApplicationAccessPolicy -AppId <client-id> -PolicyScopeGroupId payments@aca.edu.kw \
     -AccessRight RestrictAccess -Description "ACA payment workflow sender"
   ```
6. Set env vars on Railway:

   | Variable | Value |
   |---|---|
   | `MS_TENANT_ID` | Directory (tenant) ID |
   | `MS_CLIENT_ID` | Application (client) ID |
   | `MS_CLIENT_SECRET` | the secret value |
   | `MAIL_FROM` | `payments@aca.edu.kw` |
   | `APP_URL` | your Railway URL (used for the button link in emails) |

Users must have their **email filled in** (User Management) to receive mail.
The admin dashboard shows a banner indicating whether email is active.

## 6. Excel export

**📥 Export to Excel** appears on the admin Track Requests tab and on the
Accountant / Finance Manager queue. It downloads
`ACA_Payment_Requests_YYYY-MM-DD.xlsx` with one row per request:
reference, date, color-coded status, requestor, department, payee,
type/method, amount (real number, 3-decimal KWD format), Request/Voucher/Vendor
numbers, each approver with decision date, completion date, rejection reason,
and attachment filenames. Header is frozen with autofilter on — ready for
Finance reconciliation. Requestors cannot access the export.

## 7. What's enforced server-side

- Sessions + bcrypt password hashes; forced password change on first login
- Role checks on every endpoint — a requestor can never approve, an approver
  can never act out of stage order, a non-assigned approver is blocked by name
- Double-approval race protection (second decision on the same stage → 409)
- Currency mandatory for bank transfers; reject requires a written reason
- Attachments: PDF/JPG/PNG/WEBP only, 10 MB each, max 10 per request;
  requestors can only download files on their own requests
- Append-only audit log of logins, config changes, and every decision
  (Admin → 📜 Audit Log)

## 8. Known limits of this test build (before full production)

- **Single admin account** (`admin`). Add more admins directly via
  User Management API if needed.
- **Name + password login.** The production plan is Microsoft Entra SSO so
  staff use their existing ACA accounts and offboarding is automatic.
- **SQLite** is perfect for this volume (a school's payment requests) but
  if you later want multi-instance scaling, swap to PostgreSQL — the data
  layer is isolated in `db.js`.
- Printed output is the app's HTML rendition of the form. To emit the exact
  official `Payment_Request_form.pdf`, add `pdf-lib` form-filling
  (field names via `pdftk Payment_Request_form.pdf dump_data_fields`).

## 9. Project layout

```
server.js        Express app: auth, users, teams, workflow, routing, requests, files, print settings, audit
db.js            SQLite schema (+ migration), admin seeding, config helpers
notify.js        Microsoft Graph email notifications
graph.js         Shared Graph token client (+ file up/download)
budget.js        Multi-department budget integration (OneDrive + local)
attachments.js   Attachment storage (OneDrive folder or local disk)
reset-admin-password.js  Standalone admin password reset (for lockouts)
public/
  index.html     UI shell + styles
  app.js         Frontend (login, requestor form, approver queues, admin portal, print)
e2e-test.sh      185-check automated workflow test
data/            Created at runtime: payments.db + uploads/   (mount a volume here)
```
