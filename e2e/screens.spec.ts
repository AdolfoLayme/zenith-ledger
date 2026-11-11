import { test, expect } from '@playwright/test';

// Screenshots for visual review: SHOTS_DIR=<dir> pnpm e2e screens
const dir = process.env.SHOTS_DIR;
test.skip(!dir, 'set SHOTS_DIR to capture screenshots');

for (const [name, viewport] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]] as const) {
  test(`screens ${name}`, async ({ page, context }) => {
    await page.setViewportSize(viewport);
    const shot = (n: string) => page.screenshot({ path: `${dir}/${name}-${n}.png`, fullPage: true });
    await page.goto('/');
    await shot('1-upload');
    await page.getByTestId('file').setInputFiles('public/samples/statement-photo.png');
    await expect(page.getByRole('alert')).toBeVisible();
    await shot('1b-photo-refused');
    await page.getByRole('button', { name: 'Enable on-device AI' }).click();
    await expect(page.getByText('Active', { exact: true })).toBeVisible();
    await page.getByTestId('file').setInputFiles('public/samples/statement-photo.png');
    await expect(page.getByText('photo read on this device by Gemini Nano')).toBeVisible();
    await shot('2b-local-photo');
    await page.getByRole('button', { name: 'Zenith Ledger' }).click();
    await page.getByTestId('file').setInputFiles('public/samples/acme-q3.csv');
    await expect(page.getByRole('heading', { name: 'Local analysis' })).toBeVisible();
    await shot('2-local');
    await context.setOffline(true);
    await expect(page.getByTestId('offline-summary')).toContainText('On-device summary');
    await shot('2c-local-offline');
    await page.getByRole('button', { name: 'Review what would be sent' }).click();
    await shot('3b-firewall-offline');
    await context.setOffline(false);
    await expect(page.getByRole('button', { name: 'Approve & send' })).toBeEnabled();
    await shot('3-firewall');
    await page.getByRole('button', { name: 'Approve & send' }).click();
    await expect(page.getByRole('heading', { name: 'Audit report' })).toBeVisible();
    await shot('4-report');
    await page.getByRole('button', { name: 'All Data Receipts' }).click();
    await shot('5-receipts');
    await page.getByRole('button', { name: 'Delete all' }).click();
    await shot('5b-receipts-confirm');
    await page.getByRole('button', { name: 'Delete receipts and alias maps' }).click();
    await expect(page.getByText('No data has left this device.')).toBeVisible();
    await shot('5c-receipts-empty');
  });
}
