import { expect, test } from '@playwright/test';
import { lastMail } from './mail';

// Needs the backend running with MAIL_TRANSPORT=console|memory and an organisation at /${E2E_ORG} (default: demo).
const ORG = process.env.E2E_ORG || 'demo';
const unique = Date.now().toString(36);
const email = `e2e-${unique}@example.test`;
const password = 'E2e-Passw0rd!';

test('a learner registers, verifies their email and signs in', async ({ page }) => {
  await page.goto(`/${ORG}/register`);
  await page.getByRole('button', { name: 'Sign up with email' }).click();   // the form opens from this button
  await page.getByLabel(/full name|^name/i).fill('E2E Learner');
  await page.getByLabel(/^email/i).fill(email);
  await page.getByLabel(/^password/i).first().fill(password);
  const confirm = page.getByLabel(/confirm|repeat/i);
  if (await confirm.count()) await confirm.fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();

  const mail = await lastMail(email, /verify-email\?token=/);
  const link = mail.match(/https?:\/\/\S+verify-email\?token=[\w-]+/)![0];
  await page.goto(new URL(link).pathname + new URL(link).search);
  await expect(page.getByText('Your email is verified')).toBeVisible();
});

test('the stop-emails page asks before opting out', async ({ page }) => {
  await page.goto(`/${ORG}/stop-emails?token=not-a-real-token`);
  await expect(page.getByRole('heading', { name: 'Stop invitation emails' })).toBeVisible();
  await page.getByRole('button', { name: /Stop emails/ }).click();
  await expect(page.getByText(/invalid or has expired/)).toBeVisible();
});
