import { test, expect, type Page } from '@playwright/test';
import { STATE, dashboardTab, futureWeekday, addDays, pngFixture } from './helpers';

test.use({ storageState: STATE.employee });

// Cancellation uses window.confirm — auto-accept it.
test.beforeEach(async ({ page }) => {
  page.on('dialog', (d) => d.accept());
});

async function openLeaveTab(page: Page) {
  await page.goto('/dashboard.html');
  await dashboardTab(page, 'Leave');
  await expect(page.locator('select[x-model="form.type"]')).toBeVisible();
}

async function setDates(page: Page, start: string, end: string) {
  await page.locator('input[x-model="form.start_date"]').fill(start);
  await page.locator('input[x-model="form.end_date"]').fill(end);
}

const submitBtn = (page: Page) => page.getByRole('button', { name: 'Submit Leave Request' });

test('submits an annual leave request and previews the deduction', async ({ page }) => {
  await openLeaveTab(page);
  const day = futureWeekday(10);
  await page.locator('select[x-model="form.type"]').selectOption('AL');
  await setDates(page, day, day);

  // Live preview reflects the working-day deduction.
  await expect(page.getByText('will be deducted')).toContainText('1 working day');

  await submitBtn(page).click();
  await expect(page.getByText('Leave request submitted!')).toBeVisible();
});

test('submits sick leave with an MC attachment', async ({ page }) => {
  await openLeaveTab(page);
  await page.locator('select[x-model="form.type"]').selectOption('sick');
  const day = futureWeekday(6);
  await setDates(page, day, day);
  await page.locator('#mcFile').setInputFiles(pngFixture);
  await submitBtn(page).click();
  await expect(page.getByText('Leave request submitted!')).toBeVisible();
});

test('submits emergency leave with a reason', async ({ page }) => {
  await openLeaveTab(page);
  await page.locator('select[x-model="form.type"]').selectOption('emergency');
  const day = futureWeekday(3);
  await setDates(page, day, day);
  await page.locator('textarea[x-model="form.reason"]').fill('Family emergency — need the day off.');
  await submitBtn(page).click();
  await expect(page.getByText('Leave request submitted!')).toBeVisible();
});

test('rejects an AL request that exceeds the balance', async ({ page }) => {
  await openLeaveTab(page);
  const start = futureWeekday(10);
  await page.locator('select[x-model="form.type"]').selectOption('AL');
  // ~6 weeks → well over the 14-day default allocation.
  await setDates(page, start, addDays(start, 42));
  await submitBtn(page).click();
  await expect(page.locator('[x-show="formError"]')).toContainText('Insufficient AL balance');
});

test('cancels a pending leave request', async ({ page }) => {
  await openLeaveTab(page);
  const day = futureWeekday(28);
  await page.locator('select[x-model="form.type"]').selectOption('AL');
  await setDates(page, day, day);
  await submitBtn(page).click();
  await expect(page.getByText('Leave request submitted!')).toBeVisible();

  // Reload so the active list reflects committed state cleanly.
  await openLeaveTab(page);
  const activeCard = page.locator('.card', { hasText: 'Active Leave Requests' });
  const rows = activeCard.locator('.history-item');
  const before = await rows.count();
  expect(before).toBeGreaterThan(0);

  await rows.first().getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(rows).toHaveCount(before - 1);
});
