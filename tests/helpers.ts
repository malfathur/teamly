import { expect, type Page } from '@playwright/test';

// ── Credentials (match seed data in server.js initDB + webServer env) ──────────
export const ADMIN = { username: 'admin', password: 'Admin@123!' };
export const EMP_PASSWORD = 'TestPass123!';

// Seeded employees (all start with force_password_reset = 1).
//   alex  → hod (Engineering)        : approves sick/emergency/WFH for jordan/chris/noor
//   maya  → approver_a (Engineering) : approves AL/UPL + claims for everyone
//   jordan→ user (Engineering)
//   chris → user (Engineering)
//   noor  → user (Engineering)   ← reserved for the one-time first-password test
export const USERS = {
  hod: 'alex',
  approver: 'maya',
  employee: 'jordan',
  employee2: 'chris',
} as const;

// ── Storage-state file paths (written by auth.setup.ts) ────────────────────────
export const STATE_DIR = 'tests/.auth';
export const STATE = {
  admin: `${STATE_DIR}/admin.json`,
  hod: `${STATE_DIR}/hod.json`,
  approver: `${STATE_DIR}/approver.json`,
  employee: `${STATE_DIR}/employee.json`,
  employee2: `${STATE_DIR}/employee2.json`,
} as const;

// ── Tiny valid PNG used as an MC / receipt upload (1x1 transparent) ────────────
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
export const pngFixture = {
  name: 'fixture.png',
  mimeType: 'image/png',
  buffer: Buffer.from(PNG_BASE64, 'base64'),
};

// ── Date helpers (advance-notice rules: AL/UPL ≥5 days, WFH ≥24h) ──────────────
function toISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

/** First weekday (Mon–Fri) on or after today + minDaysAhead. */
export function futureWeekday(minDaysAhead: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + minDaysAhead);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return toISO(d);
}

/** A Monday at least `weeksAhead` weeks out — gives a clean Mon–Sun window. */
export function futureMonday(weeksAhead: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + weeksAhead * 7);
  while (d.getDay() !== 1) d.setDate(d.getDate() + 1);
  return toISO(d);
}

/** Adds n calendar days to a YYYY-MM-DD string. */
export function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return toISO(d);
}

// ── Login flows (drive the real login.html UI) ─────────────────────────────────

/** Log in a user who already has a password (e.g. the super admin). */
export async function loginExisting(page: Page, username: string, password: string) {
  await page.goto('/login.html');
  await page.locator('#usernameInput').fill(username);
  await page.locator('#btnContinue').click();
  await page.locator('#password').fill(password);
  await page.locator('#btnLogin').click();
}

/**
 * Log in a seeded employee for the first time: enter username → Continue →
 * server detects force_password_reset → set-password view appears automatically.
 * Leaves the page on whatever the role redirects to.
 */
export async function loginFirstTime(page: Page, username: string, password = EMP_PASSWORD) {
  await page.goto('/login.html');
  await page.locator('#usernameInput').fill(username);
  await page.locator('#btnContinue').click();

  await expect(page.locator('#view-setpass')).toBeVisible();
  await page.locator('#newPass').fill(password);
  await page.locator('#confirmPass').fill(password);
  await page.locator('#btnSetPass').click();
}

/** Switch the dashboard to a tab by its visible label. */
export async function dashboardTab(page: Page, label: string) {
  await page.locator('nav.tab-bar button.tab-btn', { hasText: label }).first().click();
}
