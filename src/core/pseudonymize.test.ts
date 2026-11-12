import { describe, expect, it } from 'vitest';
import { createAliaser, redact, reidentify } from './pseudonymize';

describe('aliaser', () => {
  it('gives the same value the same alias and numbers per type', () => {
    const a = createAliaser();
    expect(a.alias('person', 'John Smith')).toBe('Person_1');
    expect(a.alias('person', 'Maria Garcia')).toBe('Person_2');
    expect(a.alias('person', 'John Smith')).toBe('Person_1');
    expect(a.alias('vendor', 'ACME')).toBe('Vendor_A');
    expect(a.alias('vendor', 'BETA')).toBe('Vendor_B');
    expect(a.alias('card', '4111111111111111')).toBe('Card_1');
  });
  it('rolls vendor letters over after Z', () => {
    const a = createAliaser();
    for (let i = 0; i < 26; i++) a.alias('vendor', 'v' + i);
    expect(a.alias('vendor', 'next')).toBe('Vendor_AA');
  });
});

describe('redact / reidentify', () => {
  it('replaces spans and round-trips', () => {
    const a = createAliaser();
    const text = 'Zelle from john.smith@gmail.com, again john.smith@gmail.com';
    const out = redact(text, [
      { start: 11, end: 31, type: 'email', value: 'john.smith@gmail.com' },
      { start: 39, end: 59, type: 'email', value: 'john.smith@gmail.com' },
    ], a);
    expect(out).toBe('Zelle from Email_1, again Email_1');
    expect(reidentify(out, a.map)).toBe(text);
  });
  it('does not confuse Person_1 with Person_10', () => {
    const map = new Map([['Person_1', 'Ann'], ['Person_10', 'Bob']]);
    expect(reidentify('Person_10 and Person_1', map)).toBe('Bob and Ann');
  });
});

describe('reidentify with a pluralized alias', () => {
  it('restores "Vendors_C" as Vendor_C and leaves unknown aliases alone', () => {
    const map = new Map([['Vendor_C', 'CORNER BISTRO'], ['Person_1', 'Ana Ruiz']]);
    expect(reidentify('Spend at Vendors_C and Vendor_C, paid by Person_1, not Vendors_Z.', map))
      .toBe('Spend at CORNER BISTRO and CORNER BISTRO, paid by Ana Ruiz, not Vendors_Z.');
  });
});
