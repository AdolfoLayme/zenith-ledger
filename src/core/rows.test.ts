import { describe, expect, it } from 'vitest';
import { toStatementRows } from './csv';

describe('rows read from a photo', () => {
  it('normalize dates and amounts like the CSV parser', () => {
    const rows = toStatementRows([
      { date: '07/14/2025', description: 'POS DEBIT BRIGHTSIDE CAFE', amount: '-12.40' },
      { date: '2025-07-15', description: 'Zelle payment from Sarah Johnson', amount: 808.36 },
    ]);
    expect(rows).toEqual([
      { date: '2025-07-14', description: 'POS DEBIT BRIGHTSIDE CAFE', amountCents: -1240, currency: 'USD', balanceCents: null },
      { date: '2025-07-15', description: 'Zelle payment from Sarah Johnson', amountCents: 80836, currency: 'USD', balanceCents: null },
    ]);
  });
  it('drop rows the model could not read and fail when none are left', () => {
    expect(toStatementRows([{ date: 'yesterday', description: 'x', amount: '1' }, { date: '2025-07-15', description: 'ok', amount: '-3' }])).toHaveLength(1);
    expect(() => toStatementRows([{ date: '??', description: '', amount: 'n/a' }])).toThrow(/No transactions/);
    expect(() => toStatementRows('not an array')).toThrow(/No transactions/);
  });
});
