import { test as setup, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'fs';
import {
  ADMIN,
  USERS,
  STATE,
  STATE_DIR,
  loginExisting,
  loginFirstTime,
} from './helpers';

// Each user can only do the first-time password flow once, so these run serially
// and each authenticates a distinct seeded account exactly once.
setup.describe.configure({ mode: 'serial' });

async function expectToken(page: Page) {
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('teamly_token')))
    .not.toBeNull();
}

setup('authenticate superadmin', async ({ page }) => {
  mkdirSync(STATE_DIR, { recursive: true });
  await loginExisting(page, ADMIN.username, ADMIN.password);
  await page.waitForURL('**/admin.html');
  await expectToken(page);
  await page.context().storageState({ path: STATE.admin });
});

setup('authenticate hod (alex)', async ({ page }) => {
  await loginFirstTime(page, USERS.hod);
  // HOD lands on the console picker, not an auto-redirect.
  await expect(page.locator('#view-choose')).toBeVisible();
  await expectToken(page);
  await page.context().storageState({ path: STATE.hod });
});

setup('authenticate approver_a (maya)', async ({ page }) => {
  await loginFirstTime(page, USERS.approver);
  await expect(page.locator('#view-choose')).toBeVisible();
  await expectToken(page);
  await page.context().storageState({ path: STATE.approver });
});

setup('authenticate employee (jordan)', async ({ page }) => {
  await loginFirstTime(page, USERS.employee);
  await page.waitForURL('**/dashboard.html');
  await expectToken(page);
  await page.context().storageState({ path: STATE.employee });
});

setup('authenticate employee2 (chris)', async ({ page }) => {
  await loginFirstTime(page, USERS.employee2);
  await page.waitForURL('**/dashboard.html');
  await expectToken(page);
  await page.context().storageState({ path: STATE.employee2 });
});
