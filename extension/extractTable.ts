import { toCents, toIsoDate } from '../src/core/csv';
import type { StatementRow } from '../src/core/types';

export interface RawTable {
  headers: string[];
  rows: string[][];
}

/**
 * Self-contained DOM table reader. Contains no external references so Chrome can
 * serialize and run it directly inside the active tab via chrome.scripting.executeScript.
 */
export function grabTablesFromDom(): RawTable[] {
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  const out: RawTable[] = [];

  // 1. Classic HTML <table> elements
  for (const table of document.querySelectorAll('table')) {
    const trs = [...table.querySelectorAll('tr')];
    const headTr = table.querySelector('thead tr') ?? trs[0];
    const headers = headTr ? [...headTr.querySelectorAll('th, td')].map((c) => clean(c.textContent)) : [];
    const bodyTrs = table.querySelectorAll('tbody tr').length
      ? [...table.querySelectorAll('tbody tr')]
      : trs.slice(headTr ? 1 : 0);
    const rows = bodyTrs
      .map((tr) => [...tr.querySelectorAll('td, th')].map((c) => clean(c.textContent)))
      .filter((r) => r.some(Boolean));
    out.push({ headers, rows });
  }

  // 2. ARIA tables and grids ([role=table], [role=grid], [role=treegrid], [role=row], [role=cell], [role=gridcell])
  const cellSel = '[role="columnheader"], [role="rowheader"], [role="cell"], [role="gridcell"]';
  const readRowCells = (rowEl: Element): string[] => {
    const ariaCells = [...rowEl.querySelectorAll(cellSel)];
    const els = ariaCells.length ? ariaCells : [...rowEl.children];
    return els.map((c) => clean(c.textContent));
  };

  for (const grid of document.querySelectorAll('[role="table"], [role="grid"], [role="treegrid"]')) {
    const roleRows = [...grid.querySelectorAll('[role="row"]')];
    if (!roleRows.length) continue;
    const headerRow =
      roleRows.find((r) => r.querySelector('[role="columnheader"]') !== null) ?? roleRows[0];
    const headers = headerRow ? readRowCells(headerRow) : [];
    const bodyRows = roleRows.filter((r) => r !== headerRow);
    const rows = bodyRows.map(readRowCells).filter((r) => r.some(Boolean));
    out.push({ headers, rows });
  }

  // 3. Modern online banking div/list feeds without <table> or ARIA grid roles
  const dateRe = /^(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})$/;
  const moneyRe = /^[+-]?\$?\d[\d,]*\.\d{2}$/;
  const headerDateRe = /\b(date|posted|day)\b/i;
  const headerDescRe = /\b(description|details|merchant|payee|memo|transaction|narrative|activity)\b/i;

  for (const container of document.querySelectorAll('div, ul, ol, section, main')) {
    if (container.closest('table, [role="table"], [role="grid"], [role="treegrid"]')) continue;
    const childRows = [...container.children].filter(
      (el) => el.children.length >= 3 && el.children.length <= 7 && !el.querySelector('table, [role="row"]'),
    );
    if (childRows.length < 2) continue;

    const matrix = childRows.map((rowEl) => [...rowEl.children].map((c) => clean(c.textContent)));
    const first = matrix[0];
    if (first.some((c) => headerDateRe.test(c)) && first.some((c) => headerDescRe.test(c))) {
      out.push({ headers: first, rows: matrix.slice(1) });
      continue;
    }

    // Headerless div list: infer Date, Description, Amount, and optional Balance columns from cell shapes
    const sampleRow = matrix.find(
      (r) => r.some((c) => dateRe.test(c)) && r.some((c) => moneyRe.test(c)),
    );
    if (!sampleRow) continue;
    const validRows = matrix.filter(
      (r) => r.length === sampleRow.length && r.some((c) => dateRe.test(c)) && r.some((c) => moneyRe.test(c)),
    );
    if (validRows.length < 2) continue;

    const dateIdx = sampleRow.findIndex((c) => dateRe.test(c));
    const moneyIndices = sampleRow
      .map((c, idx) => (moneyRe.test(c) ? idx : -1))
      .filter((idx) => idx >= 0);
    const descIdx = sampleRow.findIndex(
      (c, idx) => idx !== dateIdx && !moneyIndices.includes(idx) && c.length >= 3,
    );
    if (dateIdx < 0 || descIdx < 0 || !moneyIndices.length) continue;

    const headers = sampleRow.map((_, idx) => {
      if (idx === dateIdx) return 'Date';
      if (idx === descIdx) return 'Description';
      if (idx === moneyIndices[0]) return 'Amount';
      if (idx === moneyIndices[1]) return 'Balance';
      return `Col${idx}`;
    });
    out.push({ headers, rows: validRows });
  }

  return out;
}

