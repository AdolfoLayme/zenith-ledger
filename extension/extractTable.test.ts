// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyzeLocally, buildPayload } from '../src/core/pipeline';
import { auditActiveTabTable, grabTablesFromDom, parseTablesToRows } from './extractTable';

describe('DOM transaction table extraction', () => {
  it('extracts rows from an online banking statement table and ignores unrelated layout tables', () => {
    document.body.innerHTML = `
      <table>
        <thead><tr><th>Account</th><th>Status</th></tr></thead>
        <tbody><tr><td>Checking</td><td>Open</td></tr></tbody>
      </table>
      <table id="activity">
        <thead>
          <tr><th>Posted Date</th><th>Transaction Description</th><th>Amount</th><th>Balance</th></tr>
        </thead>
        <tbody>
          <tr><td>2025-09-01</td><td>ACH CREDIT CLIENT INVOICE 1042 john.smith@client.example</td><td>$4,200.00</td><td>$14,200.00</td></tr>
          <tr><td>2025-09-02</td><td>POS DEBIT DELTA OFFICE SUPPLY card 4111111111111111</td><td>-$236.40</td><td>$13,963.60</td></tr>
          <tr><td>2025-09-03</td><td>POS DEBIT DELTA OFFICE SUPPLY card 4111111111111111</td><td>-$236.40</td><td>$13,727.20</td></tr>
          <tr><td>Subtotal</td><td></td><td></td><td></td></tr>
        </tbody>
      </table>
    `;

    const tables = grabTablesFromDom();
    const rows = parseTablesToRows(tables);

    expect(rows).toEqual([
      {
        date: '2025-09-01',
        description: 'ACH CREDIT CLIENT INVOICE 1042 john.smith@client.example',
        amountCents: 420000,
        currency: 'USD',
        balanceCents: 1420000,
      },
      {
        date: '2025-09-02',
        description: 'POS DEBIT DELTA OFFICE SUPPLY card 4111111111111111',
        amountCents: -23640,
        currency: 'USD',
        balanceCents: 1396360,
      },
      {
        date: '2025-09-03',
        description: 'POS DEBIT DELTA OFFICE SUPPLY card 4111111111111111',
        amountCents: -23640,
        currency: 'USD',
        balanceCents: 1372720,
      },
    ]);
  });

  it('supports separate Debit and Credit columns and feeds the same privacy pipeline without leaking PII', async () => {
    document.body.innerHTML = `
      <table>
        <tr><th>Date</th><th>Merchant / Memo</th><th>Debit</th><th>Credit</th></tr>
        <tr><td>09/10/2025</td><td>WIRE TO Sarah Jenkins IBAN GB82WEST12345698765432</td><td>$1,500.00</td><td></td></tr>
        <tr><td>09/11/2025</td><td>DEPOSIT FROM ACME CORP</td><td></td><td>$3,000.00</td></tr>
      </table>
    `;

    const rows = parseTablesToRows(grabTablesFromDom());
    expect(rows.map((r) => r.amountCents)).toEqual([-150000, 300000]);

    const analysis = analyzeLocally(rows);
    const built = await buildPayload(analysis);
    expect(built.counters.rawDescriptionsSent).toBe(0);
    expect(built.json).not.toContain('GB82WEST12345698765432');
    expect(built.json).not.toContain('Sarah Jenkins');
  });

  it('throws a clear error when the page has no transaction table', () => {
    document.body.innerHTML = '<p>Welcome to your dashboard</p>';
    expect(() => parseTablesToRows(grabTablesFromDom())).toThrow(/No transaction table found on this page/);
  });

  it('auditActiveTabTable skips extension tabs and extracts the open web tab table', async () => {
    document.body.innerHTML = `
      <table>
        <thead><tr><th>Date</th><th>Description</th><th>Amount</th></tr></thead>
        <tbody><tr><td>2025-09-05</td><td>POS DEBIT BRIGHTSIDE CAFE card 4111111111111111</td><td>-$18.75</td></tr></tbody>
      </table>
    `;
    let targetedTabId = -1;
    (globalThis as unknown as { chrome: unknown }).chrome = {
      tabs: {
        query: async () => [
          { id: 10, url: 'http://127.0.0.1:5421/samples/bank-statement.html', title: 'First National Checking', active: false },
          { id: 11, url: 'chrome-extension://abcdefghijklmnop/sidepanel.html', title: 'Audit with Zenith', active: true },
        ],
      },
      scripting: {
        executeScript: async ({ target, func }: { target: { tabId: number }; func: () => unknown }) => {
          targetedTabId = target.tabId;
          return [{ result: func() }];
        },
      },
    };

    const res = await auditActiveTabTable();
    expect(targetedTabId).toBe(10);
    expect(res.name).toBe('First National Checking');
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].amountCents).toBe(-1875);
  });

  it('extracts rows from ARIA grids ([role=table], [role=grid], [role=row], [role=columnheader], [role=cell], [role=gridcell]) without any <table> element', () => {
    document.body.innerHTML = `
      <div role="grid" aria-label="Recent Activity">
        <div role="rowgroup">
          <div role="row">
            <div role="columnheader">Posted Date</div>
            <div role="columnheader">Transaction Details</div>
            <div role="columnheader">Amount</div>
            <div role="columnheader">Running Balance</div>
          </div>
        </div>
        <div role="rowgroup">
          <div role="row">
            <div role="gridcell">2025-09-01</div>
            <div role="gridcell">ACH DEPOSIT LAKESIDE DENTAL LLC inv 4100</div>
            <div role="gridcell">$3,500.00</div>
            <div role="gridcell">$18,500.00</div>
          </div>
          <div role="row">
            <div role="cell">2025-09-03</div>
            <div role="cell">POS DEBIT DELTA OFFICE DEPOT card 4111111111111111</div>
            <div role="cell">-$236.40</div>
            <div role="cell">$18,263.60</div>
          </div>
          <div role="row">
            <div role="cell">2025-09-04</div>
            <div role="cell">POS DEBIT DELTA OFFICE DEPOT card 4111111111111111</div>
            <div role="cell">-$236.40</div>
            <div role="cell">$18,027.20</div>
          </div>
        </div>
      </div>
    `;

    expect(document.querySelectorAll('table')).toHaveLength(0);
    const rows = parseTablesToRows(grabTablesFromDom());
    expect(rows).toEqual([
      {
        date: '2025-09-01',
        description: 'ACH DEPOSIT LAKESIDE DENTAL LLC inv 4100',
        amountCents: 350000,
        currency: 'USD',
        balanceCents: 1850000,
      },
      {
        date: '2025-09-03',
        description: 'POS DEBIT DELTA OFFICE DEPOT card 4111111111111111',
        amountCents: -23640,
        currency: 'USD',
        balanceCents: 1826360,
      },
      {
        date: '2025-09-04',
        description: 'POS DEBIT DELTA OFFICE DEPOT card 4111111111111111',
        amountCents: -23640,
        currency: 'USD',
        balanceCents: 1802720,
      },
    ]);
  });

  it('extracts rows from modern banking div lists (with or without explicit column header divs)', () => {
    document.body.innerHTML = `
      <div class="activity-feed">
        <div class="tx-row">
          <div class="col-date">2025-09-10</div>
          <div class="col-desc">Wire to Sarah Jenkins IBAN GB82WEST12345698765432</div>
          <div class="col-amount">-$1,500.00</div>
          <div class="col-balance">$12,400.00</div>
        </div>
        <div class="tx-row">
          <div class="col-date">2025-09-12</div>
          <div class="col-desc">CLOUDNEST HOSTING subscription support@cloudnest.example</div>
          <div class="col-amount">-$59.00</div>
          <div class="col-balance">$12,341.00</div>
        </div>
      </div>
    `;

    const rows = parseTablesToRows(grabTablesFromDom());
    expect(rows).toEqual([
      {
        date: '2025-09-10',
        description: 'Wire to Sarah Jenkins IBAN GB82WEST12345698765432',
        amountCents: -150000,
        currency: 'USD',
        balanceCents: 1240000,
      },
      {
        date: '2025-09-12',
        description: 'CLOUDNEST HOSTING subscription support@cloudnest.example',
        amountCents: -5900,
        currency: 'USD',
        balanceCents: 1234100,
      },
    ]);
  });

  it('extracts the synthetic ARIA grid banking sample page without leaking PII', async () => {
    document.body.innerHTML = readFileSync('public/samples/bank-aria-grid.html', 'utf8');
    expect(document.querySelectorAll('table')).toHaveLength(0);
    const rows = parseTablesToRows(grabTablesFromDom());
    expect(rows.length).toBeGreaterThanOrEqual(8);

    const analysis = analyzeLocally(rows);
    const built = await buildPayload(analysis);
    expect(built.counters.rawDescriptionsSent).toBe(0);
    expect(built.json).not.toContain('4111111111111111');
    expect(built.json).not.toContain('GB82WEST12345698765432');
    expect(built.json).not.toContain('DELTA OFFICE');
  });
});
