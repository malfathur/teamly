# Teamly

A self-hosted HR portal for small teams. Handles leave applications, WFH requests, expense claims, and daily clock-in/out — with email-based approvals and role-based access control.

I designed the feature scope and data model, used Claude to generate implementation, then reviewed and debugged it. The stack, schema, and product decisions are mine. Claude did the typing.

> **Desktop first.** Works on mobile but is optimised for wider screens.

Once deployed, see **[MANUAL.md](./MANUAL.md)** for a full guide on using the app.

---

## Demo mode

A built-in **demo mode** runs the full app against an *isolated local database* — no Turso, no real data, nothing to break. Visit **`/preview`** to pick a role and jump straight in, or sign in with a demo account (all use password `demo1234`):

| Role | Username |
|---|---|
| Admin | `admin` |
| HOD | `alex` |
| Approver | `maya` |
| Employee | `jordan` |

Run it locally with `npm run demo`, then open `http://localhost:3000/preview`.

---

## What it does

- **Clock In / Out** — daily punch with optional GPS and note; configurable window; late detection per employee timezone
- **Annual Leave** — dual-bucket balance (carry-forward + current year), 5-day advance notice rule, blackout dates, cancellation with automatic balance refund
- **Sick / Emergency / Unpaid / Comp-Off Leave** — MC attachment required for sick leave; reason required for emergency and comp-off
- **WFH** — max 2 days/week quota, 24-hour advance notice, per-date conflict detection
- **Expense Claims** — receipt attachment, category-based, multi-stage approval (Pending → Payment Pending → Paid)
- **Email Approvals** — one-click approve/reject links sent to approvers; employees notified on every status change
- **Team Calendar** — visual overview of approved and pending leave/WFH across all staff
- **Role-based access** — `superadmin`, `hod`, `approver_a`, `user`; approvers manage requests from their own dashboard tab
- **Admin Console** — user management, AL balances, claims, tracking (table + month + week calendar views), public holidays, blackout dates, CSV export, year-end DB reset

---

## Stack

| Layer | Tech |
|---|---|
| Server | Node.js + Express 4 |
| Database | Turso (libSQL / SQLite-compatible) |
| Auth | JWT (stored in localStorage) + bcrypt |
| Email | Resend |
| Frontend | HTML + Alpine.js (no build step) |
| Hosting | Any Node-compatible host (Render, Railway, Fly.io) |

---

## Deploy for free (Turso + Render)

Both have free tiers more than sufficient for a small team. No credit card required.

**What you need:** a GitHub account, a Turso account, a Render account.

---

### Step 1 — Fork the repo

Fork or clone this repo to your own GitHub account. Render deploys from there.

---

### Step 2 — Set up Turso (your database)

