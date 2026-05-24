import { test, expect, type Page } from '@playwright/test';
import { STATE, dashboardTab, pngFixture } from './helpers';

test.use({ storageState: STATE.employee });

async function openClaimsTab(page: Page) {
  await page.goto('/dashboard.html');
  await dashboardTab(page, 'Claims');
  await expect(page.locator('select[x-model="claimForm.department"]')).toBeVisible();
}

test('submits an expense claim with a receipt and shows it as pending', async ({ page }) => {
  await openClaimsTab(page);

  await page.locator('select[x-model="claimForm.department"]').selectOption('IT');
  // Seeded category from initDB.
  await page.locator('select[x-model="claimForm.category_id"]').selectOption({ label: 'Business Expenses' });
  await page.locator('input[x-model="claimForm.item"]').fill('Taxi to client meeting');
  await page.locator('input[x-model="claimForm.amount"]').fill('42.50');
  await page.locator('#receiptFile').setInputFiles(pngFixture);

  await page.getByRole('button', { name: 'Submit Claim' }).click();

  await expect(page.getByText(/Claim submitted! Ref:/)).toBeVisible();

  const activeCard = page.locator('.card', { hasText: 'Active Claims' });
  await expect(activeCard).toContainText('Taxi to client meeting');
});
