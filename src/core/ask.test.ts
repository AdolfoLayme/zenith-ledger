import { describe, expect, it } from 'vitest';
import { answerQuery, groundQuery, parseQuestionLocally, validateQuery } from './ask';
import type { AnalyzedRow } from './pipeline';

const CATS = ['Revenue', 'Supplies', 'Meals', 'Software', 'Insurance', 'Payroll', 'Utilities', 'Travel', 'Transfers', 'Other'];
const row = (index: number, date: string, description: string, amountCents: number, vendorAlias: string, category: string): AnalyzedRow => ({
  index, date, description, amountCents, balanceCents: null, spans: [], redacted: description, vendorAlias, category,
});
const rows = [
  row(1, '2025-08-10', 'POS DEBIT DELTA OFFICE DEPOT order 77120', -18420, 'Vendor_C', 'Supplies'),
  row(2, '2025-08-11', 'POS DEBIT DELTA OFFICE DEPOT order 77120', -18420, 'Vendor_C', 'Supplies'),
  row(3, '2025-08-14', 'NORTHWIND SOFTWARE license', -12900, 'Vendor_D', 'Software'),
  row(4, '2025-09-05', 'CLOUDNEST HOSTING subscription renewal', -5900, 'Vendor_F', 'Software'),
  row(5, '2025-08-20', 'ACH deposit Redwood Bakery inv 3112', 213139, 'Vendor_G', 'Revenue'),
];
const aliases = new Map([['Vendor_C', 'DELTA OFFICE DEPOT'], ['Vendor_D', 'NORTHWIND SOFTWARE'], ['Vendor_F', 'CLOUDNEST HOSTING'], ['Vendor_G', 'Redwood Bakery']]);

describe('validateQuery', () => {
  it('keeps a well-formed query and normalizes the category', () => {
    expect(validateQuery({ metric: 'sum', flow: 'out', category: 'software', month: '2025-08' }, CATS)).toEqual({ metric: 'sum', flow: 'out', category: 'Software', month: '2025-08' });
  });
  it('drops unknown metrics, categories and bad months', () => {
    expect(validateQuery({ metric: 'delete_all' }, CATS)).toBeNull();
    expect(validateQuery({ metric: 'count', category: 'Crypto', month: '2025-13' }, CATS)).toEqual({ metric: 'count', flow: 'any' });
    expect(validateQuery('sum', CATS)).toBeNull();
  });
});

describe('answerQuery', () => {
  it('sums spending in a category and month with code, not the model', () => {
    const a = answerQuery({ metric: 'sum', flow: 'out', category: 'Software', month: '2025-08' }, rows, aliases);
    expect(a.totalCents).toBe(-12900);
    expect(a.rows.map((r) => r.index)).toEqual([3]);
    expect(a.headline).toBe('You spent $129.00 in Software in August 2025 across 1 transaction.');
  });
  it('matches a merchant by its real name, kept only on the device', () => {
    const a = answerQuery({ metric: 'count', flow: 'out', vendor: 'Delta Office' }, rows, aliases);
    expect(a.rows.map((r) => r.index)).toEqual([1, 2]);
    expect(a.headline).toBe('2 transactions with Delta Office.');
  });
  it('finds the largest charge and income separately', () => {
    expect(answerQuery({ metric: 'largest', flow: 'out' }, rows, aliases).rows[0].index).toBe(1);
    expect(answerQuery({ metric: 'sum', flow: 'in' }, rows, aliases).headline).toBe('You received $2,131.39 across 1 transaction.');
  });
  it('says so when nothing matches', () => {
    expect(answerQuery({ metric: 'sum', flow: 'out', vendor: 'Acme Rockets' }, rows, aliases).headline).toBe('No transactions match with Acme Rockets.');
  });
});

describe('parseQuestionLocally', () => {
  const months = ['2025-07', '2025-08', '2025-09'];
  it('reads category, month and flow from keywords', () => {
    expect(parseQuestionLocally('How much did I spend on software in August?', CATS, months)).toEqual({ metric: 'sum', flow: 'out', category: 'Software', month: '2025-08' });
  });
  it('reads a merchant name and a count', () => {
    expect(parseQuestionLocally('How many times did we pay Delta Office Depot?', CATS, months)).toMatchObject({ metric: 'count', flow: 'out', vendor: 'Delta Office Depot' });
    expect(parseQuestionLocally('What did we pay to Delta Office Depot in August?', CATS, months)).toMatchObject({ vendor: 'Delta Office Depot', month: '2025-08' });
  });
});

describe('groundQuery', () => {
  it('drops filters the question never mentioned', () => {
    expect(groundQuery({ metric: 'count', flow: 'out', vendor: 'Delta Office Depot', category: 'Supplies', month: '2025-07' }, 'How many times did we pay Delta Office Depot?')).toEqual({ metric: 'count', flow: 'out', vendor: 'Delta Office Depot' });
    expect(groundQuery({ metric: 'largest', flow: 'out', category: 'Other', month: '2025-09' }, 'What was our largest charge in September?')).toEqual({ metric: 'largest', flow: 'out', month: '2025-09' });
  });
  it('keeps filters said with other words', () => {
    expect(groundQuery({ metric: 'sum', flow: 'in', category: 'Revenue', vendor: 'Redwood Bakery', month: '2025-07' }, 'how much revenue did Redwood Bakery pay us in july')).toEqual({ metric: 'sum', flow: 'in', category: 'Revenue', vendor: 'Redwood Bakery', month: '2025-07' });
  });
});
