import { test, expect, type Browser, type Page } from '@playwright/test';
import { STATE, dashboardTab, futureWeekday, futureMonday, pngFixture } from './helpers';

// This suite drives two roles at once (submitter + approver), so it manages its
// own contexts rather than a single storage state. "chris" submits; "alex" (HOD)
// approves sick/emergency/WFH; "maya" (approver_a) approves AL.

async function ctxPage(browser: Browser, state: string) {
  const ctx = await browser.newContext({ storageState: state });
  const page = await ctx.newPage();
  return { ctx, page };
}

async function submitLeave(
  page: Page,
  opts: { type: string; day: string; reason?: string; mc?: boolean },
) {
  await page.goto('/dashboard.html');
  await dashboardTab(page, 'Leave');
  await page.locator('select[x-model="form.type"]').selectOption(opts.type);
  await page.locator('input[x-model="form.start_date"]').fill(opts.day);
  await page.locator('input[x-model="form.end_date"]').fill(opts.day);
  if (opts.reason) await page.locator('textarea[x-model="form.reason"]').fill(opts.reason);
  if (opts.mc) await page.locator('#mcFile').setInputFiles(pngFixture);
  await page.getByRole('button', { name: 'Submit Leave Request' }).click();
  await expect(page.getByText('Leave request submitted!')).toBeVisible();
}

async function submitWfh(page: Page, day: string) {
  await page.goto('/dashboard.html');
  await dashboardTab(page, 'WFH');
  await page.locator('input[x-model="wfhForm.start_date"]').fill(day);
  await page.locator('textarea[x-model="wfhForm.reason"]').fill('WFH for approval test.');
  await page.getByRole('button', { name: 'Submit WFH Request' }).click();
  await expect(page.getByText('WFH request submitted!')).toBeVisible();
}

async function openApprovals(page: Page) {
  await page.goto('/dashboard.html');
  await dashboardTab(page, 'Approvals');
}

function chrisLeaveCard(page: Page) {
  return page
    .locator('.card', { hasText: 'Pending Approvals' })
    .locator('.approval-card', { hasText: 'Chris Wong' })
    .first();
}

test('HOD approves a sick leave assigned to them', async ({ browser }) => {
  const chris = await ctxPage(browser, STATE.employee2);
  await submitLeave(chris.page, { type: 'sick', day: futureWeekday(8), mc: true });
  await chris.ctx.close();

  const hod = await ctxPage(browser, STATE.hod);
  await openApprovals(hod.page);
  const card = chrisLeaveCard(hod.page);
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Approve' }).click();
  await expect(card).toBeHidden();
  await hod.ctx.close();
});

test('HOD rejects an emergency leave with a reason', async ({ browser }) => {
  const chris = await ctxPage(browser, STATE.employee2);
  await submitLeave(chris.page, {
    type: 'emergency',
    day: futureWeekday(9),
    reason: 'Personal emergency.',
  });
  await chris.ctx.close();

  const hod = await ctxPage(browser, STATE.hod);
  await openApprovals(hod.page);
  const card = chrisLeaveCard(hod.page);
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Reject', exact: true }).click();

  await hod.page.locator('textarea[x-model="rejectReason"]').fill('Insufficient notice.');
  await hod.page.getByRole('button', { name: 'Confirm Reject' }).click();
  await expect(card).toBeHidden();
  await hod.ctx.close();
});

test('approver_a approves AL and the balance is deducted', async ({ browser }) => {
  const chris = await ctxPage(browser, STATE.employee2);
  await chris.page.goto('/dashboard.html');
  const balanceNum = chris.page.locator('.balance-item.highlight .balance-num');
  await expect(balanceNum).toHaveText(/^\d+$/);
  const before = parseInt((await balanceNum.textContent()) || '0', 10);

  await submitLeave(chris.page, { type: 'AL', day: futureWeekday(12) });

  const approver = await ctxPage(browser, STATE.approver);
  await openApprovals(approver.page);
  const card = chrisLeaveCard(approver.page);
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Approve' }).click();
  await expect(card).toBeHidden();
  await approver.ctx.close();

  // Back as chris: the approved day is now deducted from the balance.
  await chris.page.goto('/dashboard.html');
  await expect(chris.page.locator('.balance-item.highlight .balance-num')).toHaveText(
    String(before - 1),
  );
  await chris.ctx.close();
});

test('HOD approves a WFH request assigned to them', async ({ browser }) => {
  const chris = await ctxPage(browser, STATE.employee2);
  await submitWfh(chris.page, futureMonday(7));
  await chris.ctx.close();

  const hod = await ctxPage(browser, STATE.hod);
  await openApprovals(hod.page);
  const card = hod.page
    .locator('.card', { hasText: 'Pending WFH Approvals' })
    .locator('.approval-card', { hasText: 'Chris Wong' })
    .first();
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Approve' }).click();
  await expect(card).toBeHidden();
  await hod.ctx.close();
});
