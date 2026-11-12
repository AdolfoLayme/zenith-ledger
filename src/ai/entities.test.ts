import { describe, expect, it } from 'vitest';
import { acceptEntities } from './onDevice';

describe('on-device entities', () => {
  it('drops a merchant that is not in the line', () => {
    const e = acceptEntities('POS DEBIT DELTA OFFICE DEPOT #4411', { merchant: 'Green Table Cafe', persons: [], category: 'Supplies' });
    expect(e.merchant).toBeUndefined();
    expect(e.category).toBe('Supplies');
  });
  it('keeps a merchant and a person that are in the line, ignoring case', () => {
    const e = acceptEntities('ZELLE TO John Smith for DELTA OFFICE invoice', { merchant: 'delta office', persons: ['John Smith', 'Mary Jones'] });
    expect(e.merchant).toBe('delta office');
    expect(e.persons).toEqual(['John Smith']);
  });
});
