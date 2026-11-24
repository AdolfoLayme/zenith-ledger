import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const truth = JSON.parse(readFileSync('public/samples/acme-q3.truth.json', 'utf8')) as { pii: Record<string, string[]> };
const seeded = Object.values(truth.pii).flat();

/** Every request the page makes, so tests can prove what did (not) leave. */
function recordRequests(page: Page) {
  const seen: { url: string; method: string; body: string | null }[] = [];
  page.on('request', (r) => seen.push({ url: r.url(), method: r.method(), body: r.postData() }));
  return seen;
}

async function start(page: Page, nano: boolean) {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Audit your books');
  if (nano) {
    await page.getByRole('button', { name: 'Enable on-device AI' }).click();
    await expect(page.getByText('Active', { exact: true })).toBeVisible();
  }
}

const upload = (page: Page, file: string) => page.getByTestId('file').setInputFiles(file);

test('CSV: local analysis, Privacy Firewall, cloud report, re-identification, Data Receipt, delete all', async ({ page }) => {
  const requests = recordRequests(page);
  await start(page, true);
  await upload(page, 'public/samples/acme-q3.csv');

  await expect(page.getByRole('heading', { name: 'Local analysis' })).toBeVisible();
  await expect(page.locator('.stat b').first()).toHaveText('117');
  await expect(page.locator('mark').first()).toBeVisible();

  await page.getByRole('button', { name: 'Review what would be sent' }).click();
  await expect(page.getByRole('heading', { name: 'Privacy Firewall' })).toBeVisible();
  const json = (await page.locator('pre.json').textContent()) ?? '';
  expect(json).toContain('"schema": "zenith-ledger/payload@1"');
  for (const v of seeded) expect(json.toLowerCase(), v).not.toContain(v.toLowerCase());
  expect(json).not.toContain('DELTA OFFICE');
  await expect(page.locator('.stat', { hasText: 'raw descriptions sent' })).toContainText('0');
  const hash = ((await page.locator('p.muted code').textContent()) ?? '').trim();
  expect(hash).toMatch(/^[0-9a-f]{64}$/);

  await page.getByRole('button', { name: 'Approve & send' }).click();
  await expect(page.getByRole('heading', { name: 'Audit report' })).toBeVisible();
  const report = (await page.locator('section').textContent()) ?? '';
  expect(report).toContain('DELTA OFFICE');
  expect(report).not.toMatch(/\bVendor_[A-Z]+\b/);
  await expect(page.getByText(hash)).toBeVisible();

  await page.getByRole('button', { name: 'All Data Receipts' }).click();
  await expect(page.getByRole('heading', { name: 'Data Receipts' })).toBeVisible();
  await expect(page.locator('ol.receipts li')).toHaveCount(1);
  await expect(page.locator('ol.receipts')).toContainText(hash);
  await expect(page.locator('ol.receipts')).toContainText('signals');
  await page.getByRole('button', { name: 'Sync receipts' }).click();
  await expect(page.getByText('Synced with Receipt Vault: 1 uploaded, 0 restored.')).toBeVisible();
  await page.getByRole('button', { name: 'Delete all' }).click();
  await page.getByRole('button', { name: 'Delete receipts and alias maps' }).click();
  await expect(page.getByText('No data has left this device.')).toBeVisible();
  await page.getByRole('button', { name: 'Sync receipts' }).click();
  await expect(page.getByText('Synced with Receipt Vault: 0 uploaded, 1 restored.')).toBeVisible();
  await expect(page.locator('ol.receipts li')).toHaveCount(1);
  await page.getByRole('button', { name: 'Delete vault copy' }).click();
  await expect(page.getByText('Vault copy deleted.')).toBeVisible();
  await page.getByRole('button', { name: 'Delete all' }).click();
  await page.getByRole('button', { name: 'Delete receipts and alias maps' }).click();
  await expect(page.getByText('No data has left this device.')).toBeVisible();
  await expect(page.locator('.count')).toHaveText('0');

  // demo mode: nothing at all went to another host
  expect(requests.filter((r) => !r.url.startsWith('http://127.0.0.1:5421')).map((r) => r.url)).toEqual([]);
});

