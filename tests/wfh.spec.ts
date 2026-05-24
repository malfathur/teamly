import { test, expect, type Page } from '@playwright/test';
import { STATE, dashboardTab, futureMonday, addDays } from './helpers';

test.use({ storageState: STATE.employee });

async function openWfhTab(page: Page) {
  await page.goto('/dashboard.html');
  await dashboardTab(page, 'WFH');
  await expect(page.locator('input[x-model="wfhForm.start_date"]')).toBeVisible();
}

const startInput = (page: Page) => page.locator('input[x-model="wfhForm.start_date"]');
const endInput = (page: Page) => page.locator('input[x-model="wfhForm.end_date"]');
const submitBtn = (page: Page) => page.getByRole('button', { name: 'Submit WFH Request' });

test('submits a single WFH day', async ({ page }) => {
  await openWfhTab(page);
  await startInput(page).fill(futureMonday(3));
  await page.locator('textarea[x-model="wfhForm.reason"]').fill('Focus day at home.');
  await submitBtn(page).click();
  // On success the form resets — start date clears.
  await expect(startInput(page)).toHaveValue('');
});

test('enforces the 2-per-week limit', async ({ page }) => {
  await openWfhTab(page);
  // A Mon–Fri range = 5 weekdays. The server expands the range and rejects any
  // Mon–Sun week with more than 2 days; 5 contiguous weekdays always breach it
  // (even if the UTC-stored dates shift by a day on a non-UTC host).
  const monday = futureMonday(5);
  await startInput(page).fill(monday);
  await endInput(page).fill(addDays(monday, 4));
  await page.locator('textarea[x-model="wfhForm.reason"]').fill('Whole week WFH.');
  await submitBtn(page).click();
  await expect(page.locator('[x-show="wfhError"]')).toContainText('exceed 2 WFH');
});