const findCol = (headers: string[], re: RegExp) => headers.findIndex((h) => re.test(h));

/** Turns raw DOM tables into normalized StatementRows, picking the table with the most valid transactions. */
export function parseTablesToRows(tables: RawTable[]): StatementRow[] {
  let best: StatementRow[] = [];

  for (const t of tables) {
    const cols = t.headers.map((h) => h.trim().toLowerCase());
    const dateCol = findCol(cols, /\b(date|posted|day)\b/);
    const descCol = findCol(cols, /\b(description|details|merchant|payee|memo|transaction|narrative|activity)\b/);
    const amtCol = findCol(cols, /\b(amount|total|value|usd)\b/);
    const debitCol = findCol(cols, /\b(debit|withdrawal|charge|out|spent)\b/);
    const creditCol = findCol(cols, /\b(credit|deposit|payment|in|received)\b/);
    const curCol = findCol(cols, /\bcurrency\b/);
    const balCol = findCol(cols, /\bbalance\b/);

    if (dateCol < 0 || descCol < 0 || (amtCol < 0 && debitCol < 0 && creditCol < 0)) continue;

    const parsed: StatementRow[] = [];
    for (const r of t.rows) {
      try {
        const date = toIsoDate(r[dateCol] ?? '');
        const description = (r[descCol] ?? '').trim();
        if (!description) continue;
        let amountCents: number;
        if (amtCol >= 0) {
          amountCents = toCents(r[amtCol] ?? '');
        } else if (debitCol >= 0 && (r[debitCol] ?? '').trim()) {
          amountCents = -Math.abs(toCents(r[debitCol]));
        } else if (creditCol >= 0 && (r[creditCol] ?? '').trim()) {
          amountCents = Math.abs(toCents(r[creditCol]));
        } else {
          continue;
        }
        const currency = curCol >= 0 && r[curCol]?.trim() ? r[curCol].trim() : 'USD';
        const balanceCents = balCol >= 0 && r[balCol]?.trim() ? toCents(r[balCol]) : null;
        parsed.push({ date, description, amountCents, currency, balanceCents });
      } catch {
        // Skip non-transaction summary or header rows inside tbody.
      }
    }
    if (parsed.length > best.length) best = parsed;
  }

  if (!best.length) {
    throw new Error('No transaction table found on this page. Open a page with Date, Description and Amount columns, or drop a CSV file.');
  }
  return best;
}

interface ChromeTab {
  id?: number;
  url?: string;
  title?: string;
  active?: boolean;
}

interface ChromeApi {
  tabs?: {
    query(q: { active?: boolean; currentWindow?: boolean }): Promise<ChromeTab[]>;
  };
  scripting?: {
    executeScript(opts: { target: { tabId: number }; func: () => RawTable[] }): Promise<{ result?: RawTable[] }[]>;
  };
}

/** Extracts and normalizes the transaction table from the active web tab in Chrome. */
export async function auditActiveTabTable(): Promise<{ rows: StatementRow[]; name: string }> {
  const ch = (globalThis as unknown as { chrome?: ChromeApi }).chrome;
  if (!ch?.tabs || !ch?.scripting) {
    throw new Error('Chrome extension scripting API is not available in this window.');
  }
  let tabs = await ch.tabs.query({ currentWindow: true });
  let webTabs = tabs.filter((t) => t.id !== undefined && /^https?:\/\//.test(t.url ?? ''));
  if (!webTabs.length) {
    tabs = await ch.tabs.query({});
    webTabs = tabs.filter((t) => t.id !== undefined && /^https?:\/\//.test(t.url ?? ''));
  }
  const target = webTabs.find((t) => t.active) ?? webTabs[webTabs.length - 1];
  if (!target || target.id === undefined) {
    throw new Error('Open a web page with a transaction table first, then click Audit table on this page.');
  }
  const injected = await ch.scripting.executeScript({
    target: { tabId: target.id },
    func: grabTablesFromDom,
  });
  const tables = injected?.[0]?.result ?? [];
  return { rows: parseTablesToRows(tables), name: target.title?.trim() || 'Page transaction table' };
}
