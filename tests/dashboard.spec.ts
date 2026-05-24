import { test, expect, type Page } from '@playwright/test';
import { STATE } from './helpers';

const EMPLOYEE_TABS = [
  'Overview',
  'Clock',
  'Leave',
  'WFH',
  'Claims',
  'My History',
  'Team Calendar',
  'Account',
];

async function tab(page: Page, label: string) {
  return page.locator('nav.tab-bar button.tab-btn', { hasText: label }).first();
}

test.describe('employee dashboard', () => {
  test.use({ storageState: STATE.employee });

  test('overview loads with the core tabs and no approvals tab', async ({ page }) => {
    await page.goto('/dashboard.html');

    await expect(page.getByText('My Requests')).toBeVisible();
    await expect(page.getByText('Annual Leave Balance')).toBeVisible();

    for (const label of EMPLOYEE_TABS) {
      await expect(await tab(page, label)).toBeVisible();
    }
    // Regular staff never see the Approvals tab.
    await expect(await tab(page, 'Approvals')).toBeHidden();
  });
});

test.describe('HOD dashboard', () => {
  test.use({ storageState: STATE.hod });

  test('sees the approvals tab', async ({ page }) => {
    await page.goto('/dashboard.html');
    await expect(await tab(page, 'Approvals')).toBeVisible();
  });
});

test.describe('approver_a dashboard', () => {
  test.use({ storageState: STATE.approver });

  test('sees the approvals tab', async ({ page }) => {
    await page.goto('/dashboard.html');
    await expect(await tab(page, 'Approvals')).toBeVisible();
  });
});
