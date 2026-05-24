import { test, expect } from '@playwright/test';
import { STATE } from './helpers';

test.describe('superadmin admin console', () => {
  test.use({ storageState: STATE.admin });

  test('exposes every tab including DB Reset and lists users', async ({ page }) => {
    await page.goto('/admin.html');
    await expect(page.locator('#tab-reset')).toBeVisible();

    await page.locator('#tab-users').click();
    await expect(page.locator('#usersBody')).toContainText('Alex Johnson');

    // DB Reset is reachable — but we never trigger the actual wipe.
    await page.locator('#tab-reset').click();
    await expect(page.locator('#section-reset')).toBeVisible();
  });
});

test.describe('HOD admin console', () => {
  test.use({ storageState: STATE.hod });

  test('hides the superadmin-only DB Reset tab and shows the user-console shortcut', async ({
    page,
  }) => {
    await page.goto('/admin.html');
    await expect(page.locator('#btnUserConsole')).toBeVisible();
    await expect(page.locator('#tab-reset')).toBeHidden();
    // Permitted tabs are still available.
    await expect(page.locator('#tab-users')).toBeVisible();
    await expect(page.locator('#tab-tracking')).toBeVisible();
  });

  test('is forbidden from resetting the database server-side', async ({ page }) => {
    await page.goto('/admin.html');
    const status = await page.evaluate(async () => {
      const token = localStorage.getItem('teamly_token');
      const res = await fetch('/api/admin/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ confirm: 'RESET' }),
      });
      return res.status;
    });
    expect(status).toBe(403);
  });
});