test('offline: local analysis keeps working, Nano writes a summary, sending is disabled until reconnect', async ({ page, context }) => {
  await start(page, true);
  await upload(page, 'public/samples/acme-q4.csv');
  await expect(page.getByRole('heading', { name: 'Local analysis' })).toBeVisible();

  await context.setOffline(true);
  await expect(page.getByTestId('net')).toHaveText('Offline');
  const summary = page.getByTestId('offline-summary');
  await expect(summary).toContainText('On-device summary');
  await expect(summary).toContainText('transactions');
  expect((await summary.textContent()) ?? '').not.toMatch(/\bVendor_[A-Z]+\b/);

  await page.getByRole('button', { name: 'Review what would be sent' }).click();
  await expect(page.getByRole('button', { name: 'Approve & send' })).toBeDisabled();
  await expect(page.getByText('You are offline.')).toBeVisible();

  await context.setOffline(false);
  await expect(page.getByTestId('net')).toHaveText('Online');
  await expect(page.getByRole('button', { name: 'Approve & send' })).toBeEnabled();
});

test('statement and receipt photos: pick the kind, check the rows read on device, then the same pipeline', async ({ page }) => {
  await start(page, true);
  await upload(page, 'public/samples/statement-photo.png');
  await page.getByRole('group', { name: 'Photo type' }).getByRole('button', { name: 'Statement' }).click();
  await expect(page.getByRole('heading', { name: 'Check what was read' })).toBeVisible();
  await expect(page.locator('table.review tbody tr')).toHaveCount(11);
  await expect(page.getByLabel('Amount, row 8')).toHaveValue('-236.40');
  await page.getByRole('button', { name: 'Looks right' }).click();
  await expect(page.getByRole('heading', { name: 'Local analysis' })).toBeVisible();
  await expect(page.getByText('photo read on this device by Gemini Nano')).toBeVisible();
  await expect(page.locator('.stat b').first()).toHaveText('11');
  await expect(page.getByText('Possible duplicate')).toBeVisible();
  await page.getByRole('button', { name: 'Review what would be sent' }).click();
  const json = (await page.locator('pre.json').textContent()) ?? '';
  for (const v of ['4111111111111111', 'marcus.lee@mail.example', 'Hans Meyer', 'GB82WEST12345698765432', 'CLOUDNEST']) expect(json).not.toContain(v);

  // a receipt becomes one payment built from its fields; the payer's name and email are redacted
  await page.getByRole('button', { name: 'Zenith Ledger' }).click();
  await upload(page, 'public/samples/receipt-photo.png');
  await page.getByRole('group', { name: 'Photo type' }).getByRole('button', { name: 'Receipt' }).click();
  await expect(page.locator('table.review tbody tr')).toHaveCount(1);
  await expect(page.getByLabel('Description, row 1')).toHaveValue('BRIGHTSIDE CAFE card ****1111 paid by Emily Carter emily.carter@gmail.com');
  await expect(page.getByLabel('Amount, row 1')).toHaveValue('-18.75');
  await page.getByLabel('Amount, row 1').fill('-19.75');
  await page.getByRole('button', { name: 'Looks right' }).click();
  await expect(page.locator('.stat b').first()).toHaveText('1');
  await expect(page.locator('mark', { hasText: 'emily.carter@gmail.com' })).toBeVisible();
  await expect(page.locator('mark', { hasText: 'Emily Carter' })).toBeVisible();
  await expect(page.locator('td.num', { hasText: '-$19.75' })).toBeVisible();
});

test('review screen: a misread card number is flagged and a row left invalid is named, not dropped', async ({ page }) => {
  await start(page, true);
  await page.getByRole('button', { name: 'Statement photo' }).click();
  await expect(page.getByRole('heading', { name: 'Check what was read' })).toBeVisible();
  await expect(page.locator('.hint')).toHaveCount(0);
  await page.getByLabel('Description, row 2').fill('POS DEBIT BRIGHTSIDE CAFE card 411111111111111');
  await expect(page.locator('.hint')).toHaveCount(1);
  await page.getByLabel('Date, row 3').fill('Sep 4');
  await page.getByRole('button', { name: 'Looks right' }).click();
  await expect(page.getByRole('alert')).toContainText('Row 3');
  await expect(page.getByRole('heading', { name: 'Check what was read' })).toBeVisible();
  await page.getByRole('button', { name: 'Remove row 3' }).click();
  await page.getByRole('button', { name: 'Looks right' }).click();
  await expect(page.locator('.stat b').first()).toHaveText('10');
});

test('without on-device AI a photo is refused and nothing is sent', async ({ page }) => {
  await start(page, false);
  const requests = recordRequests(page);
  await upload(page, 'public/samples/statement-photo.png');
  await expect(page.getByRole('alert')).toContainText('was not sent anywhere');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.waitForTimeout(500);
  expect(requests).toEqual([]);
});

