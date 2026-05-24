import { test, expect, type Page } from '@playwright/test';
import { STATE, dashboardTab } from './helpers';

test.use({ storageState: STATE.employee });

const clockedIn = (page: Page) => page.getByText('Clocked IN', { exact: true });
const clockedOut = (page: Page) => page.getByText('Clocked OUT', { exact: true });

async function openClockTab(page: Page) {
  await page.goto('/dashboard.html');
  await dashboardTab(page, 'Clock');
}

async function ensureClockedOut(page: Page) {
  if (await page.locator('.btn-clock-out').isEnabled()) {
    await page.locator('.btn-clock-out').click();
    await expect(clockedOut(page)).toBeVisible();
  }
}

test('clocks in then out', async ({ page }) => {
  await openClockTab(page);
  await ensureClockedOut(page);

  await page.locator('.btn-clock-in').click();
  await expect(clockedIn(page)).toBeVisible();

  await page.locator('.btn-clock-out').click();
  await expect(clockedOut(page)).toBeVisible();
});

test('prevents a duplicate clock-in', async ({ page }) => {
  await openClockTab(page);
  await ensureClockedOut(page);

  await page.locator('.btn-clock-in').click();
  await expect(clockedIn(page)).toBeVisible();

  // Once clocked in, the Clock IN button is disabled — no double punch.
  await expect(page.locator('.btn-clock-in')).toBeDisabled();
  await expect(page.locator('.btn-clock-out')).toBeEnabled();
});
