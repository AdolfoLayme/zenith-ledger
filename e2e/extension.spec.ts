import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect, test } from '@playwright/test';

const extDist = resolve('extension/dist');

test.beforeAll(() => {
  execFileSync('pnpm', ['build:ext'], {
    stdio: 'pipe',
    env: { ...process.env, VITE_DEMO_FAKE_AI: '1' },
  });
});

test('Chrome extension MV3: audits the transaction table on the open bank page and a CSV through the Privacy Firewall', async ({ baseURL }) => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'zenith-ext-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: process.env.BROWSER_PATH ?? '/usr/bin/brave',
    headless: false,
    args: [
      '--headless=new',
      `--disable-extensions-except=${extDist}`,
      `--load-extension=${extDist}`,
    ],
  });

  try {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    const extId = new URL(sw.url()).host;

    const bankPage = await context.newPage();
    await bankPage.goto(`${baseURL}/samples/bank-statement.html`);
    await expect(bankPage.getByRole('heading', { name: 'First National Business Checking' })).toBeVisible();

    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extId}/sidepanel.html?demo=1`);
    await expect(panel.getByRole('heading', { level: 1, name: 'Audit with Zenith' })).toBeVisible();

    await panel.getByRole('button', { name: 'Enable on-device AI' }).click();
    await expect(panel.getByText('Active', { exact: true })).toBeVisible();

    await panel.getByTestId('audit-page').click();
    await expect(panel.getByRole('heading', { name: 'Local analysis' })).toBeVisible();
    await expect(panel.getByText('First National Business Checking — Q3 Activity')).toBeVisible();
    await expect(panel.locator('.stat b').first()).toHaveText('8');
    await expect(panel.locator('mark', { hasText: '4111111111111111' }).first()).toBeVisible();
    await expect(panel.locator('mark', { hasText: 'Sarah Jenkins' })).toBeVisible();
    await expect(panel.getByText('Possible duplicate')).toBeVisible();
    await expect(panel.getByText('Price increase')).toBeVisible();

    await panel.getByRole('button', { name: 'Review what would be sent' }).click();
    await expect(panel.getByRole('heading', { name: 'Privacy Firewall' })).toBeVisible();
    const json = (await panel.locator('pre.json').textContent()) ?? '';
    expect(json).toContain('"schema": "zenith-ledger/payload@1"');
    for (const secret of [
      '4111111111111111',
      'marcus.lee@mail.example',
      'support@cloudnest.example',
      'Sarah Jenkins',
      'Marcus Lee',
      'GB82WEST12345698765432',
      '123-45-6789',
      '555-0192',
      'DELTA OFFICE',
      'CLOUDNEST',
    ]) {
      expect(json.toLowerCase(), secret).not.toContain(secret.toLowerCase());
    }
    await expect(panel.locator('.stat', { hasText: 'raw descriptions sent' })).toContainText('0');
    const hash = ((await panel.locator('p.muted code').textContent()) ?? '').trim();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    await panel.getByRole('button', { name: 'Approve & send' }).click();
    await expect(panel.getByRole('heading', { name: 'Audit report' })).toBeVisible();
    const reportText = (await panel.locator('section').textContent()) ?? '';
    expect(reportText).toContain('DELTA OFFICE');
    expect(reportText).not.toMatch(/\bVendor_[A-Z]+\b/);
    await expect(panel.getByText(hash)).toBeVisible();

    // Also audit a CSV file dropped into the side panel
    await panel.getByRole('button', { name: 'Audit another statement' }).click();
    await panel.getByTestId('file').setInputFiles('public/samples/acme-q3.csv');
    await expect(panel.getByRole('heading', { name: 'Local analysis' })).toBeVisible();
    await expect(panel.locator('.stat b').first()).toHaveText('117');
  } finally {
    await context.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
