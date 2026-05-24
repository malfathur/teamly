import { test, expect, type Page } from '@playwright/test';
import { STATE, EMP_PASSWORD, dashboardTab } from './helpers';

async function openAccountTab(page: Page) {
  await page.goto('/dashboard.html');
  await dashboardTab(page, 'Account');
  await expect(page.locator('input[x-model="cpCurrent"]')).toBeVisible();
}

test.describe('employee account — change password', () => {
  test.use({ storageState: STATE.employee });

  test('rejects an incorrect current password', async ({ page }) => {
    await openAccountTab(page);
    await page.locator('input[x-model="cpCurrent"]').fill('not-my-password');
    await page.locator('input[x-model="cpNew"]').fill('BrandNew123!');
    await page.locator('input[x-model="cpConfirm"]').fill('BrandNew123!');
    await page.getByRole('button', { name: 'Update Password' }).click();
    await expect(page.getByText('Current password is incorrect')).toBeVisible();
  });

  test('changes the password with the correct current password', async ({ page }) => {
    await openAccountTab(page);
    await page.locator('input[x-model="cpCurrent"]').fill(EMP_PASSWORD);
    await page.locator('input[x-model="cpNew"]').fill('BrandNew123!');
    await page.locator('input[x-model="cpConfirm"]').fill('BrandNew123!');
    await page.getByRole('button', { name: 'Update Password' }).click();
    await expect(page.getByText('Password updated successfully.')).toBeVisible();
  });
});

test.describe('admin — user timezone setting', () => {
  test.use({ storageState: STATE.admin });

  test('updates and persists a user timezone', async ({ page }) => {
    await page.goto('/admin.html');
    await page.locator('#tab-users').click();

    await page
      .locator('#usersBody tr', { hasText: 'Dana Kim' })
      .getByRole('button', { name: 'Edit' })
      .click();
    await expect(page.locator('#editModal')).toBeVisible();
    await page.locator('#editTimezone').selectOption('Europe/London');
    await page.getByRole('button', { name: 'Save Changes' }).click();
    await expect(page.locator('#editModal')).toBeHidden();

    // Reopen to confirm the change persisted.
    await page
      .locator('#usersBody tr', { hasText: 'Dana Kim' })
      .getByRole('button', { name: 'Edit' })
      .click();
    await expect(page.locator('#editModal')).toBeVisible();
    await expect(page.locator('#editTimezone')).toHaveValue('Europe/London');
  });
});
