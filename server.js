require('dotenv').config();
const express    = require('express');
const { createClient } = require('@libsql/client');
const cors       = require('cors');
const path       = require('path');
const { v4: uuidv4 } = require('uuid');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const cron       = require('node-cron');
const { Resend } = require('resend');
const rateLimit  = require('express-rate-limit');

const app     = express();
app.set('trust proxy', 1);
const PORT    = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'teamly-dev-secret-change-in-production';
const APP_URL    = process.env.APP_URL    || `http://localhost:${PORT}`;

// Default AL allocation when no balance record exists yet.
// Admin panel will let you set this per-employee per-year.
const DEFAULT_AL_DAYS = 14;

// ─── DATABASE ─────────────────────────────────────────────────────────────────

// In demo mode the app runs against an isolated local SQLite file instead of
// Turso — no cloud credentials are used, so a demo instance can never read or
// write the real production database.
const DEMO_MODE = process.env.DEMO_MODE === 'true' || process.env.DEMO_MODE === '1';

const db = createClient(
  DEMO_MODE
    ? { url: process.env.DEMO_DATABASE_URL || 'file:./demo.db' }
    : { url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN }
);

async function initDB() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      username        TEXT NOT NULL UNIQUE,
      password_hash   TEXT NOT NULL,
      email           TEXT NOT NULL UNIQUE,
      role            TEXT NOT NULL DEFAULT 'user',
      department      TEXT,
      hod_id          TEXT,
      al_approver_id  TEXT,
      created_at      TEXT NOT NULL
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS leave_balances (
      id       TEXT PRIMARY KEY,
      user_id  TEXT NOT NULL,
      year     INTEGER NOT NULL,
      bucket_a REAL DEFAULT 0,
      bucket_b REAL DEFAULT 0,
      used_a   REAL DEFAULT 0,
      used_b   REAL DEFAULT 0,
      UNIQUE(user_id, year)
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS leave_requests (
      id               TEXT PRIMARY KEY,
      user_id          TEXT NOT NULL,
      type             TEXT NOT NULL,
      start_date       TEXT NOT NULL,
      end_date         TEXT NOT NULL,
      half_day         TEXT,
      days_count       REAL NOT NULL,
      reason           TEXT,
      mc_attachment    TEXT,
      status           TEXT DEFAULT 'pending',
      approver_id      TEXT,
      rejection_reason TEXT,
      reminder_sent    INTEGER DEFAULT 0,
      created_at       TEXT NOT NULL
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS wfh_requests (
      id               TEXT PRIMARY KEY,
      user_id          TEXT NOT NULL,
      date             TEXT NOT NULL,
      reason           TEXT NOT NULL,
      status           TEXT DEFAULT 'pending',
      approver_id      TEXT,
      rejection_reason TEXT,
      created_at       TEXT NOT NULL
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS claims (
      id               TEXT PRIMARY KEY,
      user_id          TEXT NOT NULL,
      department       TEXT NOT NULL,
      item             TEXT NOT NULL,
      details          TEXT,
      amount           REAL NOT NULL,
      category_id      TEXT NOT NULL,
      receipt          TEXT NOT NULL,
      status           TEXT DEFAULT 'pending',
      approver_id      TEXT,
      rejection_reason TEXT,
      created_at       TEXT NOT NULL
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS claim_categories (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS blackout_dates (
      id         TEXT PRIMARY KEY,
      date       TEXT NOT NULL UNIQUE,
      reason     TEXT,
      created_at TEXT NOT NULL
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS public_holidays (
      id         TEXT PRIMARY KEY,
      date       TEXT NOT NULL UNIQUE,
      name       TEXT NOT NULL,
      region     TEXT NOT NULL DEFAULT 'MY',
      created_at TEXT NOT NULL
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS approval_tokens (
      id           TEXT PRIMARY KEY,
      request_type TEXT NOT NULL,
      request_id   TEXT NOT NULL,
      action       TEXT NOT NULL,
      used         INTEGER DEFAULT 0,
      expires_at   TEXT NOT NULL,
      created_at   TEXT NOT NULL
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS clock_records (
      id            TEXT PRIMARY KEY,
      employee_id   TEXT NOT NULL,
      employee_name TEXT NOT NULL,
      action        TEXT NOT NULL,
      timestamp     TEXT NOT NULL,
      latitude      REAL,
      longitude     REAL,
      note          TEXT
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS counters (
      prefix   TEXT PRIMARY KEY,
      last_val INTEGER NOT NULL DEFAULT 0
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  for (const [key, value] of [
    ['clock_start_time',    '09:00'],
    ['clock_grace_minutes', '15'],
    ['clock_window_start',  '08:00'],
    ['clock_window_end',    '09:30'],
  ]) {
    await db.execute({ sql: 'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', args: [key, value] });
  }

  for (const prefix of ['AL', 'SL', 'EL', 'CO', 'UPL', 'WFH', 'CLM']) {
    await db.execute({
      sql:  'INSERT OR IGNORE INTO counters (prefix, last_val) VALUES (?, 0)',
      args: [prefix]
    });
  }

  // Migrations — safe to re-run, ignored if column exists
  for (const sql of [
    'ALTER TABLE leave_requests ADD COLUMN ref_no TEXT',
    'ALTER TABLE wfh_requests   ADD COLUMN ref_no TEXT',
    'ALTER TABLE claims          ADD COLUMN ref_no TEXT',
    'ALTER TABLE users           ADD COLUMN claim_approver_id TEXT',
    'ALTER TABLE users           ADD COLUMN force_password_reset INTEGER DEFAULT 0',
    "ALTER TABLE users           ADD COLUMN timezone TEXT DEFAULT 'UTC'",
  ]) {
    try { await db.execute(sql); } catch (_) { /* column already exists */ }
  }

  // One-time: force all existing non-superadmin users to create their own password
  const fprMigrated = await db.execute({ sql: "SELECT value FROM settings WHERE key = 'migrated_force_password_reset'", args: [] });
  if (!fprMigrated.rows[0]) {
    await db.execute({ sql: "UPDATE users SET force_password_reset = 1, password_hash = '!' WHERE role != 'superadmin'", args: [] });
    await db.execute({ sql: "INSERT OR IGNORE INTO settings (key, value) VALUES ('migrated_force_password_reset', '1')", args: [] });
    console.log('[Teamly] Migration: all non-superadmin users flagged for first-time password creation.');
  }

  // Migration: add region column to public_holidays if missing
  try {
    await db.execute("ALTER TABLE public_holidays ADD COLUMN region TEXT NOT NULL DEFAULT 'MY'");
  } catch (_) { /* column already exists */ }

  // Ensure every non-superadmin user has an AL balance for the current year
  {
    const year = new Date().getFullYear();
    const usersRes = await db.execute({ sql: "SELECT id FROM users WHERE role != 'superadmin'", args: [] });
    for (const u of usersRes.rows) {
      await db.execute({
        sql:  'INSERT OR IGNORE INTO leave_balances (id, user_id, year, bucket_a, bucket_b, used_a, used_b) VALUES (?, ?, ?, 0, ?, 0, 0)',
        args: [uuidv4(), u.id, year, DEFAULT_AL_DAYS]
      });
    }
  }

  for (const name of ['Business Expenses', 'Client Site/Meetup']) {
    await db.execute({
      sql:  'INSERT OR IGNORE INTO claim_categories (id, name, created_at) VALUES (?, ?, ?)',
      args: [uuidv4(), name, new Date().toISOString()]
    });
  }

  const existing = await db.execute({
    sql: 'SELECT id FROM users WHERE role = ?', args: ['superadmin']
  });
  if (existing.rows.length === 0) {
    const adminUsername = process.env.ADMIN_USERNAME || 'admin';
    const adminPassword = process.env.ADMIN_PASSWORD || 'Admin@123!';
    const hash = await bcrypt.hash(adminPassword, 10);
    await db.execute({
      sql:  'INSERT INTO users (id, name, username, password_hash, email, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: [uuidv4(), 'Super Admin', adminUsername, hash, 'admin@example.com', 'superadmin', new Date().toISOString()]
    });
    console.log(`[Teamly] Super admin created — username: ${adminUsername}`);
  }

  // ── Seed employees (only if none exist yet) ──────────────────────────────
  const empCheck = await db.execute({ sql: 'SELECT id FROM users WHERE role != ?', args: ['superadmin'] });
  if (empCheck.rows.length === 0) {
    const now = new Date().toISOString();

    // Fixed IDs so FK cross-references work
    const IDs = {
      alex:    'seed-alex',
      maya:    'seed-maya',
      sam:     'seed-sam',
      jordan:  'seed-jordan',
      chris:   'seed-chris',
      noor:    'seed-noor',
      lily:    'seed-lily',
      dana:    'seed-dana',
    };

    // [id, name, username, email, role, department, hod_id, al_approver_id, claim_approver_id]
    // All seeded employees have force_password_reset = 1 — they create their own password on first login.
    const employees = [
      [IDs.alex,   'Alex Johnson',  'alex',   'alex@example.com',   'hod',        'Engineering', IDs.maya,  IDs.maya,  IDs.maya],
      [IDs.maya,   'Maya Patel',    'maya',   'maya@example.com',   'approver_a', 'Engineering', IDs.alex,  IDs.alex,  IDs.alex],
      [IDs.sam,    'Sam Rivera',    'sam',    'sam@example.com',    'hod',        'Operations',  IDs.maya,  IDs.maya,  IDs.maya],
      [IDs.jordan, 'Jordan Lee',    'jordan', 'jordan@example.com', 'user',       'Engineering', IDs.alex,  IDs.maya,  IDs.maya],
      [IDs.chris,  'Chris Wong',    'chris',  'chris@example.com',  'user',       'Engineering', IDs.alex,  IDs.maya,  IDs.maya],
      [IDs.noor,   'Noor Ahmed',    'noor',   'noor@example.com',   'user',       'Engineering', IDs.alex,  IDs.maya,  IDs.maya],
      [IDs.lily,   'Lily Chen',     'lily',   'lily@example.com',   'user',       'Operations',  IDs.sam,   IDs.maya,  IDs.maya],
      [IDs.dana,   'Dana Kim',      'dana',   'dana@example.com',   'user',       'Operations',  IDs.sam,   IDs.maya,  IDs.maya],
    ];

    for (const [id, name, username, email, role, dept, hod_id, al_approver_id, claim_approver_id] of employees) {
      await db.execute({
        sql:  "INSERT OR IGNORE INTO users (id, name, username, password_hash, email, role, department, hod_id, al_approver_id, claim_approver_id, force_password_reset, created_at) VALUES (?, ?, ?, '!', ?, ?, ?, ?, ?, ?, 1, ?)",
        args: [id, name, username, email, role, dept, hod_id, al_approver_id, claim_approver_id, now]
      });
    }
    console.log('[Teamly] Seed employees created — all must create their own password on first login.');
  }
}

// ─── EMAIL─────────────────────────────────

const resend = new Resend(process.env.RESEND_API_KEY || 'placeholder');
const EMAIL_FROM = process.env.EMAIL_FROM || 'Teamly <noreply@teamly.app>';

if (process.env.RESEND_API_KEY) {
  console.log('[Teamly] Resend API configured — emails enabled');
} else {
  console.warn('[Teamly] RESEND_API_KEY not set — emails will fail');
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

const TIMEZONE_REGION = {
  'UTC':               'ALL',
  'Europe/London':     'UK',
  'Europe/Dublin':     'UK',
  'Europe/Belfast':    'UK',
  'Asia/Kuala_Lumpur': 'MY',
};
function timezoneToRegion(tz) {
  return TIMEZONE_REGION[tz] || 'ALL';
}

function getMYTNow() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'UTC',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const g = t => parseInt(parts.find(p => p.type === t).value);
  const year = g('year'), month = g('month'), day = g('day');
  return {
    year, month, day,
    dateStr: `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`,
    bucketAExpired: month > 3
  };
}

const LEAVE_PREFIX = { AL: 'AL', sick: 'SL', emergency: 'EL', comp_off: 'CO', UPL: 'UPL' };

async function generateRefNo(prefix) {
  await db.execute({ sql: 'UPDATE counters SET last_val = last_val + 1 WHERE prefix = ?', args: [prefix] });
  const row = await db.execute({ sql: 'SELECT last_val FROM counters WHERE prefix = ?', args: [prefix] });
  return `${prefix}${String(row.rows[0].last_val).padStart(6, '0')}`;
}

function calcWorkingDays(startDateStr, endDateStr, holidaySet = new Set()) {
  let count = 0;
  const cur = new Date(startDateStr + 'T00:00:00');
  const end = new Date(endDateStr   + 'T00:00:00');
  while (cur <= end) {
    const dow = cur.getDay();
    const dateStr = `${cur.getFullYear()}-${String(cur.getMonth()+1).padStart(2,'0')}-${String(cur.getDate()).padStart(2,'0')}`;
    if (dow !== 0 && dow !== 6 && !holidaySet.has(dateStr)) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

// ─── EMAIL HELPERS──────────────────────────────────────────────────

function tokenPageHtml(title, message, success, autoClose = false) {
  const color = success ? '#38a169' : '#e53e3e';
  const bg    = success ? '#c6f6d5' : '#fed7d7';
  const closeScript = autoClose ? `<script>setTimeout(function(){window.close();},1500);</script>` : '';
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#008181;font-family:Arial,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;">
  <div style="background:white;border-radius:16px;padding:44px 40px;max-width:420px;width:90%;box-shadow:0 4px 24px rgba(0,0,0,0.10);text-align:center;">
    <h1 style="font-size:26px;letter-spacing:2px;color:#1a202c;margin:0 0 24px;">TEAMLY</h1>
    <div style="background:${bg};color:${color};padding:16px;border-radius:8px;font-weight:700;font-size:16px;margin-bottom:16px;">${title}</div>
    <p style="color:#718096;margin:0 0 24px;">${message}</p>
    ${autoClose ? `<p style="color:#a0aec0;font-size:13px;margin:0;">This tab will close automatically…</p>` : `<a href="${APP_URL}" style="display:inline-block;padding:12px 24px;background:#008181;color:white;text-decoration:none;border-radius:10px;font-weight:700;">Go to Teamly</a>`}
  </div>${closeScript}</body></html>`;
}

function rejectFormHtml(tokenId, error = '') {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#008181;font-family:Arial,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;">
  <div style="background:white;border-radius:16px;padding:44px 40px;max-width:420px;width:90%;box-shadow:0 4px 24px rgba(0,0,0,0.10);">
    <h1 style="font-size:26px;letter-spacing:2px;color:#1a202c;margin:0 0 16px;text-align:center;">TEAMLY</h1>
    <h2 style="color:#1a202c;margin:0 0 8px;font-size:18px;">Reject Request</h2>
    <p style="color:#718096;margin:0 0 20px;font-size:14px;">Please provide a reason for rejection.</p>
    ${error ? `<div style="background:#fed7d7;color:#742a2a;padding:10px;border-radius:6px;margin-bottom:16px;font-size:14px;">${error}</div>` : ''}
    <form method="POST" action="/api/token/${tokenId}">
      <textarea name="reason" placeholder="Enter rejection reason..." required
        style="width:100%;padding:12px;border:1.5px solid #cbd5e0;border-radius:6px;font-size:14px;resize:vertical;min-height:100px;box-sizing:border-box;margin-bottom:16px;"></textarea>
      <button type="submit" style="width:100%;padding:14px;background:#e53e3e;color:white;border:none;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer;">Confirm Rejection</button>
    </form>
  </div></body></html>`;
}

async function sendRequestEmail(requestType, requestId, ref_no, approverEmail, employeeName, detailsHtml, attachments = []) {
  const now     = new Date();
  const expires = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const nowStr  = now.toISOString();
  const approveTokenId = uuidv4();
  const rejectTokenId  = uuidv4();

  await db.execute({
    sql:  'INSERT INTO approval_tokens (id, request_type, request_id, action, used, expires_at, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
    args: [approveTokenId, requestType, requestId, 'approve', expires, nowStr]
  });
  await db.execute({
    sql:  'INSERT INTO approval_tokens (id, request_type, request_id, action, used, expires_at, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
    args: [rejectTokenId, requestType, requestId, 'reject', expires, nowStr]
  });

  const typeLabel  = { leave: 'Leave', wfh: 'WFH', claim: 'Claim' }[requestType] || requestType;
  const approveUrl  = `${APP_URL}/api/token/${approveTokenId}`;
  const rejectUrl   = `${APP_URL}/api/token/${rejectTokenId}`;
  const displayRef  = ref_no || requestId.slice(0, 8).toUpperCase();

  console.log(`[Teamly] Sending ${requestType} email → ${approverEmail}`);
  await resend.emails.send({
    from:        EMAIL_FROM,
    to:          approverEmail,
    subject:     `[Teamly] ${typeLabel} ${displayRef} — action required`,
    attachments: attachments.map(a => ({ filename: a.filename, content: a.content })),
    html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f0f4f8;font-family:Arial,sans-serif;">
  <div style="max-width:560px;margin:32px auto;">
    <div style="background:#008181;padding:20px 32px;border-radius:16px 16px 0 0;">
      <h1 style="color:white;margin:0;font-size:22px;letter-spacing:3px;font-weight:900;">TEAMLY</h1>
      <p style="color:rgba(255,255,255,0.75);margin:2px 0 0;font-size:11px;letter-spacing:1.5px;">Teamly</p>
    </div>
    <div style="background:white;border-radius:0 0 16px 16px;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
      <div style="padding:28px 32px 0;">
        <p style="margin:0 0 4px;font-size:12px;color:#a0aec0;text-transform:uppercase;letter-spacing:1px;font-weight:700;">${typeLabel} Request · ${displayRef}</p>
        <h2 style="margin:0 0 20px;font-size:20px;color:#1a202c;font-weight:700;">Action Required</h2>
        <div style="background:#f7fafc;border-radius:10px;padding:20px;border:1px solid #e2e8f0;">
          ${detailsHtml}
        </div>
      </div>
      <div style="padding:24px 32px;display:flex;gap:12px;">
        <a href="${approveUrl}" style="display:inline-block;padding:13px 32px;background:#38a169;color:white;text-decoration:none;border-radius:10px;font-weight:700;font-size:14px;margin-right:10px;">✓ Approve</a>
        <a href="${rejectUrl}"  style="display:inline-block;padding:13px 32px;background:#e53e3e;color:white;text-decoration:none;border-radius:10px;font-weight:700;font-size:14px;">✗ Reject</a>
      </div>
      <div style="padding:0 32px 24px;">
        <p style="color:#a0aec0;font-size:11px;margin:0;border-top:1px solid #e2e8f0;padding-top:16px;">Links expire in 7 days · <a href="${APP_URL}" style="color:#008181;text-decoration:none;">Open Teamly portal</a></p>
      </div>
    </div>
  </div></body></html>`
  });
}

async function sendClaimNotificationEmail(ref_no, approverEmail, employeeName, detailsHtml, receipt) {
  console.log(`[Teamly] Sending claim notification → ${approverEmail}`);

  const attachments = [];
  if (receipt) {
    const match = receipt.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      const mimeType = match[1];
      const ext      = mimeType.split('/')[1]?.replace('jpeg', 'jpg') || 'bin';
      attachments.push({
        filename:    `receipt_${ref_no}.${ext}`,
        content:     Buffer.from(match[2], 'base64'),
        contentType: mimeType
      });
    }
  }

  await resend.emails.send({
    from:        EMAIL_FROM,
    to:          approverEmail,
    subject:     `[Teamly] Claim ${ref_no} submitted by ${employeeName}`,
    attachments: attachments.map(a => ({ filename: a.filename, content: a.content })),
    html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f0f4f8;font-family:Arial,sans-serif;">
  <div style="max-width:560px;margin:32px auto;">
    <div style="background:#008181;padding:20px 32px;border-radius:16px 16px 0 0;">
      <h1 style="color:white;margin:0;font-size:22px;letter-spacing:3px;font-weight:900;">TEAMLY</h1>
      <p style="color:rgba(255,255,255,0.75);margin:2px 0 0;font-size:11px;letter-spacing:1.5px;">Teamly</p>
    </div>
    <div style="background:white;border-radius:0 0 16px 16px;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
      <div style="padding:28px 32px 0;">
        <p style="margin:0 0 4px;font-size:12px;color:#a0aec0;text-transform:uppercase;letter-spacing:1px;font-weight:700;">Claim · ${ref_no}</p>
        <h2 style="margin:0 0 20px;font-size:20px;color:#1a202c;font-weight:700;">New Claim Submitted</h2>
        <div style="background:#f7fafc;border-radius:10px;padding:20px;border:1px solid #e2e8f0;">
          ${detailsHtml}
        </div>
        <p style="margin:16px 0 0;font-size:13px;color:#718096;">Receipt is attached. Please review and action in the <strong>Admin Console</strong>.</p>
      </div>
      <div style="padding:24px 32px;">
        <a href="${APP_URL}/admin.html" style="display:inline-block;padding:13px 32px;background:#008181;color:white;text-decoration:none;border-radius:10px;font-weight:700;font-size:14px;">Open Admin Console</a>
      </div>
      <div style="padding:0 32px 24px;">
        <p style="color:#a0aec0;font-size:11px;margin:0;border-top:1px solid #e2e8f0;padding-top:16px;"><a href="${APP_URL}" style="color:#008181;text-decoration:none;">Open Teamly portal</a></p>
      </div>
    </div>
  </div></body></html>`
  });
}

async function sendCancellationEmail(approverEmail, employeeName, refNo, detailsHtml) {
  console.log(`[Teamly] Sending AL cancellation notice → ${approverEmail}`);
  await resend.emails.send({
    from:    EMAIL_FROM,
    to:      approverEmail,
    subject: `[Teamly] AL ${refNo} Cancelled — ${employeeName}`,
    html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f0f4f8;font-family:Arial,sans-serif;">
  <div style="max-width:560px;margin:32px auto;">
    <div style="background:#008181;padding:20px 32px;border-radius:16px 16px 0 0;">
      <h1 style="color:white;margin:0;font-size:22px;letter-spacing:3px;font-weight:900;">TEAMLY</h1>
      <p style="color:rgba(255,255,255,0.75);margin:2px 0 0;font-size:11px;letter-spacing:1.5px;">Teamly</p>
    </div>
    <div style="background:white;border-radius:0 0 16px 16px;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
      <div style="padding:28px 32px 0;">
        <p style="margin:0 0 4px;font-size:12px;color:#a0aec0;text-transform:uppercase;letter-spacing:1px;font-weight:700;">AL Cancellation · ${refNo}</p>
        <h2 style="margin:0 0 20px;font-size:20px;color:#1a202c;font-weight:700;">Annual Leave Cancelled</h2>
        <p style="margin:0 0 16px;color:#4a5568;font-size:0.95rem;"><strong>${employeeName}</strong> has cancelled their approved Annual Leave. The balance has been refunded. No action required.</p>
        <div style="background:#f7fafc;border-radius:10px;padding:20px;border:1px solid #e2e8f0;">${detailsHtml}</div>
      </div>
      <div style="padding:16px 32px 24px;">
        <p style="color:#a0aec0;font-size:11px;margin:0;border-top:1px solid #e2e8f0;padding-top:16px;"><a href="${APP_URL}" style="color:#008181;text-decoration:none;">Open Teamly portal</a></p>
      </div>
    </div>
  </div></body></html>`
  });
}

async function sendEmployeeStatusEmail(employeeEmail, employeeName, type, refNo, status, reason) {
  const typeLabel   = { leave: 'Leave', wfh: 'WFH', claim: 'Claim' }[type] || type;
  const isApproved  = ['approved', 'payment_pending'].includes(status);
  const statusLabel = status === 'payment_pending' ? 'Approved (Payment Pending)' : status.charAt(0).toUpperCase() + status.slice(1);
  const badgeColor  = isApproved ? '#38a169' : '#e53e3e';
  const reasonHtml  = (!isApproved && reason)
    ? `<p style="margin:12px 0 0;color:#4a5568;"><strong>Reason:</strong> ${reason}</p>`
    : '';
  console.log(`[Teamly] Sending status email → ${employeeEmail} (${type} ${refNo} ${statusLabel})`);
  await resend.emails.send({
    from:    EMAIL_FROM,
    to:      employeeEmail,
    subject: `[Teamly] Your ${typeLabel} ${refNo} has been ${statusLabel}`,
    html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f0f4f8;font-family:Arial,sans-serif;">
  <div style="max-width:560px;margin:32px auto;">
    <div style="background:#008181;padding:20px 32px;border-radius:16px 16px 0 0;">
      <h1 style="color:white;margin:0;font-size:22px;letter-spacing:3px;font-weight:900;">TEAMLY</h1>
    </div>
    <div style="background:white;border-radius:0 0 16px 16px;box-shadow:0 4px 24px rgba(0,0,0,0.08);padding:28px 32px;">
      <p style="margin:0 0 4px;font-size:12px;color:#a0aec0;text-transform:uppercase;letter-spacing:1px;font-weight:700;">${typeLabel} · ${refNo}</p>
      <h2 style="margin:0 0 20px;font-size:20px;color:#1a202c;">Hi ${employeeName},</h2>
      <p style="margin:0 0 16px;color:#4a5568;">Your ${typeLabel.toLowerCase()} request has been updated.</p>
      <div style="display:inline-block;padding:8px 20px;background:${badgeColor};color:white;border-radius:8px;font-weight:700;font-size:14px;">${statusLabel}</div>
      ${reasonHtml}
      <p style="margin:24px 0 0;font-size:11px;color:#a0aec0;border-top:1px solid #e2e8f0;padding-top:16px;"><a href="${APP_URL}" style="color:#008181;text-decoration:none;">View in Teamly</a></p>
    </div>
  </div></body></html>`
  });
}

async function sendWFHApproverEmail(approverEmail, approverName, employeeName, dates, reason) {
  const dateList = dates.map(d => `<li style="margin:4px 0;">${d}</li>`).join('');
  console.log(`[Teamly] Sending WFH submission email → ${approverEmail}`);
  await resend.emails.send({
    from:    EMAIL_FROM,
    to:      approverEmail,
    subject: `[Teamly] WFH request from ${employeeName} — action required`,
    html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f0f4f8;font-family:Arial,sans-serif;">
  <div style="max-width:560px;margin:32px auto;">
    <div style="background:#008181;padding:20px 32px;border-radius:16px 16px 0 0;">
      <h1 style="color:white;margin:0;font-size:22px;letter-spacing:3px;font-weight:900;">TEAMLY</h1>
    </div>
    <div style="background:white;border-radius:0 0 16px 16px;box-shadow:0 4px 24px rgba(0,0,0,0.08);padding:28px 32px;">
      <p style="margin:0 0 4px;font-size:12px;color:#a0aec0;text-transform:uppercase;letter-spacing:1px;font-weight:700;">WFH Request</p>
      <h2 style="margin:0 0 20px;font-size:20px;color:#1a202c;">Action Required</h2>
      <div style="background:#f7fafc;border-radius:10px;padding:20px;border:1px solid #e2e8f0;">
        <p style="margin:0 0 8px;"><strong>Employee:</strong> ${employeeName}</p>
        <p style="margin:0 0 8px;"><strong>Date(s):</strong></p>
        <ul style="margin:0 0 8px;padding-left:20px;">${dateList}</ul>
        <p style="margin:0;"><strong>Reason:</strong> ${reason}</p>
      </div>
      <div style="margin-top:24px;">
        <a href="${APP_URL}/admin.html" style="display:inline-block;padding:13px 32px;background:#008181;color:white;text-decoration:none;border-radius:10px;font-weight:700;font-size:14px;">Open Admin Console</a>
      </div>
      <p style="margin:24px 0 0;font-size:11px;color:#a0aec0;border-top:1px solid #e2e8f0;padding-top:16px;"><a href="${APP_URL}" style="color:#008181;text-decoration:none;">Open Teamly portal</a></p>
    </div>
  </div></body></html>`
  });
}

async function processTokenAction(token, rejectionReason) {
  if (token.request_type === 'leave') {
    const row   = await db.execute({ sql: 'SELECT * FROM leave_requests WHERE id = ?', args: [token.request_id] });
    const leave = row.rows[0];
    if (!leave)                     throw new Error('Leave request not found');
    if (leave.status !== 'pending') throw new Error('Request is no longer pending');
    if (token.action === 'approve') {
      if (leave.type === 'AL') {
        const myt    = getMYTNow();
        const balRow = await db.execute({ sql: 'SELECT * FROM leave_balances WHERE user_id = ? AND year = ?', args: [leave.user_id, myt.year] });
        if (balRow.rows[0]) {
          const bal     = balRow.rows[0];
          const availA  = myt.bucketAExpired ? 0 : Math.max(0, bal.bucket_a - bal.used_a);
          const deductA = Math.min(availA, leave.days_count);
          const deductB = leave.days_count - deductA;
          await db.execute({ sql: 'UPDATE leave_balances SET used_a = used_a + ?, used_b = used_b + ? WHERE user_id = ? AND year = ?', args: [deductA, deductB, leave.user_id, myt.year] });
        }
      }
      await db.execute({ sql: "UPDATE leave_requests SET status = 'approved' WHERE id = ?", args: [token.request_id] });
    } else {
      await db.execute({ sql: "UPDATE leave_requests SET status = 'rejected', rejection_reason = ? WHERE id = ?", args: [rejectionReason, token.request_id] });
    }
  } else if (token.request_type === 'wfh') {
    const row = await db.execute({ sql: 'SELECT * FROM wfh_requests WHERE id = ?', args: [token.request_id] });
    const wfh = row.rows[0];
    if (!wfh)                     throw new Error('WFH request not found');
    if (wfh.status !== 'pending') throw new Error('Request is no longer pending');
    if (token.action === 'approve') {
      await db.execute({ sql: "UPDATE wfh_requests SET status = 'approved' WHERE id = ?", args: [token.request_id] });
    } else {
      await db.execute({ sql: "UPDATE wfh_requests SET status = 'rejected', rejection_reason = ? WHERE id = ?", args: [rejectionReason, token.request_id] });
    }
  } else if (token.request_type === 'claim') {
    const row   = await db.execute({ sql: 'SELECT * FROM claims WHERE id = ?', args: [token.request_id] });
    const claim = row.rows[0];
    if (!claim)                     throw new Error('Claim not found');
    if (claim.status !== 'pending') throw new Error('Request is no longer pending');
    if (token.action === 'approve') {
      await db.execute({ sql: "UPDATE claims SET status = 'approved' WHERE id = ?", args: [token.request_id] });
    } else {
      await db.execute({ sql: "UPDATE claims SET status = 'rejected', rejection_reason = ? WHERE id = ?", args: [rejectionReason, token.request_id] });
    }
  }
}

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── AUTH HELPERS ─────────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}

function fmtTimestamp(isoStr, tz) {
  if (!isoStr) return null;
  return new Date(isoStr).toLocaleString('en-GB', {
    timeZone: tz || 'UTC',
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  });
}

async function getUserTimezone(userId) {
  const r = await db.execute({ sql: 'SELECT timezone FROM users WHERE id = ?', args: [userId] });
  return r.rows[0]?.timezone || 'UTC';
}

// ─── ROOT REDIRECT ────────────────────────────────────────────────────────────

app.get('/', (req, res) => res.redirect('/login.html'));

// Friendly entry point for the public demo. On a demo instance it serves the
// preview landing page; on a real deploy it forwards to the configured demo
// URL (or falls back to the login page).
app.get('/preview', (req, res) => {
  if (DEMO_MODE) return res.sendFile(path.join(__dirname, 'public', 'preview.html'));
  if (process.env.DEMO_URL) return res.redirect(process.env.DEMO_URL);
  return res.redirect('/login.html');
});

// Health check — used by uptime monitors to prevent free-tier spin-down
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// GET /api/blackout — public; used by frontend date pickers
app.get('/api/blackout', async (req, res) => {
  try {
    const result = await db.execute('SELECT id, date, reason FROM blackout_dates ORDER BY date ASC');
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/holidays — public; returns all public holidays
app.get('/api/holidays', async (req, res) => {
  try {
    const result = await db.execute('SELECT id, date, name, region FROM public_holidays ORDER BY date ASC');
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── AUTH ROUTES ──────────────────────────────────────────────────────────────

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX || '10', 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' }
});

app.post('/api/auth/probe', loginLimiter, async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Username required' });
  try {
    const result = await db.execute({ sql: 'SELECT id, name, force_password_reset FROM users WHERE username = ?', args: [username.trim()] });
    const user = result.rows[0];
    if (!user || !user.force_password_reset) return res.json({ first_time: false });
    return res.json({ first_time: true, user_id: user.id, name: user.name });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  try {
    const result = await db.execute({ sql: 'SELECT * FROM users WHERE username = ?', args: [username.trim()] });
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    // First-time login — password not set yet, skip password check
    if (user.force_password_reset) {
      return res.json({ first_time: true, user_id: user.id, name: user.name });
    }

    if (!user.password_hash || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign(
      { id: user.id, username: user.username, name: user.name, role: user.role, email: user.email },
      JWT_SECRET,
      { expiresIn: '8h' }
    );
    res.json({
      token,
      user: { id: user.id, name: user.name, role: user.role, username: user.username }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// First-time password setup — only works when force_password_reset = 1
app.post('/api/auth/set-password', async (req, res) => {
  const { user_id, password } = req.body;
  if (!user_id || !password || password.length < 8) {
    return res.status(400).json({ error: 'user_id and a password (min 8 characters) are required' });
  }
  try {
    const result = await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [user_id] });
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.force_password_reset) {
      return res.status(403).json({ error: 'Password already set. Ask an admin to reset it.' });
    }
    const hash = await bcrypt.hash(password, 10);
    await db.execute({
      sql:  'UPDATE users SET password_hash = ?, force_password_reset = 0 WHERE id = ?',
      args: [hash, user_id]
    });
    const token = jwt.sign(
      { id: user.id, username: user.username, name: user.name, role: user.role, email: user.email },
      JWT_SECRET,
      { expiresIn: '8h' }
    );
    res.json({ token, user: { id: user.id, name: user.name, role: user.role, username: user.username } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/auth/change-password', requireAuth, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'current_password and new_password are required' });
  }
  if (new_password.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }
  try {
    const result = await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [req.user.id] });
    const user   = result.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.password_hash || !(await bcrypt.compare(current_password, user.password_hash))) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    const hash = await bcrypt.hash(new_password, 10);
    await db.execute({ sql: 'UPDATE users SET password_hash = ? WHERE id = ?', args: [hash, req.user.id] });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const result = await db.execute({
      sql:  'SELECT id, name, username, email, role, department, hod_id, al_approver_id, claim_approver_id, timezone, created_at FROM users WHERE id = ?',
      args: [req.user.id]
    });
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── USER MANAGEMENT (Super Admin only) ───────────────────────────────────────

app.get('/api/users', requireAuth, requireRole('superadmin', 'hod', 'approver_a'), async (req, res) => {
  try {
    const result = await db.execute(
      'SELECT id, name, username, email, role, department, hod_id, al_approver_id, claim_approver_id, timezone, created_at FROM users ORDER BY name ASC'
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/users/:id', requireAuth, requireRole('superadmin', 'hod', 'approver_a'), async (req, res) => {
  try {
    const result = await db.execute({
      sql:  'SELECT id, name, username, email, role, department, hod_id, al_approver_id, claim_approver_id, timezone, created_at FROM users WHERE id = ?',
      args: [req.params.id]
    });
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/users', requireAuth, requireRole('superadmin', 'hod', 'approver_a'), async (req, res) => {
  const { name, username, email, password, role, department, hod_id, al_approver_id, claim_approver_id, timezone } = req.body;
  if (!name || !username || !email || !role) {
    return res.status(400).json({ error: 'name, username, email, role are required' });
  }
  const validRoles = ['superadmin', 'hod', 'approver_a', 'user'];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${validRoles.join(', ')}` });
  }
  try {
    // If admin supplies a password, use it. Otherwise mark for first-time setup.
    const hash       = password ? await bcrypt.hash(password, 10) : '!';
    const forceReset = password ? 0 : 1;
    const id  = uuidv4();
    const now = new Date().toISOString();
    await db.execute({
      sql:  'INSERT INTO users (id, name, username, password_hash, email, role, department, hod_id, al_approver_id, claim_approver_id, timezone, force_password_reset, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      args: [id, name.trim(), username.trim().toLowerCase(), hash, email.trim().toLowerCase(), role, department || null, hod_id || null, al_approver_id || null, claim_approver_id || null, timezone || 'UTC', forceReset, now]
    });
    // Auto-create AL balance for the current year (non-superadmin only)
    if (role !== 'superadmin') {
      const year = new Date().getFullYear();
      await db.execute({
        sql:  'INSERT OR IGNORE INTO leave_balances (id, user_id, year, bucket_a, bucket_b, used_a, used_b) VALUES (?, ?, ?, 0, ?, 0, 0)',
        args: [uuidv4(), id, year, DEFAULT_AL_DAYS]
      });
    }
    res.status(201).json({ id, name: name.trim(), username: username.trim().toLowerCase(), email: email.trim().toLowerCase(), role });
  } catch (e) {
    if (e.message?.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Username or email already exists' });
    }
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/users/:id', requireAuth, requireRole('superadmin', 'hod', 'approver_a'), async (req, res) => {
  const { id } = req.params;
  const { name, username, email, password, role, department, hod_id, al_approver_id, claim_approver_id, timezone } = req.body;
  try {
    const result = await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [id] });
    const user   = result.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });

    const newHash    = password ? await bcrypt.hash(password, 10) : user.password_hash;
    const forceReset = password ? 0 : user.force_password_reset;
    await db.execute({
      sql:  'UPDATE users SET name=?, username=?, password_hash=?, email=?, role=?, department=?, hod_id=?, al_approver_id=?, claim_approver_id=?, timezone=?, force_password_reset=? WHERE id=?',
      args: [
        name?.trim()                   ?? user.name,
        username?.trim().toLowerCase() ?? user.username,
        newHash,
        email?.trim().toLowerCase()    ?? user.email,
        role                           ?? user.role,
        department       !== undefined ? (department       || null) : user.department,
        hod_id           !== undefined ? (hod_id           || null) : user.hod_id,
        al_approver_id   !== undefined ? (al_approver_id   || null) : user.al_approver_id,
        claim_approver_id !== undefined? (claim_approver_id|| null) : user.claim_approver_id,
        timezone         !== undefined ? (timezone         || 'UTC') : (user.timezone || 'UTC'),
        forceReset,
        id
      ]
    });
    res.json({ success: true });
  } catch (e) {
    if (e.message?.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Username or email already exists' });
    }
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Force a user to create a new password on next login
app.put('/api/users/:id/reset-password', requireAuth, requireRole('superadmin', 'hod', 'approver_a'), async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.execute({ sql: 'SELECT id, role FROM users WHERE id = ?', args: [id] });
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
    if (result.rows[0].role === 'superadmin') return res.status(403).json({ error: 'Cannot reset super admin password this way' });
    await db.execute({
      sql:  "UPDATE users SET force_password_reset = 1, password_hash = '!' WHERE id = ?",
      args: [id]
    });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/users/:id', requireAuth, requireRole('superadmin', 'hod', 'approver_a'), async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [id] });
    const user   = result.rows[0];
    if (!user)                      return res.status(404).json({ error: 'User not found' });
    if (user.role === 'superadmin') return res.status(403).json({ error: 'Cannot delete the super admin account' });
    await db.execute({ sql: 'DELETE FROM users WHERE id = ?', args: [id] });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── LEAVE ROUTES───────────────────────────────────────────────────

// GET /api/leave/balance
app.get('/api/leave/balance', requireAuth, async (req, res) => {
  try {
    const myt    = getMYTNow();
    const year   = myt.year;
    const userId = (req.query.userId && req.user.role === 'superadmin')
      ? req.query.userId : req.user.id;

    let result = await db.execute({
      sql:  'SELECT * FROM leave_balances WHERE user_id = ? AND year = ?',
      args: [userId, year]
    });

    if (result.rows.length === 0) {
      await db.execute({
        sql:  'INSERT INTO leave_balances (id, user_id, year, bucket_a, bucket_b, used_a, used_b) VALUES (?, ?, ?, 0, ?, 0, 0)',
        args: [uuidv4(), userId, year, DEFAULT_AL_DAYS]
      });
      result = await db.execute({
        sql:  'SELECT * FROM leave_balances WHERE user_id = ? AND year = ?',
        args: [userId, year]
      });
    }

    const bal    = result.rows[0];
    const availA = myt.bucketAExpired ? 0 : Math.max(0, bal.bucket_a - bal.used_a);
    const availB = Math.max(0, bal.bucket_b - bal.used_b);

    res.json({
      year,
      bucket_a:         bal.bucket_a,
      bucket_b:         bal.bucket_b,
      used_a:           bal.used_a,
      used_b:           bal.used_b,
      available_a:      availA,
      available_b:      availB,
      total_available:  availA + availB,
      bucket_a_expired: myt.bucketAExpired
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/leave
app.get('/api/leave', requireAuth, async (req, res) => {
  try {
    let sql, args;
    if (req.user.role === 'superadmin') {
      sql  = `SELECT lr.*, u.name AS employee_name, u.department, a.name AS approver_name
              FROM leave_requests lr
              LEFT JOIN users u ON lr.user_id     = u.id
              LEFT JOIN users a ON lr.approver_id = a.id
              ORDER BY lr.created_at DESC`;
      args = [];
    } else if (['hod', 'approver_a'].includes(req.user.role)) {
      sql  = `SELECT lr.*, u.name AS employee_name, u.department, a.name AS approver_name
              FROM leave_requests lr
              LEFT JOIN users u ON lr.user_id     = u.id
              LEFT JOIN users a ON lr.approver_id = a.id
              WHERE lr.user_id = ? OR lr.approver_id = ?
              ORDER BY lr.created_at DESC`;
      args = [req.user.id, req.user.id];
    } else {
      sql  = `SELECT lr.*, u.name AS employee_name, u.department, a.name AS approver_name
              FROM leave_requests lr
              LEFT JOIN users u ON lr.user_id     = u.id
              LEFT JOIN users a ON lr.approver_id = a.id
              WHERE lr.user_id = ?
              ORDER BY lr.created_at DESC`;
      args = [req.user.id];
    }
    const result = await db.execute({ sql, args });
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/leave
app.post('/api/leave', requireAuth, async (req, res) => {
  const { type, start_date, end_date, half_day, reason, mc_attachment } = req.body;

  const validTypes = ['AL', 'sick', 'emergency', 'comp_off', 'UPL'];
  if (!type || !validTypes.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${validTypes.join(', ')}` });
  }
  if (!start_date || !end_date) {
    return res.status(400).json({ error: 'start_date and end_date are required' });
  }
  if (start_date > end_date) {
    return res.status(400).json({ error: 'start_date cannot be after end_date' });
  }
  if (half_day && start_date !== end_date) {
    return res.status(400).json({ error: 'Half day leave must have the same start and end date' });
  }
  if (type === 'sick' && !mc_attachment) {
    return res.status(400).json({ error: 'MC attachment is required for sick leave' });
  }
  if (['emergency', 'comp_off'].includes(type) && !reason?.trim()) {
    return res.status(400).json({ error: 'Reason is required for emergency and comp off leave' });
  }

  if (['AL', 'UPL'].includes(type)) {
    const myt     = getMYTNow();
    const todayMs = new Date(myt.dateStr + 'T00:00:00').getTime();
    const startMs = new Date(start_date  + 'T00:00:00').getTime();
    if ((startMs - todayMs) < 4 * 24 * 60 * 60 * 1000) {
      return res.status(400).json({ error: `${type} requires at least 5 days advance notice (including today)` });
    }
  }

  try {
    const userRow = await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [req.user.id] });
    const user    = userRow.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });

    const approverId = ['sick', 'emergency', 'comp_off'].includes(type)
      ? user.hod_id
      : user.al_approver_id;

    if (!approverId) {
      return res.status(400).json({ error: 'No approver configured for your account. Contact admin.' });
    }

    const userRegion = timezoneToRegion(user.timezone);
    const holRows    = userRegion === 'ALL'
      ? await db.execute({ sql: 'SELECT date FROM public_holidays WHERE date >= ? AND date <= ?', args: [start_date, end_date] })
      : await db.execute({ sql: 'SELECT date FROM public_holidays WHERE date >= ? AND date <= ? AND (region = ? OR region = \'ALL\')', args: [start_date, end_date, userRegion] });
    const holidaySet = new Set(holRows.rows.map(r => r.date));
    const days_count = half_day ? 0.5 : calcWorkingDays(start_date, end_date, holidaySet);
    if (days_count === 0) {
      return res.status(400).json({ error: 'No working days in the selected date range (all days are weekends or public holidays)' });
    }

    if (type === 'AL') {
      const myt    = getMYTNow();
      let balRow   = await db.execute({
        sql:  'SELECT * FROM leave_balances WHERE user_id = ? AND year = ?',
        args: [req.user.id, myt.year]
      });
      if (balRow.rows.length === 0) {
        // Auto-create with default allocation so employees can submit AL without waiting for admin
        await db.execute({
          sql:  'INSERT INTO leave_balances (id, user_id, year, bucket_a, bucket_b, used_a, used_b) VALUES (?, ?, ?, 0, ?, 0, 0)',
          args: [uuidv4(), req.user.id, myt.year, DEFAULT_AL_DAYS]
        });
        balRow = await db.execute({
          sql:  'SELECT * FROM leave_balances WHERE user_id = ? AND year = ?',
          args: [req.user.id, myt.year]
        });
      }
      const bal    = balRow.rows[0];
      const availA = myt.bucketAExpired ? 0 : Math.max(0, bal.bucket_a - bal.used_a);
      const availB = Math.max(0, bal.bucket_b - bal.used_b);
      if (days_count > availA + availB) {
        return res.status(400).json({ error: `Insufficient AL balance. Available: ${availA + availB} day(s)` });
      }
    }

    const id     = uuidv4();
    const now    = new Date().toISOString();
    const ref_no = await generateRefNo(LEAVE_PREFIX[type] || 'AL');
    await db.execute({
      sql:  `INSERT INTO leave_requests
             (id, ref_no, user_id, type, start_date, end_date, half_day, days_count, reason, mc_attachment, status, approver_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      args: [id, ref_no, req.user.id, type, start_date, end_date, half_day || null, days_count,
             reason?.trim() || null, mc_attachment || null, approverId, now]
    });

    res.status(201).json({ id, ref_no, type, start_date, end_date, days_count, status: 'pending' });

    // Send approval email (non-blocking)
    try {
      const approverRow = await db.execute({ sql: 'SELECT name, email FROM users WHERE id = ?', args: [approverId] });
      const approver    = approverRow.rows[0];
      if (approver?.email) {
        const typeLabels = { AL: 'Annual Leave', sick: 'Sick Leave', emergency: 'Emergency Leave', comp_off: 'Comp Off', UPL: 'Unpaid Leave' };
        const detailsHtml = `
          <p style="margin:0 0 8px;"><strong>Employee:</strong> ${user.name}${user.department ? ' (' + user.department + ')' : ''}</p>
          <p style="margin:0 0 8px;"><strong>Type:</strong> ${typeLabels[type] || type}</p>
          <p style="margin:0 0 8px;"><strong>Dates:</strong> ${start_date}${start_date !== end_date ? ' → ' + end_date : ''}${half_day ? ' (' + half_day + ')' : ''}</p>
          <p style="margin:0 0 8px;"><strong>Days:</strong> ${days_count}</p>
          ${reason?.trim() ? `<p style="margin:0;"><strong>Reason:</strong> ${reason.trim()}</p>` : ''}`;

        const emailAttachments = [];
        if (type === 'sick' && mc_attachment) {
          // mc_attachment is a base64 data URI, e.g. "data:image/jpeg;base64,..."
          const match = mc_attachment.match(/^data:([^;]+);base64,(.+)$/);
          if (match) {
            const mimeType = match[1];
            const ext      = mimeType.split('/')[1]?.replace('jpeg', 'jpg') || 'bin';
            emailAttachments.push({
              filename:    `mc_${user.name.replace(/\s+/g, '_')}.${ext}`,
              content:     Buffer.from(match[2], 'base64'),
              contentType: mimeType
            });
          }
        }

        await sendRequestEmail('leave', id, ref_no, approver.email, user.name, detailsHtml, emailAttachments);
      }
    } catch (emailErr) {
      console.error('[Teamly] Leave approval email failed:', emailErr.message);
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/leave/:id/approve
app.put('/api/leave/:id/approve', requireAuth, async (req, res) => {
  if (!['superadmin', 'hod', 'approver_a'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const row   = await db.execute({ sql: 'SELECT * FROM leave_requests WHERE id = ?', args: [req.params.id] });
    const leave = row.rows[0];
    if (!leave)                     return res.status(404).json({ error: 'Leave request not found' });
    if (leave.status !== 'pending') return res.status(400).json({ error: 'Request is not pending' });
    if (req.user.role !== 'superadmin' && leave.approver_id !== req.user.id) {
      return res.status(403).json({ error: 'You are not the assigned approver for this request' });
    }

    if (leave.type === 'AL') {
      const myt    = getMYTNow();
      const balRow = await db.execute({
        sql:  'SELECT * FROM leave_balances WHERE user_id = ? AND year = ?',
        args: [leave.user_id, myt.year]
      });
      if (balRow.rows.length === 0) {
        return res.status(400).json({ error: 'No AL balance record found for this employee' });
      }
      const bal     = balRow.rows[0];
      const availA  = myt.bucketAExpired ? 0 : Math.max(0, bal.bucket_a - bal.used_a);
      const deductA = Math.min(availA, leave.days_count);
      const deductB = leave.days_count - deductA;
      await db.execute({
        sql:  'UPDATE leave_balances SET used_a = used_a + ?, used_b = used_b + ? WHERE user_id = ? AND year = ?',
        args: [deductA, deductB, leave.user_id, myt.year]
      });
    }

    await db.execute({
      sql:  "UPDATE leave_requests SET status = 'approved' WHERE id = ?",
      args: [req.params.id]
    });

    try {
      const empRow = await db.execute({ sql: 'SELECT name, email FROM users WHERE id = ?', args: [leave.user_id] });
      const emp    = empRow.rows[0];
      if (emp?.email) {
        await sendEmployeeStatusEmail(emp.email, emp.name, 'leave', leave.ref_no || leave.id.slice(0,8).toUpperCase(), 'approved', null);
      }
    } catch (emailErr) { console.error('[Teamly] Leave approval email failed:', emailErr.message); }

    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/leave/:id/reject
app.put('/api/leave/:id/reject', requireAuth, async (req, res) => {
  if (!['superadmin', 'hod', 'approver_a'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { rejection_reason } = req.body;
  if (!rejection_reason?.trim()) {
    return res.status(400).json({ error: 'Rejection reason is required' });
  }
  try {
    const row   = await db.execute({ sql: 'SELECT * FROM leave_requests WHERE id = ?', args: [req.params.id] });
    const leave = row.rows[0];
    if (!leave)                     return res.status(404).json({ error: 'Leave request not found' });
    if (leave.status !== 'pending') return res.status(400).json({ error: 'Request is not pending' });
    if (req.user.role !== 'superadmin' && leave.approver_id !== req.user.id) {
      return res.status(403).json({ error: 'You are not the assigned approver for this request' });
    }
    await db.execute({
      sql:  "UPDATE leave_requests SET status = 'rejected', rejection_reason = ? WHERE id = ?",
      args: [rejection_reason.trim(), req.params.id]
    });

    try {
      const empRow = await db.execute({ sql: 'SELECT name, email FROM users WHERE id = ?', args: [leave.user_id] });
      const emp    = empRow.rows[0];
      if (emp?.email) {
        await sendEmployeeStatusEmail(emp.email, emp.name, 'leave', leave.ref_no || leave.id.slice(0,8).toUpperCase(), 'rejected', rejection_reason.trim());
      }
    } catch (emailErr) { console.error('[Teamly] Leave rejection email failed:', emailErr.message); }

    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/leave/:id/cancel
app.put('/api/leave/:id/cancel', requireAuth, async (req, res) => {
  try {
    const row   = await db.execute({ sql: 'SELECT * FROM leave_requests WHERE id = ?', args: [req.params.id] });
    const leave = row.rows[0];
    if (!leave)                        return res.status(404).json({ error: 'Leave request not found' });
    if (leave.user_id !== req.user.id) return res.status(403).json({ error: 'You can only cancel your own requests' });
    if (leave.status !== 'pending')    return res.status(400).json({ error: 'Only pending requests can be cancelled' });
    await db.execute({ sql: "UPDATE leave_requests SET status = 'cancelled' WHERE id = ?", args: [req.params.id] });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/leave/:id/cancel-approved — owner only, approved AL ≥3 days before start
app.put('/api/leave/:id/cancel-approved', requireAuth, async (req, res) => {
  const { reason } = req.body;
  if (!reason?.trim()) return res.status(400).json({ error: 'Cancellation reason is required' });
  try {
    const row   = await db.execute({ sql: 'SELECT * FROM leave_requests WHERE id = ?', args: [req.params.id] });
    const leave = row.rows[0];
    if (!leave)                        return res.status(404).json({ error: 'Leave request not found' });
    if (leave.user_id !== req.user.id) return res.status(403).json({ error: 'You can only cancel your own requests' });
    if (leave.type !== 'AL')           return res.status(400).json({ error: 'Only Annual Leave can be cancelled after approval' });
    if (leave.status !== 'approved')   return res.status(400).json({ error: 'Only approved AL requests can be cancelled this way' });

    const myt     = getMYTNow();
    const todayMs = new Date(myt.dateStr + 'T00:00:00').getTime();
    const startMs = new Date(leave.start_date + 'T00:00:00').getTime();
    if ((startMs - todayMs) < 3 * 24 * 60 * 60 * 1000) {
      return res.status(400).json({ error: 'Approved AL can only be cancelled at least 3 days before the start date' });
    }

    // Refund: restore bucket_a first (up to current used_a), remainder to bucket_b
    const balRow = await db.execute({ sql: 'SELECT * FROM leave_balances WHERE user_id = ? AND year = ?', args: [leave.user_id, myt.year] });
    if (balRow.rows.length > 0) {
      const bal     = balRow.rows[0];
      const refundA = Math.min(bal.used_a, leave.days_count);
      const refundB = leave.days_count - refundA;
      await db.execute({
        sql:  'UPDATE leave_balances SET used_a = MAX(0, used_a - ?), used_b = MAX(0, used_b - ?) WHERE user_id = ? AND year = ?',
        args: [refundA, refundB, leave.user_id, myt.year]
      });
    }

    await db.execute({ sql: "UPDATE leave_requests SET status = 'cancelled' WHERE id = ?", args: [req.params.id] });

    // Notify approver by email
    try {
      const [approverRes, userRes] = await Promise.all([
        db.execute({ sql: 'SELECT name, email FROM users WHERE id = ?', args: [leave.approver_id] }),
        db.execute({ sql: 'SELECT name FROM users WHERE id = ?',        args: [leave.user_id] })
      ]);
      if (approverRes.rows[0] && userRes.rows[0]) {
        const approver  = approverRes.rows[0];
        const employee  = userRes.rows[0];
        const dateRange = leave.start_date === leave.end_date
          ? leave.start_date
          : `${leave.start_date} → ${leave.end_date}`;
        const detailsHtml = `
          <p style="margin:0 0 8px;"><strong>Employee:</strong> ${employee.name}</p>
          <p style="margin:0 0 8px;"><strong>Dates:</strong> ${dateRange}</p>
          <p style="margin:0 0 8px;"><strong>Days:</strong> ${leave.days_count}</p>
          <p style="margin:0;"><strong>Cancellation Reason:</strong> ${reason.trim()}</p>`;
        const refNo = leave.ref_no || leave.id.slice(0, 8).toUpperCase();
        await sendCancellationEmail(approver.email, employee.name, refNo, detailsHtml);
      }
    } catch (emailErr) {
      console.error('[Teamly] Cancellation email failed:', emailErr.message);
    }

    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/admin/leave/:id/override — superadmin only
app.put('/api/admin/leave/:id/override', requireAuth, requireRole('superadmin', 'hod', 'approver_a'), async (req, res) => {
  const { status, reason } = req.body;
  if (!['approved', 'rejected', 'cancelled'].includes(status)) {
    return res.status(400).json({ error: 'Status must be approved, rejected, or cancelled' });
  }
  try {
    const row   = await db.execute({ sql: 'SELECT * FROM leave_requests WHERE id = ?', args: [req.params.id] });
    const leave = row.rows[0];
    if (!leave) return res.status(404).json({ error: 'Leave request not found' });

    const wasApproved = leave.status === 'approved';
    const nowApproved = status === 'approved';

    if (leave.type === 'AL' && wasApproved !== nowApproved) {
      const myt = getMYTNow();
      const balRow = await db.execute({
        sql:  'SELECT * FROM leave_balances WHERE user_id = ? AND year = ?',
        args: [leave.user_id, myt.year]
      });
      if (balRow.rows.length > 0) {
        const bal = balRow.rows[0];
        if (nowApproved) {
          // Deduct: was not approved, now approved
          const availA  = myt.bucketAExpired ? 0 : Math.max(0, bal.bucket_a - bal.used_a);
          const deductA = Math.min(availA, leave.days_count);
          const deductB = leave.days_count - deductA;
          await db.execute({
            sql:  'UPDATE leave_balances SET used_a = used_a + ?, used_b = used_b + ? WHERE user_id = ? AND year = ?',
            args: [deductA, deductB, leave.user_id, myt.year]
          });
        } else {
          // Refund: was approved, now overridden away
          const refundA = Math.min(bal.used_a, leave.days_count);
          const refundB = leave.days_count - refundA;
          await db.execute({
            sql:  'UPDATE leave_balances SET used_a = MAX(0, used_a - ?), used_b = MAX(0, used_b - ?) WHERE user_id = ? AND year = ?',
            args: [refundA, refundB, leave.user_id, myt.year]
          });
        }
      }
    }

    const note = `[Admin Override] ${reason?.trim() || 'No reason provided'}`;
    await db.execute({
      sql:  'UPDATE leave_requests SET status = ?, rejection_reason = ? WHERE id = ?',
      args: [status, note, req.params.id]
    });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── WFH ROUTES─────────────────────────────────────────────────────

// GET /api/wfh
// Visibility: employee sees own, HOD sees own + their approvals, superadmin sees all
app.get('/api/wfh', requireAuth, async (req, res) => {
  try {
    let sql, args;
    if (req.user.role === 'superadmin') {
      sql  = `SELECT w.*, u.name AS employee_name, u.department, a.name AS approver_name
              FROM wfh_requests w
              LEFT JOIN users u ON w.user_id     = u.id
              LEFT JOIN users a ON w.approver_id = a.id
              ORDER BY w.created_at DESC`;
      args = [];
    } else if (['hod', 'approver_a'].includes(req.user.role)) {
      sql  = `SELECT w.*, u.name AS employee_name, u.department, a.name AS approver_name
              FROM wfh_requests w
              LEFT JOIN users u ON w.user_id     = u.id
              LEFT JOIN users a ON w.approver_id = a.id
              WHERE w.user_id = ? OR w.approver_id = ?
              ORDER BY w.created_at DESC`;
      args = [req.user.id, req.user.id];
    } else {
      sql  = `SELECT w.*, u.name AS employee_name, u.department, a.name AS approver_name
              FROM wfh_requests w
              LEFT JOIN users u ON w.user_id     = u.id
              LEFT JOIN users a ON w.approver_id = a.id
              WHERE w.user_id = ?
              ORDER BY w.created_at DESC`;
      args = [req.user.id];
    }
    const result = await db.execute({ sql, args });
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/wfh
app.post('/api/wfh', requireAuth, async (req, res) => {
  const { start_date, end_date, reason } = req.body;
  const endDate = end_date || start_date;

  if (!start_date)      return res.status(400).json({ error: 'start_date is required' });
  if (!reason?.trim())  return res.status(400).json({ error: 'reason is required' });

  const toMYTDateStr = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

  // Expand range into weekday dates only
  const dates = [];
  const cur   = new Date(start_date + 'T00:00:00');
  const last  = new Date(endDate + 'T00:00:00');
  if (cur > last) return res.status(400).json({ error: 'end_date must be on or after start_date' });
  while (cur <= last) {
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) dates.push(toMYTDateStr(new Date(cur)));
    cur.setDate(cur.getDate() + 1);
  }
  if (dates.length === 0) return res.status(400).json({ error: 'No weekdays in the selected range' });

  // 24-hour advance notice for earliest date
  if ((new Date(dates[0] + 'T00:00:00').getTime() - Date.now()) < 24 * 60 * 60 * 1000) {
    return res.status(400).json({ error: 'WFH must be submitted at least 24 hours in advance' });
  }

  // Per-week quota check (max 2 per Mon–Sun week)
  const getWeekBounds = dateStr => {
    const d   = new Date(dateStr + 'T00:00:00');
    const dow = d.getDay();
    const mon = new Date(d);
    mon.setDate(d.getDate() + (dow === 0 ? -6 : 1 - dow));
    const sun = new Date(mon);
    sun.setDate(mon.getDate() + 6);
    return { monStr: toMYTDateStr(mon), sunStr: toMYTDateStr(sun) };
  };

  const newByWeek = {};
  for (const d of dates) {
    const { monStr } = getWeekBounds(d);
    newByWeek[monStr] = (newByWeek[monStr] || 0) + 1;
  }

  try {
    for (const [monStr, newCount] of Object.entries(newByWeek)) {
      const { sunStr } = getWeekBounds(monStr);
      const weekCheck = await db.execute({
        sql:  `SELECT COUNT(*) AS cnt FROM wfh_requests WHERE user_id = ? AND date >= ? AND date <= ? AND status NOT IN ('rejected','cancelled')`,
        args: [req.user.id, monStr, sunStr]
      });
      const existing = Number(weekCheck.rows[0].cnt);
      if (existing + newCount > 2) {
        return res.status(400).json({ error: `Week of ${monStr}: would exceed 2 WFH days (${existing} already scheduled, adding ${newCount})` });
      }
    }

    // Duplicate check for each date
    for (const d of dates) {
      const dupCheck = await db.execute({
        sql:  `SELECT id FROM wfh_requests WHERE user_id = ? AND date = ? AND status NOT IN ('rejected','cancelled')`,
        args: [req.user.id, d]
      });
      if (dupCheck.rows.length > 0) {
        return res.status(409).json({ error: `You already have a WFH request for ${d}` });
      }
    }

    const userRow = await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [req.user.id] });
    const user    = userRow.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.hod_id) {
      return res.status(400).json({ error: 'No approver configured for your account. Contact admin.' });
    }

    const now     = new Date().toISOString();
    const created = [];
    for (const d of dates) {
      const id     = uuidv4();
      const ref_no = await generateRefNo('WFH');
      await db.execute({
        sql:  `INSERT INTO wfh_requests (id, ref_no, user_id, date, reason, status, approver_id, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
        args: [id, ref_no, req.user.id, d, reason.trim(), user.hod_id, now]
      });
      created.push({ id, ref_no, date: d, reason: reason.trim(), status: 'pending' });
    }

    res.status(201).json(created);

    try {
      const approverRow = await db.execute({ sql: 'SELECT name, email FROM users WHERE id = ?', args: [user.hod_id] });
      const approver    = approverRow.rows[0];
      if (approver?.email) {
        await sendWFHApproverEmail(approver.email, approver.name, user.name, dates, reason.trim());
      }
    } catch (emailErr) { console.error('[Teamly] WFH approver email failed:', emailErr.message); }
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/wfh/:id/approve
app.put('/api/wfh/:id/approve', requireAuth, async (req, res) => {
  if (!['superadmin', 'hod', 'approver_a'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const row = await db.execute({ sql: 'SELECT * FROM wfh_requests WHERE id = ?', args: [req.params.id] });
    const wfh = row.rows[0];
    if (!wfh)                     return res.status(404).json({ error: 'WFH request not found' });
    if (wfh.status !== 'pending') return res.status(400).json({ error: 'Request is not pending' });
    if (req.user.role !== 'superadmin' && wfh.approver_id !== req.user.id) {
      return res.status(403).json({ error: 'You are not the assigned approver for this request' });
    }
    await db.execute({
      sql:  "UPDATE wfh_requests SET status = 'approved' WHERE id = ?",
      args: [req.params.id]
    });
    try {
      const empRow = await db.execute({ sql: 'SELECT name, email FROM users WHERE id = ?', args: [wfh.user_id] });
      const emp    = empRow.rows[0];
      if (emp?.email) await sendEmployeeStatusEmail(emp.email, emp.name, 'wfh', wfh.ref_no || wfh.id.slice(0,8).toUpperCase(), 'approved', null);
    } catch (emailErr) { console.error('[Teamly] WFH approval email failed:', emailErr.message); }
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/wfh/:id/reject
app.put('/api/wfh/:id/reject', requireAuth, async (req, res) => {
  if (!['superadmin', 'hod', 'approver_a'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { rejection_reason } = req.body;
  if (!rejection_reason?.trim()) {
    return res.status(400).json({ error: 'Rejection reason is required' });
  }
  try {
    const row = await db.execute({ sql: 'SELECT * FROM wfh_requests WHERE id = ?', args: [req.params.id] });
    const wfh = row.rows[0];
    if (!wfh)                     return res.status(404).json({ error: 'WFH request not found' });
    if (wfh.status !== 'pending') return res.status(400).json({ error: 'Request is not pending' });
    if (req.user.role !== 'superadmin' && wfh.approver_id !== req.user.id) {
      return res.status(403).json({ error: 'You are not the assigned approver for this request' });
    }
    await db.execute({
      sql:  "UPDATE wfh_requests SET status = 'rejected', rejection_reason = ? WHERE id = ?",
      args: [rejection_reason.trim(), req.params.id]
    });
    try {
      const empRow = await db.execute({ sql: 'SELECT name, email FROM users WHERE id = ?', args: [wfh.user_id] });
      const emp    = empRow.rows[0];
      if (emp?.email) await sendEmployeeStatusEmail(emp.email, emp.name, 'wfh', wfh.ref_no || wfh.id.slice(0,8).toUpperCase(), 'rejected', rejection_reason.trim());
    } catch (emailErr) { console.error('[Teamly] WFH rejection email failed:', emailErr.message); }
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/wfh/:id/cancel
app.put('/api/wfh/:id/cancel', requireAuth, async (req, res) => {
  try {
    const row = await db.execute({ sql: 'SELECT * FROM wfh_requests WHERE id = ?', args: [req.params.id] });
    const wfh = row.rows[0];
    if (!wfh)                        return res.status(404).json({ error: 'WFH request not found' });
    if (wfh.user_id !== req.user.id) return res.status(403).json({ error: 'You can only cancel your own requests' });
    if (wfh.status !== 'pending')    return res.status(400).json({ error: 'Only pending requests can be cancelled' });
    await db.execute({ sql: "UPDATE wfh_requests SET status = 'cancelled' WHERE id = ?", args: [req.params.id] });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/admin/wfh/:id/override — superadmin only
app.put('/api/admin/wfh/:id/override', requireAuth, requireRole('superadmin', 'hod', 'approver_a'), async (req, res) => {
  const { status, reason } = req.body;
  if (!['approved', 'rejected', 'cancelled'].includes(status)) {
    return res.status(400).json({ error: 'Status must be approved, rejected, or cancelled' });
  }
  try {
    const row = await db.execute({ sql: 'SELECT * FROM wfh_requests WHERE id = ?', args: [req.params.id] });
    if (!row.rows[0]) return res.status(404).json({ error: 'WFH request not found' });
    const note = `[Admin Override] ${reason?.trim() || 'No reason provided'}`;
    await db.execute({
      sql:  'UPDATE wfh_requests SET status = ?, rejection_reason = ? WHERE id = ?',
      args: [status, note, req.params.id]
    });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── CLAIMS ROUTES──────────────────────────────────────────────────

// GET /api/claim-categories — all authenticated users need this for the submit form
app.get('/api/claim-categories', requireAuth, async (req, res) => {
  try {
    const result = await db.execute('SELECT id, name FROM claim_categories ORDER BY name ASC');
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/claim-categories — superadmin only
app.post('/api/claim-categories', requireAuth, requireRole('superadmin', 'hod', 'approver_a'), async (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  try {
    const id  = uuidv4();
    const now = new Date().toISOString();
    await db.execute({
      sql:  'INSERT INTO claim_categories (id, name, created_at) VALUES (?, ?, ?)',
      args: [id, name.trim(), now]
    });
    res.status(201).json({ id, name: name.trim() });
  } catch (e) {
    if (e.message?.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Category already exists' });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/claim-categories/:id — superadmin only
app.delete('/api/claim-categories/:id', requireAuth, requireRole('superadmin', 'hod', 'approver_a'), async (req, res) => {
  try {
    const inUse = await db.execute({
      sql:  'SELECT COUNT(*) AS cnt FROM claims WHERE category_id = ?',
      args: [req.params.id]
    });
    if (Number(inUse.rows[0].cnt) > 0) {
      return res.status(409).json({ error: 'Cannot delete category — it is used by existing claims' });
    }
    await db.execute({ sql: 'DELETE FROM claim_categories WHERE id = ?', args: [req.params.id] });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/claims
app.get('/api/claims', requireAuth, async (req, res) => {
  try {
    let sql, args;
    if (req.user.role === 'superadmin') {
      sql  = `SELECT c.*, u.name AS employee_name, u.department,
                     a.name AS approver_name, cc.name AS category_name
              FROM claims c
              LEFT JOIN users u          ON c.user_id     = u.id
              LEFT JOIN users a          ON c.approver_id = a.id
              LEFT JOIN claim_categories cc ON c.category_id = cc.id
              ORDER BY c.created_at DESC`;
      args = [];
    } else if (['hod', 'approver_a'].includes(req.user.role)) {
      sql  = `SELECT c.*, u.name AS employee_name, u.department,
                     a.name AS approver_name, cc.name AS category_name
              FROM claims c
              LEFT JOIN users u          ON c.user_id     = u.id
              LEFT JOIN users a          ON c.approver_id = a.id
              LEFT JOIN claim_categories cc ON c.category_id = cc.id
              WHERE c.user_id = ? OR c.approver_id = ?
              ORDER BY c.created_at DESC`;
      args = [req.user.id, req.user.id];
    } else {
      sql  = `SELECT c.*, u.name AS employee_name, u.department,
                     a.name AS approver_name, cc.name AS category_name
              FROM claims c
              LEFT JOIN users u          ON c.user_id     = u.id
              LEFT JOIN users a          ON c.approver_id = a.id
              LEFT JOIN claim_categories cc ON c.category_id = cc.id
              WHERE c.user_id = ?
              ORDER BY c.created_at DESC`;
      args = [req.user.id];
    }
    const result = await db.execute({ sql, args });
    // Strip receipt base64 from list view to keep payload small
    const rows = result.rows.map(r => ({ ...r, receipt: r.receipt ? '[attached]' : null }));
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/claims/:id — full detail including receipt base64
app.get('/api/claims/:id', requireAuth, async (req, res) => {
  try {
    const result = await db.execute({
      sql:  `SELECT c.*, u.name AS employee_name, u.department,
                    a.name AS approver_name, cc.name AS category_name
             FROM claims c
             LEFT JOIN users u          ON c.user_id     = u.id
             LEFT JOIN users a          ON c.approver_id = a.id
             LEFT JOIN claim_categories cc ON c.category_id = cc.id
             WHERE c.id = ?`,
      args: [req.params.id]
    });
    const claim = result.rows[0];
    if (!claim) return res.status(404).json({ error: 'Claim not found' });
    // Only the owner, their approver, or admin roles can view full detail
    if (!['superadmin', 'hod', 'approver_a'].includes(req.user.role) &&
        claim.user_id !== req.user.id &&
        claim.approver_id !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    res.json(claim);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/claims
app.post('/api/claims', requireAuth, async (req, res) => {
  const { department, item, details, amount, category_id, receipt } = req.body;

  if (!department?.trim()) return res.status(400).json({ error: 'department is required' });
  if (!item?.trim())       return res.status(400).json({ error: 'item is required' });
  if (!category_id)        return res.status(400).json({ error: 'category_id is required' });
  if (!receipt?.trim())    return res.status(400).json({ error: 'receipt (base64) is required' });
  if (amount == null || isNaN(Number(amount)) || Number(amount) <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number' });
  }

  try {
    // Validate category exists
    const catRow = await db.execute({ sql: 'SELECT id FROM claim_categories WHERE id = ?', args: [category_id] });
    if (!catRow.rows[0]) return res.status(400).json({ error: 'Invalid category_id' });

    // Routing: use claim_approver_id (falls back to al_approver_id for backward compat)
    const userRow = await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [req.user.id] });
    const user    = userRow.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    const claimApproverId = user.claim_approver_id || user.al_approver_id;
    if (!claimApproverId) {
      return res.status(400).json({ error: 'No claims approver configured for your account. Contact admin.' });
    }

    const id     = uuidv4();
    const now    = new Date().toISOString();
    const ref_no = await generateRefNo('CLM');
    await db.execute({
      sql:  `INSERT INTO claims
             (id, ref_no, user_id, department, item, details, amount, category_id, receipt, status, approver_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      args: [id, ref_no, req.user.id, department.trim(), item.trim(), details?.trim() || null,
             Number(amount), category_id, receipt.trim(), claimApproverId, now]
    });

    res.status(201).json({ id, ref_no, item: item.trim(), amount: Number(amount), status: 'pending' });

    // Send notification email (no approve/reject buttons — admin manages in console)
    try {
      const approverRow = await db.execute({ sql: 'SELECT name, email FROM users WHERE id = ?', args: [claimApproverId] });
      const approver    = approverRow.rows[0];
      if (approver?.email) {
        const detailsHtml = `
          <p style="margin:0 0 8px;"><strong>Employee:</strong> ${user.name}${user.department ? ' (' + user.department + ')' : ''}</p>
          <p style="margin:0 0 8px;"><strong>Item:</strong> ${item.trim()}</p>
          <p style="margin:0 0 8px;"><strong>Amount:</strong> RM ${Number(amount).toFixed(2)}</p>
          <p style="margin:0 0 8px;"><strong>Department:</strong> ${department.trim()}</p>
          ${details?.trim() ? `<p style="margin:0;"><strong>Details:</strong> ${details.trim()}</p>` : ''}`;
        await sendClaimNotificationEmail(ref_no, approver.email, user.name, detailsHtml, receipt.trim());
      }
    } catch (emailErr) {
      console.error('[Teamly] Claim notification email failed:', emailErr.message);
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/claims/:id/approve — superadmin only, marks as payment_pending
app.put('/api/claims/:id/approve', requireAuth, requireRole('superadmin', 'hod', 'approver_a'), async (req, res) => {
  try {
    const row   = await db.execute({ sql: 'SELECT * FROM claims WHERE id = ?', args: [req.params.id] });
    const claim = row.rows[0];
    if (!claim)                     return res.status(404).json({ error: 'Claim not found' });
    if (claim.status !== 'pending') return res.status(400).json({ error: 'Request is not pending' });
    await db.execute({
      sql:  "UPDATE claims SET status = 'payment_pending' WHERE id = ?",
      args: [req.params.id]
    });
    try {
      const empRow = await db.execute({ sql: 'SELECT name, email FROM users WHERE id = ?', args: [claim.user_id] });
      const emp    = empRow.rows[0];
      if (emp?.email) await sendEmployeeStatusEmail(emp.email, emp.name, 'claim', claim.ref_no || claim.id.slice(0,8).toUpperCase(), 'payment_pending', null);
    } catch (emailErr) { console.error('[Teamly] Claim approval email failed:', emailErr.message); }
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/claims/:id/mark-paid — superadmin only
app.put('/api/claims/:id/mark-paid', requireAuth, requireRole('superadmin', 'hod', 'approver_a'), async (req, res) => {
  try {
    const row   = await db.execute({ sql: 'SELECT * FROM claims WHERE id = ?', args: [req.params.id] });
    const claim = row.rows[0];
    if (!claim) return res.status(404).json({ error: 'Claim not found' });
    if (!['pending', 'payment_pending'].includes(claim.status)) {
      return res.status(400).json({ error: 'Claim is already paid or rejected' });
    }
    await db.execute({
      sql:  "UPDATE claims SET status = 'paid' WHERE id = ?",
      args: [req.params.id]
    });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/claims/:id/reject — superadmin only
app.put('/api/claims/:id/reject', requireAuth, requireRole('superadmin', 'hod', 'approver_a'), async (req, res) => {
  const { rejection_reason } = req.body;
  if (!rejection_reason?.trim()) {
    return res.status(400).json({ error: 'Rejection reason is required' });
  }
  try {
    const row   = await db.execute({ sql: 'SELECT * FROM claims WHERE id = ?', args: [req.params.id] });
    const claim = row.rows[0];
    if (!claim) return res.status(404).json({ error: 'Claim not found' });
    if (['paid', 'rejected'].includes(claim.status)) {
      return res.status(400).json({ error: 'Claim cannot be rejected in its current state' });
    }
    await db.execute({
      sql:  "UPDATE claims SET status = 'rejected', rejection_reason = ? WHERE id = ?",
      args: [rejection_reason.trim(), req.params.id]
    });
    try {
      const empRow = await db.execute({ sql: 'SELECT name, email FROM users WHERE id = ?', args: [claim.user_id] });
      const emp    = empRow.rows[0];
      if (emp?.email) await sendEmployeeStatusEmail(emp.email, emp.name, 'claim', claim.ref_no || claim.id.slice(0,8).toUpperCase(), 'rejected', rejection_reason.trim());
    } catch (emailErr) { console.error('[Teamly] Claim rejection email failed:', emailErr.message); }
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/claims/:id/cancel
app.put('/api/claims/:id/cancel', requireAuth, async (req, res) => {
  try {
    const row   = await db.execute({ sql: 'SELECT * FROM claims WHERE id = ?', args: [req.params.id] });
    const claim = row.rows[0];
    if (!claim)                        return res.status(404).json({ error: 'Claim not found' });
    if (claim.user_id !== req.user.id) return res.status(403).json({ error: 'You can only cancel your own requests' });
    if (claim.status !== 'pending')    return res.status(400).json({ error: 'Only pending requests can be cancelled' });
    await db.execute({ sql: "UPDATE claims SET status = 'cancelled' WHERE id = ?", args: [req.params.id] });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/admin/claims/:id/override — superadmin only
app.put('/api/admin/claims/:id/override', requireAuth, requireRole('superadmin', 'hod', 'approver_a'), async (req, res) => {
  const { status, reason } = req.body;
  if (!['approved', 'rejected', 'cancelled', 'pending', 'payment_pending', 'paid'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  try {
    const row = await db.execute({ sql: 'SELECT * FROM claims WHERE id = ?', args: [req.params.id] });
    if (!row.rows[0]) return res.status(404).json({ error: 'Claim not found' });
    const note = `[Admin Override] ${reason?.trim() || 'No reason provided'}`;
    await db.execute({
      sql:  'UPDATE claims SET status = ?, rejection_reason = ? WHERE id = ?',
      args: [status, note, req.params.id]
    });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── EMAIL APPROVAL TOKEN HANDLER───────────────────────────────────

// GET /api/token/:tokenId — approve directly or show reject form
app.get('/api/token/:tokenId', async (req, res) => {
  try {
    const row   = await db.execute({ sql: 'SELECT * FROM approval_tokens WHERE id = ?', args: [req.params.tokenId] });
    const token = row.rows[0];
    if (!token)    return res.send(tokenPageHtml('Invalid Link', 'This approval link is invalid or does not exist.', false));
    if (token.used) return res.send(tokenPageHtml('Already Used', 'This link has already been used.', false));
    if (new Date(token.expires_at) < new Date()) return res.send(tokenPageHtml('Link Expired', 'This link has expired. Please action from the Teamly portal.', false));

    if (token.action === 'approve') {
      await processTokenAction(token, null);
      await db.execute({ sql: 'UPDATE approval_tokens SET used = 1 WHERE id = ?', args: [token.id] });
      return res.send(tokenPageHtml('Approved ✓', 'The request has been approved successfully.', true, true));
    } else {
      return res.send(rejectFormHtml(req.params.tokenId));
    }
  } catch (e) {
    console.error('[Teamly] Token handler error:', e);
    const msg = e.message?.includes('no longer pending') ? e.message : 'Something went wrong. Please action from the Teamly portal.';
    res.send(tokenPageHtml('Error', msg, false));
  }
});

// POST /api/token/:tokenId — handle reject form submission
app.post('/api/token/:tokenId', express.urlencoded({ extended: false }), async (req, res) => {
  const { reason } = req.body;
  if (!reason?.trim()) return res.send(rejectFormHtml(req.params.tokenId, 'Rejection reason is required.'));
  try {
    const row   = await db.execute({ sql: 'SELECT * FROM approval_tokens WHERE id = ?', args: [req.params.tokenId] });
    const token = row.rows[0];
    if (!token)     return res.send(tokenPageHtml('Invalid Link', 'This approval link is invalid.', false));
    if (token.used) return res.send(tokenPageHtml('Already Used', 'This link has already been used.', false));
    if (new Date(token.expires_at) < new Date()) return res.send(tokenPageHtml('Link Expired', 'This link has expired.', false));

    await processTokenAction(token, reason.trim());
    await db.execute({ sql: 'UPDATE approval_tokens SET used = 1 WHERE id = ?', args: [token.id] });
    return res.send(tokenPageHtml('Rejected', 'The request has been rejected.', true, true));
  } catch (e) {
    console.error('[Teamly] Token reject error:', e);
    const msg = e.message?.includes('no longer pending') ? e.message : 'Something went wrong. Please action from the Teamly portal.';
    res.send(tokenPageHtml('Error', msg, false));
  }
});

// ─── ADMIN ROUTES──────────────────────────────────────────────────

// POST /api/admin/test-email  — sends a test email to the given address, superadmin only
app.post('/api/admin/test-email', requireAuth, requireRole('superadmin', 'hod', 'approver_a'), async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: 'to is required' });
  try {
    await resend.emails.send({
      from:    EMAIL_FROM,
      to,
      subject: '[Teamly] Test email',
      html:    '<p>If you received this, Teamly email is working correctly.</p>'
    });
    res.json({ success: true, message: `Test email sent to ${to}` });
  } catch (e) {
    console.error('[Teamly] Test email failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/admin/balances
// Body: { user_id, year, bucket_a, bucket_b, used_a?, used_b? }
// Upserts the AL balance record for any employee. Superadmin only.
app.put('/api/admin/balances', requireAuth, requireRole('superadmin', 'hod', 'approver_a'), async (req, res) => {
  const { user_id, year, bucket_a = 0, bucket_b, used_a, used_b } = req.body;
  if (!user_id || !year || bucket_b === undefined) {
    return res.status(400).json({ error: 'user_id, year, and bucket_b are required' });
  }
  try {
    const existing = await db.execute({
      sql:  'SELECT id FROM leave_balances WHERE user_id = ? AND year = ?',
      args: [user_id, year]
    });
    if (existing.rows.length > 0) {
      // Build SET clause dynamically based on what was provided
      const sets = ['bucket_a = ?', 'bucket_b = ?'];
      const args = [bucket_a, bucket_b];
      if (used_a !== undefined) { sets.push('used_a = ?'); args.push(used_a); }
      if (used_b !== undefined) { sets.push('used_b = ?'); args.push(used_b); }
      args.push(user_id, year);
      await db.execute({ sql: `UPDATE leave_balances SET ${sets.join(', ')} WHERE user_id = ? AND year = ?`, args });
    } else {
      await db.execute({
        sql:  'INSERT INTO leave_balances (id, user_id, year, bucket_a, bucket_b, used_a, used_b) VALUES (?, ?, ?, ?, ?, ?, ?)',
        args: [uuidv4(), user_id, year, bucket_a, bucket_b, used_a ?? 0, used_b ?? 0]
      });
    }
    const updated = await db.execute({
      sql:  'SELECT * FROM leave_balances WHERE user_id = ? AND year = ?',
      args: [user_id, year]
    });
    res.json(updated.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/admin/balances?year=YYYY — all AL balances for a given year
app.get('/api/admin/balances', requireAuth, requireRole('superadmin', 'hod', 'approver_a'), async (req, res) => {
  const year = req.query.year ? parseInt(req.query.year) : getMYTNow().year;
  try {
    const result = await db.execute({
      sql:  `SELECT u.id AS user_id, u.name AS employee_name, u.username, u.department,
                    lb.id, lb.bucket_a, lb.bucket_b, lb.used_a, lb.used_b
             FROM users u
             LEFT JOIN leave_balances lb ON lb.user_id = u.id AND lb.year = ?
             WHERE u.role != 'superadmin'
             ORDER BY u.name ASC`,
      args: [year]
    });
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/admin/balances/:id — remove an AL balance record (superadmin only)
app.delete('/api/admin/balances/:id', requireAuth, requireRole('superadmin', 'hod', 'approver_a'), async (req, res) => {
  try {
    const result = await db.execute({ sql: 'SELECT id FROM leave_balances WHERE id = ?', args: [req.params.id] });
    if (!result.rows[0]) return res.status(404).json({ error: 'Balance record not found' });
    await db.execute({ sql: 'DELETE FROM leave_balances WHERE id = ?', args: [req.params.id] });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/calendar?month=YYYY-MM — team calendar, all authenticated users
// Returns approved + pending leave and WFH for the whole team for a given month.
// Sensitive fields (reason, mc_attachment, rejection_reason) are excluded.
app.get('/api/calendar', requireAuth, async (req, res) => {
  const { month } = req.query; // YYYY-MM
  const from = month ? `${month}-01` : null;
  const to   = month ? `${month}-31` : null;
  try {
    let leaveWhere = `lr.status IN ('approved','pending')`;
    const leaveArgs = [];
    if (from && to) {
      leaveWhere += ` AND lr.end_date >= ? AND lr.start_date <= ?`;
      leaveArgs.push(from, to);
    }
    const leaveRows = await db.execute({
      sql: `SELECT lr.id, lr.type, lr.start_date AS date_from, lr.end_date AS date_to,
                   lr.half_day, lr.days_count, lr.status,
                   u.name AS employee_name, u.department
            FROM leave_requests lr
            LEFT JOIN users u ON lr.user_id = u.id
            WHERE ${leaveWhere}
            ORDER BY lr.start_date ASC`,
      args: leaveArgs
    });

    let wfhWhere = `w.status IN ('approved','pending')`;
    const wfhArgs = [];
    if (from && to) {
      wfhWhere += ` AND w.date >= ? AND w.date <= ?`;
      wfhArgs.push(from, to);
    }
    const wfhRows = await db.execute({
      sql: `SELECT w.id, 'wfh' AS type, w.date AS date_from, w.date AS date_to,
                   NULL AS half_day, 1 AS days_count, w.status,
                   u.name AS employee_name, u.department
            FROM wfh_requests w
            LEFT JOIN users u ON w.user_id = u.id
            WHERE ${wfhWhere}
            ORDER BY w.date ASC`,
      args: wfhArgs
    });

    let holidayArgs = [];
    let holidayWhere = '1=1';
    if (from && to) {
      holidayWhere = 'date >= ? AND date <= ?';
      holidayArgs.push(from, to);
    }
    const holidayRows = await db.execute({
      sql: `SELECT id, 'holiday' AS type, date AS date_from, date AS date_to,
                   NULL AS half_day, NULL AS days_count, 'holiday' AS status,
                   name AS employee_name, NULL AS department
            FROM public_holidays
            WHERE ${holidayWhere}
            ORDER BY date ASC`,
      args: holidayArgs
    });

    res.json([...leaveRows.rows, ...wfhRows.rows, ...holidayRows.rows]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/admin/tracking — unified request log, superadmin only
// Query params: ?employee=<name>&type=<AL|sick|emergency|comp_off|UPL|wfh|claim>&status=<...>&from=YYYY-MM-DD&to=YYYY-MM-DD
app.get('/api/admin/tracking', requireAuth, requireRole('superadmin', 'hod', 'approver_a'), async (req, res) => {
  const { employee, type, status, from, to } = req.query;
  try {
    // Leave requests
    const leaveRows = await db.execute(`
      SELECT lr.id, lr.ref_no, lr.type, lr.start_date AS date_from, lr.end_date AS date_to,
             lr.half_day, lr.days_count, lr.reason, lr.status, lr.rejection_reason,
             lr.approver_id, lr.created_at,
             u.name AS employee_name, u.department,
             a.name AS approver_name
      FROM leave_requests lr
      LEFT JOIN users u ON lr.user_id     = u.id
      LEFT JOIN users a ON lr.approver_id = a.id
      ORDER BY lr.created_at DESC`);

    // WFH requests
    const wfhRows = await db.execute(`
      SELECT w.id, w.ref_no, 'wfh' AS type, w.date AS date_from, w.date AS date_to,
             NULL AS half_day, 1 AS days_count, w.reason, w.status, w.rejection_reason,
             w.approver_id, w.created_at,
             u.name AS employee_name, u.department,
             a.name AS approver_name
      FROM wfh_requests w
      LEFT JOIN users u ON w.user_id     = u.id
      LEFT JOIN users a ON w.approver_id = a.id
      ORDER BY w.created_at DESC`);

    // Claims
    const claimRows = await db.execute(`
      SELECT c.id, c.ref_no, 'claim' AS type, c.created_at AS date_from, c.created_at AS date_to,
             NULL AS half_day, NULL AS days_count, c.item AS reason, c.status, c.rejection_reason,
             c.approver_id, c.created_at,
             u.name AS employee_name, u.department,
             a.name AS approver_name,
             c.amount, c.category_id
      FROM claims c
      LEFT JOIN users u ON c.user_id     = u.id
      LEFT JOIN users a ON c.approver_id = a.id
      ORDER BY c.created_at DESC`);

    let rows = [
      ...leaveRows.rows.map(r => ({ ...r, request_category: 'leave' })),
      ...wfhRows.rows.map(r => ({ ...r, request_category: 'wfh' })),
      ...claimRows.rows.map(r => ({ ...r, request_category: 'claim' }))
    ];

    // Sort all merged rows by created_at desc
    rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    // Apply filters
    if (employee) {
      const q = employee.toLowerCase();
      rows = rows.filter(r => r.employee_name?.toLowerCase().includes(q));
    }
    if (type) {
      rows = rows.filter(r => r.type === type);
    }
    if (status) {
      rows = rows.filter(r => r.status === status);
    }
    if (from) {
      rows = rows.filter(r => r.date_from >= from);
    }
    if (to) {
      rows = rows.filter(r => r.date_from <= to);
    }

    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/admin/export/:table — CSV download, superadmin only
// Strips large blob columns (mc_attachment, receipt) automatically.
const EXPORTABLE_TABLES = {
  users:          'SELECT id, name, username, email, role, department, hod_id, al_approver_id, claim_approver_id, created_at FROM users ORDER BY name ASC',
  leave_requests: 'SELECT id, ref_no, user_id, type, start_date, end_date, half_day, days_count, reason, status, approver_id, rejection_reason, reminder_sent, created_at FROM leave_requests ORDER BY created_at DESC',
  wfh_requests:   'SELECT id, ref_no, user_id, date, reason, status, approver_id, rejection_reason, created_at FROM wfh_requests ORDER BY created_at DESC',
  claims:         'SELECT id, ref_no, user_id, department, item, details, amount, category_id, status, approver_id, rejection_reason, created_at FROM claims ORDER BY created_at DESC',
  leave_balances: 'SELECT id, user_id, year, bucket_a, bucket_b, used_a, used_b FROM leave_balances ORDER BY year DESC',
  clock_records:  'SELECT id, employee_id, employee_name, action, timestamp, latitude, longitude, note FROM clock_records ORDER BY timestamp DESC',
};

app.get('/api/admin/export/:table', requireAuth, requireRole('superadmin', 'hod', 'approver_a'), async (req, res) => {
  const tableKey = req.params.table;
  const sql      = EXPORTABLE_TABLES[tableKey];
  if (!sql) {
    return res.status(400).json({ error: `Unknown table. Available: ${Object.keys(EXPORTABLE_TABLES).join(', ')}` });
  }
  try {
    const result = await db.execute(sql);
    const rows   = result.rows;

    const cols    = rows.length > 0 ? Object.keys(rows[0]) : [];
    const csvRows = [cols.join(',')];
    for (const row of rows) {
      const vals = cols.map(c => {
        const v = row[c];
        if (v == null) return '';
        const s = String(v);
        return (s.includes(',') || s.includes('"') || s.includes('\n'))
          ? '"' + s.replace(/"/g, '""') + '"'
          : s;
      });
      csvRows.push(vals.join(','));
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${tableKey}.csv"`);
    res.send(csvRows.join('\r\n'));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/admin/blackout — add a blackout date or range
// Body: { start_date, end_date?, reason? }  (end_date defaults to start_date for single day)
app.post('/api/admin/blackout', requireAuth, requireRole('superadmin', 'hod', 'approver_a'), async (req, res) => {
  const { start_date, end_date, reason } = req.body;
  if (!start_date) return res.status(400).json({ error: 'start_date is required (YYYY-MM-DD)' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start_date)) {
    return res.status(400).json({ error: 'start_date must be in YYYY-MM-DD format' });
  }
  const endStr = end_date || start_date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endStr)) {
    return res.status(400).json({ error: 'end_date must be in YYYY-MM-DD format' });
  }
  if (endStr < start_date) {
    return res.status(400).json({ error: 'end_date cannot be before start_date' });
  }
  try {
    const now     = new Date().toISOString();
    const inserted = [];
    const skipped  = [];
    // Expand range into individual dates
    const cur = new Date(start_date + 'T00:00:00');
    const end = new Date(endStr     + 'T00:00:00');
    while (cur <= end) {
      const dateStr = `${cur.getFullYear()}-${String(cur.getMonth()+1).padStart(2,'0')}-${String(cur.getDate()).padStart(2,'0')}`;
      try {
        const id = uuidv4();
        await db.execute({
          sql:  'INSERT INTO blackout_dates (id, date, reason, created_at) VALUES (?, ?, ?, ?)',
          args: [id, dateStr, reason?.trim() || null, now]
        });
        inserted.push(dateStr);
      } catch (inner) {
        if (inner.message?.includes('UNIQUE')) skipped.push(dateStr);
        else throw inner;
      }
      cur.setDate(cur.getDate() + 1);
    }
    res.status(201).json({ inserted, skipped });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/admin/blackout/:id — remove a blackout date
app.delete('/api/admin/blackout/:id', requireAuth, requireRole('superadmin', 'hod', 'approver_a'), async (req, res) => {
  try {
    const result = await db.execute({ sql: 'SELECT id FROM blackout_dates WHERE id = ?', args: [req.params.id] });
    if (!result.rows[0]) return res.status(404).json({ error: 'Blackout date not found' });
    await db.execute({ sql: 'DELETE FROM blackout_dates WHERE id = ?', args: [req.params.id] });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/admin/holidays — add a public holiday (or range)
app.post('/api/admin/holidays', requireAuth, requireRole('superadmin', 'hod', 'approver_a'), async (req, res) => {
  const { start_date, end_date, name, region } = req.body;
  if (!start_date || !name?.trim()) {
    return res.status(400).json({ error: 'start_date and name are required' });
  }
  const holidayRegion = ['MY', 'UK'].includes(region) ? region : 'MY';
  const now = new Date().toISOString();
  const inserted = [];
  const skipped  = [];
  const cur = new Date(start_date + 'T00:00:00');
  const last = new Date((end_date || start_date) + 'T00:00:00');
  while (cur <= last) {
    const dateStr = `${cur.getFullYear()}-${String(cur.getMonth()+1).padStart(2,'0')}-${String(cur.getDate()).padStart(2,'0')}`;
    const id = uuidv4();
    try {
      await db.execute({
        sql:  'INSERT INTO public_holidays (id, date, name, region, created_at) VALUES (?, ?, ?, ?, ?)',
        args: [id, dateStr, name.trim(), holidayRegion, now]
      });
      inserted.push(dateStr);
    } catch (inner) {
      if (inner.message?.includes('UNIQUE')) skipped.push(dateStr);
      else throw inner;
    }
    cur.setDate(cur.getDate() + 1);
  }
  res.json({ inserted, skipped });
});

// DELETE /api/admin/holidays — remove ALL public holidays
app.delete('/api/admin/holidays', requireAuth, requireRole('superadmin', 'hod', 'approver_a'), async (req, res) => {
  try {
    await db.execute('DELETE FROM public_holidays');
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/admin/holidays/:id — remove a public holiday
app.delete('/api/admin/holidays/:id', requireAuth, requireRole('superadmin', 'hod', 'approver_a'), async (req, res) => {
  try {
    const result = await db.execute({ sql: 'SELECT id FROM public_holidays WHERE id = ?', args: [req.params.id] });
    if (!result.rows[0]) return res.status(404).json({ error: 'Holiday not found' });
    await db.execute({ sql: 'DELETE FROM public_holidays WHERE id = ?', args: [req.params.id] });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/admin/reset — wipe all operational data (year-end archive workflow)
// Body must include { confirm: 'RESET' } to proceed.
// Clears: leave_requests, wfh_requests, claims, approval_tokens, clock_records, leave_balances
// Resets all counters to 0.
app.post('/api/admin/reset', requireAuth, requireRole('superadmin'), async (req, res) => {
  if (req.body.confirm !== 'RESET') {
    return res.status(400).json({ error: 'Body must include { confirm: "RESET" } to proceed' });
  }
  try {
    await db.execute('DELETE FROM leave_requests');
    await db.execute('DELETE FROM wfh_requests');
    await db.execute('DELETE FROM claims');
    await db.execute('DELETE FROM approval_tokens');
    await db.execute('DELETE FROM clock_records');
    await db.execute('DELETE FROM leave_balances');
    await db.execute('UPDATE counters SET last_val = 0');
    console.log('[Teamly] Full DB reset executed by superadmin');
    res.json({ success: true, message: 'All operational data cleared. Counters reset to 0.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/admin/settings — superadmin only
app.get('/api/admin/settings', requireAuth, requireRole('superadmin', 'hod', 'approver_a'), async (req, res) => {
  try {
    const result = await db.execute('SELECT key, value FROM settings ORDER BY key ASC');
    const obj = {};
    result.rows.forEach(r => { obj[r.key] = r.value; });
    res.json(obj);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/admin/settings — body: { clock_start_time: "09:00", clock_grace_minutes: "15" }
app.put('/api/admin/settings', requireAuth, requireRole('superadmin', 'hod', 'approver_a'), async (req, res) => {
  const updates = req.body;
  if (!updates || typeof updates !== 'object') {
    return res.status(400).json({ error: 'Body must be a key-value object' });
  }
  try {
    for (const [key, value] of Object.entries(updates)) {
      await db.execute({
        sql:  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        args: [key, String(value)]
      });
    }
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── CLOCK IN/OUT ROUTES───────────────────────────────────────────

// POST /api/clock — clock IN or OUT
app.post('/api/clock', requireAuth, async (req, res) => {
  const { action, latitude, longitude, note } = req.body;
  if (!action || !['IN', 'OUT'].includes(action)) {
    return res.status(400).json({ error: 'action must be IN or OUT' });
  }
  try {
    // Duplicate punch prevention
    const lastResult = await db.execute({
      sql:  'SELECT action FROM clock_records WHERE employee_id = ? ORDER BY timestamp DESC LIMIT 1',
      args: [req.user.id]
    });
    const last = lastResult.rows[0];
    if (last && last.action === action) {
      return res.status(409).json({
        error: `Already clocked ${action}. Please clock ${action === 'IN' ? 'OUT' : 'IN'} first.`
      });
    }

    const id        = uuidv4();
    const timestamp = new Date().toISOString();
    await db.execute({
      sql:  'INSERT INTO clock_records (id, employee_id, employee_name, action, timestamp, latitude, longitude, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      args: [id, req.user.id, req.user.name, action, timestamp, latitude || null, longitude || null, note?.trim() || null]
    });
    const tz = await getUserTimezone(req.user.id);
    res.status(201).json({ success: true, record: { id, employee_name: req.user.name, action, timestamp, timestamp_display: fmtTimestamp(timestamp, tz) } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/clock/status — own current clock status
app.get('/api/clock/status', requireAuth, async (req, res) => {
  try {
    const result = await db.execute({
      sql:  'SELECT * FROM clock_records WHERE employee_id = ? ORDER BY timestamp DESC LIMIT 1',
      args: [req.user.id]
    });
    const last = result.rows[0];
    const tz   = await getUserTimezone(req.user.id);
    res.json({
      status: last?.action === 'IN' ? 'IN' : 'OUT',
      last:   last ? { action: last.action, timestamp: last.timestamp, timestamp_display: fmtTimestamp(last.timestamp, tz), note: last.note } : null
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/clock/records — own clock history (employees) or all (admin)
app.get('/api/clock/records', requireAuth, async (req, res) => {
  try {
    let rows;
    if (req.user.role === 'superadmin') {
      const result = await db.execute({
        sql:  'SELECT cr.*, u.timezone FROM clock_records cr LEFT JOIN users u ON u.id = cr.employee_id ORDER BY cr.timestamp DESC LIMIT 200',
        args: []
      });
      rows = result.rows.map(r => ({ ...r, timestamp_display: fmtTimestamp(r.timestamp, r.timezone) }));
    } else {
      const tz = await getUserTimezone(req.user.id);
      const result = await db.execute({
        sql:  'SELECT * FROM clock_records WHERE employee_id = ? ORDER BY timestamp DESC LIMIT 50',
        args: [req.user.id]
      });
      rows = result.rows.map(r => ({ ...r, timestamp_display: fmtTimestamp(r.timestamp, tz) }));
    }
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/clock/status/all — all users' current clock status (superadmin only)
app.get('/api/clock/status/all', requireAuth, requireRole('superadmin', 'hod', 'approver_a'), async (req, res) => {
  try {
    const usersResult = await db.execute({
      sql:  'SELECT id, name, department, timezone FROM users WHERE role != ? ORDER BY name ASC',
      args: ['superadmin']
    });
    const statusList = await Promise.all(
      usersResult.rows.map(async (u) => {
        const last = await db.execute({
          sql:  'SELECT action, timestamp FROM clock_records WHERE employee_id = ? ORDER BY timestamp DESC LIMIT 1',
          args: [u.id]
        });
        const lr = last.rows[0];
        const tz = u.timezone || 'UTC';
        return {
          id:                  u.id,
          name:                u.name,
          department:          u.department,
          status:              lr?.action === 'IN' ? 'IN' : 'OUT',
          last_timestamp:      lr?.timestamp || null,
          last_timestamp_display: fmtTimestamp(lr?.timestamp, tz)
        };
      })
    );
    res.json(statusList);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/records — admin: searchable clock records (?name=&date=YYYY-MM-DD)
app.get('/api/records', requireAuth, requireRole('superadmin', 'hod', 'approver_a'), async (req, res) => {
  const { name, date } = req.query;
  let sql  = 'SELECT cr.*, u.timezone FROM clock_records cr LEFT JOIN users u ON u.id = cr.employee_id WHERE 1=1';
  const args = [];
  if (name) { sql += ' AND cr.employee_name LIKE ?'; args.push(`%${name}%`); }
  if (date) { sql += ' AND cr.timestamp LIKE ?';     args.push(`${date}%`);  }
  sql += ' ORDER BY cr.timestamp DESC LIMIT 500';
  try {
    const result = await db.execute({ sql, args });
    res.json(result.rows.map(r => ({ ...r, timestamp_display: fmtTimestamp(r.timestamp, r.timezone) })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── CRON JOBS──────────────────────────────────────────────────────

// 8AM MYT daily — email HOD on FIRST day of an employee's approved AL
cron.schedule('0 8 * * *', async () => {
  const myt   = getMYTNow();
  const today = myt.dateStr;
  try {
    const result = await db.execute({
      sql:  `SELECT lr.*, u.name AS employee_name,
                    h.name AS hod_name, h.email AS hod_email
             FROM leave_requests lr
             LEFT JOIN users u ON lr.user_id = u.id
             LEFT JOIN users h ON u.hod_id   = h.id
             WHERE lr.type = 'AL' AND lr.status = 'approved'
               AND lr.start_date = ? AND lr.reminder_sent = 0`,
      args: [today]
    });
    for (const leave of result.rows) {
      if (!leave.hod_email) continue;
      await resend.emails.send({
        from:    EMAIL_FROM,
        to:      leave.hod_email,
        subject: `[Teamly] Reminder: ${leave.employee_name} is on Annual Leave today`,
        html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f7fafc;font-family:Arial,sans-serif;">
  <div style="max-width:600px;margin:32px auto;background:white;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.10);">
    <div style="background:#008181;padding:24px 32px;">
      <h1 style="color:white;margin:0;font-size:26px;letter-spacing:2px;">TEAMLY</h1>
    </div>
    <div style="padding:32px;">
      <h2 style="color:#1a202c;margin:0 0 16px;">AL Reminder</h2>
      <p style="color:#4a5568;margin:0 0 16px;">This is a reminder that <strong>${leave.employee_name}</strong> is on Annual Leave today.</p>
      <div style="background:#f7fafc;border-radius:8px;padding:16px;border-left:4px solid #008181;">
        <p style="margin:0 0 8px;"><strong>From:</strong> ${leave.start_date}</p>
        <p style="margin:0;"><strong>To:</strong> ${leave.end_date}</p>
      </div>
    </div>
  </div></body></html>`
      });
      await db.execute({ sql: 'UPDATE leave_requests SET reminder_sent = 1 WHERE id = ?', args: [leave.id] });
      console.log(`[Teamly] AL reminder sent to ${leave.hod_email} for ${leave.employee_name}`);
    }
    console.log(`[Teamly] 8AM cron done — ${result.rows.length} reminder(s) sent`);
  } catch (e) {
    console.error('[Teamly] 8AM cron error:', e);
  }
}, { timezone: 'UTC' });

// ─── 404 FALLBACK ─────────────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>404 — Teamly</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #008181; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { background: #fff; border-radius: 16px; padding: 44px 40px; text-align: center; max-width: 380px; box-shadow: 0 4px 24px rgba(0,0,0,0.10); }
    h1 { font-size: 4rem; color: #008181; font-weight: 900; }
    p  { color: #4a5568; margin: 12px 0 28px; }
    a  { display: inline-block; padding: 12px 28px; background: #008181; color: #fff; border-radius: 8px; text-decoration: none; font-weight: 600; }
    a:hover { opacity: 0.85; }
  </style>
</head>
<body>
  <div class="card">
    <h1>404</h1>
    <p>This page doesn't exist.</p>
    <a href="/">Back to login</a>
  </div>
</body>
</html>`);
});

// ─── DEMO SEED ──────────────────────────────────────────────────────────────
// Only runs when DEMO_MODE is on. Gives every seeded account a known password
// (so visitors can log straight in) and populates sample activity so each
// screen looks alive. Idempotent — sample records are inserted once per DB.

const DEMO_PASSWORD = 'demo1234';

async function seedDemoData() {
  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
  await db.execute({ sql: 'UPDATE users SET password_hash = ?, force_password_reset = 0', args: [hash] });

  const already = await db.execute('SELECT COUNT(*) AS c FROM leave_requests');
  if (Number(already.rows[0].c) > 0) {
    console.log('[Teamly] Demo: accounts unlocked; sample activity already present.');
    return;
  }

  const now  = new Date().toISOString();
  const dstr = (off) => { const d = new Date(); d.setDate(d.getDate() + off); return d.toISOString().slice(0, 10); };
  const ts   = (off, h, m) => { const d = new Date(); d.setDate(d.getDate() + off); d.setHours(h, m, 0, 0); return d.toISOString(); };
  const id   = { jordan: 'seed-jordan', chris: 'seed-chris', noor: 'seed-noor', lily: 'seed-lily', dana: 'seed-dana', alex: 'seed-alex', maya: 'seed-maya', sam: 'seed-sam' };

  // Leave — mix of approved (past) and pending (future)
  const leaves = [
    ['AL000101', id.jordan, 'AL',        dstr(-12), dstr(-10), 3, null,            'approved', id.maya],
    ['SL000101', id.chris,  'sick',      dstr(-6),  dstr(-6),  1, null,            'approved', id.alex],
    ['AL000102', id.noor,   'AL',        dstr(9),   dstr(11),  3, null,            'pending',  id.maya],
    ['EL000101', id.lily,   'emergency', dstr(-3),  dstr(-3),  1, 'Family matter', 'approved', id.sam],
    ['AL000103', id.dana,   'AL',        dstr(14),  dstr(15),  2, null,            'pending',  id.maya],
  ];
  for (const [ref, uid, type, sd, ed, dc, reason, status, appr] of leaves) {
    await db.execute({
      sql:  `INSERT INTO leave_requests (id, ref_no, user_id, type, start_date, end_date, days_count, reason, status, approver_id, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      args: [uuidv4(), ref, uid, type, sd, ed, dc, reason, status, appr, now]
    });
  }
  // Reflect the approved AL against Jordan's balance
  await db.execute({ sql: 'UPDATE leave_balances SET used_b = used_b + 3 WHERE user_id = ? AND year = ?', args: [id.jordan, new Date().getFullYear()] });

  // WFH
  const wfh = [
    ['WFH000101', id.jordan, dstr(5),  'Client documentation day', 'approved', id.alex],
    ['WFH000102', id.chris,  dstr(6),  'Focus work',               'pending',  id.alex],
    ['WFH000103', id.noor,   dstr(-2), 'Home office setup',        'approved', id.alex],
  ];
  for (const [ref, uid, date, reason, status, appr] of wfh) {
    await db.execute({
      sql:  `INSERT INTO wfh_requests (id, ref_no, user_id, date, reason, status, approver_id, created_at) VALUES (?,?,?,?,?,?,?,?)`,
      args: [uuidv4(), ref, uid, date, reason, status, appr, now]
    });
  }

  // Claims (tiny 1x1 PNG receipt)
  const receipt = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const cat = await db.execute('SELECT id FROM claim_categories LIMIT 1');
  const catId = cat.rows[0]?.id;
  if (catId) {
    const claims = [
      ['CLM000101', id.jordan, 'Engineering', 'Taxi to client site', 48.5,  'pending',         id.maya],
      ['CLM000102', id.dana,   'Operations',  'Team lunch',          120.0, 'paid',            id.maya],
      ['CLM000103', id.chris,  'Engineering', 'USB-C docking hub',   89.9,  'payment_pending', id.maya],
    ];
    for (const [ref, uid, dept, item, amt, status, appr] of claims) {
      await db.execute({
        sql:  `INSERT INTO claims (id, ref_no, user_id, department, item, amount, category_id, receipt, status, approver_id, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        args: [uuidv4(), ref, uid, dept, item, amt, catId, receipt, status, appr, now]
      });
    }
  }

  // Clock punches
  const punches = [
    [id.jordan, 'Jordan Lee', 'IN',  ts(-1, 9, 2)],
    [id.jordan, 'Jordan Lee', 'OUT', ts(-1, 18, 5)],
    [id.jordan, 'Jordan Lee', 'IN',  ts(0, 8, 58)],
    [id.maya,   'Maya Patel',  'IN',  ts(0, 9, 15)],
  ];
  for (const [eid, name, action, t] of punches) {
    await db.execute({ sql: `INSERT INTO clock_records (id, employee_id, employee_name, action, timestamp) VALUES (?,?,?,?,?)`, args: [uuidv4(), eid, name, action, t] });
  }

  // A public holiday so the calendar shows one
  await db.execute({ sql: `INSERT OR IGNORE INTO public_holidays (id, date, name, region, created_at) VALUES (?,?,?,?,?)`, args: [uuidv4(), dstr(20), 'Demo Public Holiday', 'MY', now] });

  console.log('[Teamly] Demo sample data seeded.');
}

// ─── AI ANALYTICS ─────────────────────────────────────────────────────────────

app.post('/api/ai/analytics', requireAuth, requireRole('superadmin', 'hod', 'approver_a'), async (req, res) => {
  const { span = 'month', modules = ['claims', 'leaves', 'wfh'] } = req.body;
  const role   = req.user.role;
  const userId = req.user.id;

  // Date range
  const now = new Date();
  let from, to;
  if (span === 'week') {
    const dow = now.getDay() === 0 ? 6 : now.getDay() - 1;
    from = new Date(now); from.setDate(now.getDate() - dow); from.setHours(0,0,0,0);
    to   = new Date(from); to.setDate(from.getDate() + 6);
  } else if (span === 'year') {
    from = new Date(now.getFullYear(), 0, 1);
    to   = new Date(now.getFullYear(), 11, 31);
  } else {
    from = new Date(now.getFullYear(), now.getMonth(), 1);
    to   = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  }
  const fromStr = from.toISOString().slice(0, 10);
  const toStr   = to.toISOString().slice(0, 10);

  // HOD department scope
  let hodDept = null;
  if (role === 'hod') {
    const r = await db.execute({ sql: 'SELECT department FROM users WHERE id = ?', args: [userId] });
    hodDept = r.rows[0]?.department || null;
  }

  const data = {};

  // Claims — superadmin sees all; approver_a sees their assigned claimants
  if (modules.includes('claims') && (role === 'superadmin' || role === 'approver_a')) {
    const scopeWhere = role === 'approver_a' ? 'AND u.claim_approver_id = ?' : '';
    const scopeArgs  = role === 'approver_a' ? [userId] : [];

    const byPerson = await db.execute({
      sql: `SELECT u.name, u.department,
                   SUM(c.amount) AS total_amount, COUNT(*) AS count
            FROM claims c JOIN users u ON c.user_id = u.id
            WHERE DATE(c.created_at) BETWEEN ? AND ?
              AND c.status NOT IN ('cancelled','rejected')
              ${scopeWhere}
            GROUP BY u.id ORDER BY total_amount DESC`,
      args: [fromStr, toStr, ...scopeArgs]
    });
    const byDept = await db.execute({
      sql: `SELECT u.department,
                   SUM(c.amount) AS total_amount, COUNT(*) AS count
            FROM claims c JOIN users u ON c.user_id = u.id
            WHERE DATE(c.created_at) BETWEEN ? AND ?
              AND c.status NOT IN ('cancelled','rejected')
              ${scopeWhere}
            GROUP BY u.department ORDER BY total_amount DESC`,
      args: [fromStr, toStr, ...scopeArgs]
    });
    data.claims = {
      by_person: byPerson.rows,
      by_dept:   byDept.rows,
      total:     byPerson.rows.reduce((s, x) => s + (x.total_amount || 0), 0)
    };
  }

  // Non-AL leaves — superadmin sees all; hod sees their dept
  if (modules.includes('leaves') && (role === 'superadmin' || role === 'hod')) {
    const scopeWhere = (role === 'hod' && hodDept) ? 'AND u.department = ?' : '';
    const scopeArgs  = (role === 'hod' && hodDept) ? [hodDept] : [];

    const raw = await db.execute({
      sql: `SELECT u.name, u.department, lr.type,
                   SUM(lr.days_count) AS total_days, COUNT(*) AS count
            FROM leave_requests lr JOIN users u ON lr.user_id = u.id
            WHERE lr.type IN ('sick','emergency','comp_off','UPL')
              AND lr.start_date BETWEEN ? AND ?
              AND lr.status = 'approved'
              ${scopeWhere}
            GROUP BY u.id, lr.type ORDER BY total_days DESC`,
      args: [fromStr, toStr, ...scopeArgs]
    });

    // Roll up per person
    const personMap = {};
    for (const row of raw.rows) {
      if (!personMap[row.name]) personMap[row.name] = { name: row.name, department: row.department, total_days: 0, breakdown: {} };
      personMap[row.name].total_days += row.total_days;
      personMap[row.name].breakdown[row.type] = (personMap[row.name].breakdown[row.type] || 0) + row.total_days;
    }
    data.leaves = {
      by_person: Object.values(personMap).sort((a, b) => b.total_days - a.total_days)
    };
  }

  // WFH — superadmin sees all; hod sees their dept
  if (modules.includes('wfh') && (role === 'superadmin' || role === 'hod')) {
    const scopeWhere = (role === 'hod' && hodDept) ? 'AND u.department = ?' : '';
    const scopeArgs  = (role === 'hod' && hodDept) ? [hodDept] : [];

    const r = await db.execute({
      sql: `SELECT u.name, u.department, COUNT(*) AS count
            FROM wfh_requests w JOIN users u ON w.user_id = u.id
            WHERE w.date BETWEEN ? AND ?
              AND w.status = 'approved'
              ${scopeWhere}
            GROUP BY u.id ORDER BY count DESC`,
      args: [fromStr, toStr, ...scopeArgs]
    });
    data.wfh = { by_person: r.rows };
  }

  // Build Groq context
  const spanLabel = { week: 'this week', month: 'this month', year: 'this year' }[span];
  let ctx = `You are an HR analytics assistant for a company. Analyse the workforce data below for ${spanLabel} (${fromStr} to ${toStr}). Provide concise, actionable management insights. Flag anomalies, patterns, and risks. Use bullet points. Be specific with names and numbers.\n\n`;

  if (data.claims) {
    ctx += `**Expense Claims** — Total: RM${data.claims.total.toFixed(2)}\n`;
    ctx += `By department:\n${data.claims.by_dept.map(d => `- ${d.department || 'Unknown'}: RM${(d.total_amount||0).toFixed(2)} (${d.count} claims)`).join('\n')}\n`;
    ctx += `By person:\n${data.claims.by_person.map(p => `- ${p.name} (${p.department || '?'}): RM${(p.total_amount||0).toFixed(2)} (${p.count} claims)`).join('\n')}\n\n`;
  }

  if (data.leaves) {
    ctx += `**Non-AL Leaves** (Sick / Emergency / Comp Off / UPL)\nBy person:\n`;
    ctx += data.leaves.by_person.map(p => {
      const bd = Object.entries(p.breakdown).map(([t, d]) => `${t}: ${d}d`).join(', ');
      return `- ${p.name} (${p.department || '?'}): ${p.total_days} days [${bd}]`;
    }).join('\n') + '\n\n';
  }

  if (data.wfh) {
    ctx += `**WFH Days**\nBy person:\n`;
    ctx += data.wfh.by_person.map(p => `- ${p.name} (${p.department || '?'}): ${p.count} WFH days`).join('\n') + '\n\n';
  }

  if (!ctx.includes('**')) {
    return res.json({ data, insight: null, error: 'No data modules available for your role.', period: { from: fromStr, to: toStr } });
  }

  // Groq call
  let insight = null, error = null;
  const groqKey = process.env.GROQ_API_KEY;
  if (groqKey) {
    try {
      const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: ctx }],
          temperature: 0.3,
          max_tokens: 800
        })
      });
      const gd = await groqRes.json();
      if (!groqRes.ok) throw new Error(gd.error?.message || 'Groq error');
      insight = gd.choices?.[0]?.message?.content || 'No insight returned.';
    } catch (e) {
      error = `AI unavailable: ${e.message}`;
    }
  } else {
    error = 'GROQ_API_KEY not configured.';
  }

  res.json({ data, insight, error, period: { from: fromStr, to: toStr } });
});

// ─── START ────────────────────────────────────────────────────────────────────

async function start() {
  await initDB();
  if (DEMO_MODE) await seedDemoData();
  app.listen(PORT, () => {
    console.log(`[Teamly] Running on port ${PORT}${DEMO_MODE ? ' (DEMO MODE — isolated local DB)' : ''}`);
    console.log(`[Teamly] ${APP_URL}`);
  });
}

start().catch(console.error);