test('Accountant Review Pack: two browser contexts (client and accountant), firewall proof, Gemini draft reply with aliases, and local re-identification', async ({ browser }) => {
  const clientCtx = await browser.newContext();
  const accountantCtx = await browser.newContext();
  try {
    const clientPage = await clientCtx.newPage();
    await start(clientPage, true);
    await upload(clientPage, 'public/samples/acme-q3-gaps.csv');
    await expect(clientPage.getByRole('heading', { name: 'Local analysis' })).toBeVisible();
    await expect(clientPage.getByTestId('integrity-check')).toContainText('gap between rows 41–42');

    // The BRIGHTLINE lines 15-16 repeat with the same balance: integrity proves an export error, not a double charge
    const exportDup = clientPage.getByTestId('alert-duplicate').first();
    await expect(exportDup).toContainText('Likely export duplicate');
    await expect(exportDup).not.toContainText('Possible duplicate');

    // Open a real double charge and mark it "Ask my accountant" with a question containing a real vendor name
    const dupAlert = clientPage.getByTestId('alert-duplicate').filter({ hasText: 'Possible duplicate' }).first();
    if ((await dupAlert.locator('.sig-btn').getAttribute('aria-expanded')) !== 'true') {
      await dupAlert.locator('.sig-btn').click();
    }
    await dupAlert.getByRole('button', { name: 'Ask my accountant' }).click();
    await dupAlert.getByLabel('Decision note').fill('Did DELTA OFFICE double-charge us here?');

    // Review pack in Privacy Firewall
    await clientPage.getByTestId('review-pack-firewall').click();
    await expect(clientPage.getByTestId('pack-firewall')).toBeVisible();
    const packJson = (await clientPage.locator('pre.json').textContent()) ?? '';
    expect(packJson).toContain('"schema": "zenith-ledger/accountant-pack@1"');
    expect(packJson).toContain('"selectedAlertCount": 1');
    expect(packJson).toContain('"selectedRowCount": 2');
    for (const v of seeded) expect(packJson.toLowerCase(), v).not.toContain(v.toLowerCase());
    expect(packJson).not.toContain('DELTA OFFICE');

    // Approve and create expiring link
    await clientPage.getByTestId('approve-pack').click();
    await expect(clientPage.getByTestId('shared-pack-card')).toBeVisible();
    const shareUrl = ((await clientPage.getByTestId('pack-share-url').textContent()) ?? '').trim();
    expect(shareUrl).toContain('?pack=');

    // Open the link in the separate accountant browser context (no account, no shared IndexedDB)
    const accountantPage = await accountantCtx.newPage();
    await accountantPage.goto(shareUrl);
    await expect(accountantPage.getByTestId('accountant-view')).toBeVisible();
    await expect(accountantPage.getByTestId('pack-item-duplicate')).toBeVisible();
    const header = accountantPage.getByTestId('accountant-header');
    await expect(header).toContainText('Zenith Ledger · Accountant review');
    await expect(accountantPage.getByRole('navigation', { name: 'Progress' })).toHaveCount(0);
    await expect(accountantPage.getByRole('button', { name: /Data Receipts/ })).toHaveCount(0);
    const accountantText = (await accountantPage.locator('section').textContent()) ?? '';
    expect(accountantText).not.toContain('DELTA OFFICE');
    expect(accountantText).toMatch(/Vendor_[A-Z]+/);

    // Accountant asks Gemini in the cloud for a draft reply (which sees only aliases) and sends it
    await accountantPage.getByTestId('draft-reply-gemini').click();
    await expect(accountantPage.getByTestId('accountant-reply-input')).toHaveValue(/Vendor_[A-Z]+/);
    const draftValue = await accountantPage.getByTestId('accountant-reply-input').inputValue();
    expect(draftValue).not.toContain('DELTA OFFICE');
    await accountantPage.getByTestId('send-accountant-reply').click();
    await expect(accountantPage.getByTestId('reply-saved-badge')).toBeVisible();

    // Client refreshes responses and sees the real vendor name restored locally
    await clientPage.getByTestId('refresh-pack-replies').click();
    const replyCard = clientPage.getByTestId('reidentified-reply').first();
    await expect(replyCard).toBeVisible();
    const clientReplyText = (await replyCard.textContent()) ?? '';
    expect(clientReplyText).toContain('DELTA OFFICE');
    expect(clientReplyText).not.toMatch(/\bVendor_[A-Z]+\b/);
  } finally {
    await clientCtx.close();
    await accountantCtx.close();
  }
});
