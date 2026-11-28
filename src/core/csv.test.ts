import { describe, expect, it } from 'vitest';
import { parseCsv, parseStatement, toCents } from './csv';

describe('parseCsv', () => {
  it('handles quoted commas, escaped quotes and CRLF', () => {
    const rows = parseCsv('a,b\r\n"x, y","say ""hi"""\r\n');
    expect(rows).toEqual([['a', 'b'], ['x, y', 'say "hi"']]);
  });
});

describe('toCents', () => {
  it('parses money without floats', () => {
    expect(toCents('-1,234.56')).toBe(-123456);
    expect(toCents('$12.5')).toBe(1250);
    expect(toCents('(10.00)')).toBe(-1000);
    expect(toCents('0.07')).toBe(7);
    expect(toCents('19.99')).toBe(1999);
  });
});

describe('parseStatement', () => {
  it('accepts ISO and MM/DD/YYYY dates and negative amounts', () => {
    const rows = parseStatement(
      'date,description,amount,currency,balance\n2025-07-01,"POS, shop",-20.50,USD,100.00\n07/02/2025,Deposit,5.00,USD,105.00\n',
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ date: '2025-07-01', description: 'POS, shop', amountCents: -2050, balanceCents: 10000 });
    expect(rows[1].date).toBe('2025-07-02');
  });
  it('rejects a file without the required columns', () => {
    expect(() => parseStatement('foo,bar\n1,2\n')).toThrow(/columns/i);
  });
});

describe('OFX / QFX import', () => {
  const sgml = `OFXHEADER:100
DATA:OFXSGML

<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD
<BANKTRANLIST><DTSTART>20250801
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20250811120000<TRNAMT>-184.20<FITID>2<NAME>DELTA OFFICE DEPOT<MEMO>order 77120</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20250810<TRNAMT>-184.20<FITID>1<NAME>DELTA OFFICE DEPOT<MEMO>order 77120</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20250812<TRNAMT>2131.39<FITID>3<NAME>Redwood Bakery</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
  it('reads SGML transactions in date order, in integer cents', () => {
    const rows = parseStatement(sgml);
    expect(rows.map((r) => [r.date, r.description, r.amountCents])).toEqual([
      ['2025-08-10', 'DELTA OFFICE DEPOT order 77120', -18420],
      ['2025-08-11', 'DELTA OFFICE DEPOT order 77120', -18420],
      ['2025-08-12', 'Redwood Bakery', 213139],
    ]);
    expect(rows.every((r) => r.balanceCents === null && r.currency === 'USD')).toBe(true);
  });
  it('reads XML-style OFX with closing tags', () => {
    const xml = '<OFX><CURDEF>EUR</CURDEF><STMTTRN><DTPOSTED>20250901</DTPOSTED><TRNAMT>-49.00</TRNAMT><NAME>CLOUDNEST HOSTING</NAME></STMTTRN></OFX>';
    expect(parseStatement(xml)).toEqual([{ date: '2025-09-01', description: 'CLOUDNEST HOSTING', amountCents: -4900, currency: 'EUR', balanceCents: null }]);
  });
});
