import { test, expect } from '@playwright/test';
import { ADMIN, EMP_PASSWORD, loginExisting, loginFirstTime } from './helpers';

// Login is exercised with a clean (unauthenticated) browser context.
test.use({ storageState: { cookies: [], origins: [] } });

test('rejects an invalid password', async ({ page }) => {
  await loginExisting(page, ADMIN.username, 'definitely-wrong');
  await expect(page.locator('#errorMsg')).toBeVisible();
  await expect(page.locator('#errorMsg')).toContainText('Invalid credentials');
});

test('validates that a username is entered', async ({ page }) => {
  await page.goto('/login.html');
  await page.locator('#btnLogin').click();
  await expect(page.locator('#errorMsg')).toContainText('enter your username');
});

test('first-time user creates a password and lands on the dashboard', async ({ page }) => {
  // "noor" is reserved for this one-shot first-login flow.
  await loginFirstTime(page, 'noor');
  await page.waitForURL('**/dashboard.html');
  const token = await page.evaluate(() => localStorage.getItem('teamly_token'));
  expect(token).not.toBeNull();
});

test('first-time view validates the new password', async ({ page }) => {
  // "dana" is left in first-time state — we never submit a valid password here.
  await page.goto('/login.html');
  await page.locator('#usernameInput').fill('dana');
  await page.locator('#password').fill('ignored');
  await page.locator('#btnLogin').click();

  await expect(page.locator('#view-setpass')).toBeVisible();

  await page.locator('#newPass').fill('short');
  await page.locator('#confirmPass').fill('short');
  await page.locator('#btnSetPass').click();
  await expect(page.locator('#setPassError')).toContainText('at least 8 characters');

  await page.locator('#newPass').fill('ValidPass123');
  await page.locator('#confirmPass').fill('Different456');
  await page.locator('#btnSetPass').click();
  await expect(page.locator('#setPassError')).toContainText('do not match');
});

test('valid super-admin login redirects to the admin console', async ({ page }) => {
  await loginExisting(page, ADMIN.username, ADMIN.password);
  await page.waitForURL('**/admin.html');
});