1. Sign up at [turso.tech](https://turso.tech)
2. Install the Turso CLI:
   ```bash
   # macOS / Linux
   curl -sSfL https://get.tur.so/install.sh | bash

   # Windows (PowerShell)
   irm https://get.tur.so/install.ps1 | iex
   ```
3. Log in: `turso auth login`
4. Create a database: `turso db create teamly`
5. Get your database URL: `turso db show teamly --url`
6. Create an auth token: `turso db tokens create teamly`

Keep both values — you'll paste them into Render.

---

### Step 3 — Deploy on Render

1. Sign up at [render.com](https://render.com)
2. Click **New → Web Service** and connect your GitHub account
3. Select your forked repo — Render will detect `render.yaml` automatically
4. Click **Create Web Service** but don't deploy yet

---

### Step 4 — Set environment variables

In the Render dashboard, go to your service → **Environment** tab and add:

| Variable | Value |
|---|---|
| `TURSO_DATABASE_URL` | Your Turso database URL |
| `TURSO_AUTH_TOKEN` | Your Turso auth token |
| `JWT_SECRET` | Any long random string |
| `RESEND_API_KEY` | Your Resend API key (for emails) |
| `EMAIL_FROM` | `Teamly <noreply@yourdomain.com>` |
| `APP_URL` | Your Render service URL |
| `ADMIN_USERNAME` | Username for the super admin account |
| `ADMIN_PASSWORD` | Password for the super admin account |

To generate a secure `JWT_SECRET`:
```bash
# macOS / Linux
openssl rand -base64 32

# Windows PowerShell
[Convert]::ToBase64String((1..32 | ForEach-Object { [byte](Get-Random -Maximum 256) }))
```

Once all variables are set, click **Manual Deploy → Deploy latest commit**.

---

### Step 5 — First login

Open your Render URL. Log in with the `ADMIN_USERNAME` and `ADMIN_PASSWORD` you set.

The schema is created automatically on first run. The app seeds a set of demo users — all have `force_password_reset = 1`, meaning each user sets their own password on first login. Go to **Admin → Users** to add your real team members and remove the demo accounts.

---

### Optional — deploy a public demo

Want a shareable sandbox that can't touch your real data? Deploy a **second** Render web service from the same repo and set one variable:

| Variable | Value |
|---|---|
| `DEMO_MODE` | `true` |

Leave `TURSO_*` and `RESEND_API_KEY` **unset** — demo mode uses an isolated local SQLite file (no cloud DB) and emails simply no-op. The app seeds demo accounts and sample data on boot, and Render's free tier resets the disk on each cold start, so the demo self-cleans. Share the **`/preview`** link.

Optionally, set `DEMO_URL=https://<your-demo>.onrender.com/preview` on your **real** service so its `/preview` path forwards visitors to the demo.

---

## Local setup

```bash
git clone <repo-url>
cd teamly
npm install
cp .env.example .env
```

Fill in `.env` with your Turso credentials:

```env
PORT=3000
TURSO_DATABASE_URL=libsql://your-db.turso.io
TURSO_AUTH_TOKEN=your-token
JWT_SECRET=any-long-string
RESEND_API_KEY=re_...
EMAIL_FROM=Teamly <noreply@yourdomain.com>
APP_URL=http://localhost:3000
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your-password
```

```bash
npm run dev   # hot reload via nodemon
npm start     # production
```

Runs on the configured `PORT` (default 3000).

---

## Testing

End-to-end tests use [Playwright](https://playwright.dev) (TypeScript). They boot the server on a dedicated port against an isolated `test.db`, so your dev/prod database is never touched.

```bash
npx playwright install chromium   # first time only — downloads the browser
npm test                          # run the full suite (headless)
npm run test:ui                   # interactive UI mode
npm run test:headed               # watch it run in a browser
npm run test:report               # open the last HTML report
```

28 tests cover all four roles across login (including first-time password setup), dashboard tabs, clock in/out, leave (AL/sick/emergency, balance deduction, cancellation), WFH (including the 2-per-week limit), claims, approvals (HOD and approver_a), the admin console (including superadmin-only gating), and account settings.

---

## How it works (for the technical)

**Auth** — bcrypt passwords + JWT signed with `JWT_SECRET`, stored in `localStorage`. Sessions expire in 8 hours. New users get `force_password_reset = 1` and set their own password on first login via a separate `/api/auth/set-password` route. Self-service password change available via `PUT /api/auth/change-password`.

**Database** — Turso is libSQL (SQLite-compatible) hosted serverlessly. The app connects via `@libsql/client`. Schema and column migrations run automatically on start via `initDB()`. No separate migration tool needed.

**Email** — Resend API. Approval emails contain tokenized one-click approve/reject links (`GET /api/token/:id`). Employee status notifications fire after every approve/reject action. An 8AM cron job emails the HOD on the first day of any approved annual leave.

**Leave day counting** — weekends and public holidays are excluded. Public holidays support a `region` column (`MY`, `UK`, `ALL`) matched against the employee's timezone.

**Rendering** — all pages are static HTML files with Alpine.js for reactivity. No build step. The server serves `public/` as static files and exposes a JSON API.

**Security** — login is rate-limited (10 attempts per 15 min per IP). No public endpoint enumerates users. Base64 file attachments (MC docs, claim receipts) are stored in the DB and never written to disk.

---

## Project structure

```
server.js          — Express server, all API routes, email helpers, cron jobs
public/
  login.html       — Login page (username + password)
  dashboard.html   — Employee console (Alpine.js) — leave, WFH, claims, clock, calendar
  admin.html       — Admin / approver console
  favicon.svg      — App icon
.env.example       — Environment variable template
render.yaml        — One-click Render deploy config
Dockerfile         — Container build
```

---

## Built by

[GitHub](https://github.com/malfathur) · [LinkedIn](https://linkedin.com/in/akmal-fathurrahman-02a27b218)
