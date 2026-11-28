import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeLocally } from '../core/pipeline';
import { misreadCard, PhotoNeedsOnDeviceError, readPhoto, receiptFromModel, rowsFromReview, statementFromModel } from './photo';
import type { OnDevice } from './types';

const png = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
const device = (raw: unknown): OnDevice & { readImage: ReturnType<typeof vi.fn> } => ({
  init: vi.fn(), alreadyAvailable: vi.fn(async () => true), extract: vi.fn(), summarize: vi.fn(), readImage: vi.fn(async () => raw), parseQuestion: vi.fn(),
});

describe('statement and receipt photos', () => {
  const network = { fetch: vi.fn(), sendBeacon: vi.fn(), xhr: vi.fn() };
  beforeEach(() => {
    vi.stubGlobal('fetch', network.fetch);
    vi.stubGlobal('XMLHttpRequest', network.xhr);
    vi.stubGlobal('navigator', { sendBeacon: network.sendBeacon });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
  const nothingSent = () => {
    expect(network.fetch).not.toHaveBeenCalled();
    expect(network.xhr).not.toHaveBeenCalled();
    expect(network.sendBeacon).not.toHaveBeenCalled();
  };

  it('without an on-device model the photo is refused and nothing touches the network', async () => {
    await expect(readPhoto(png, 'statement', null)).rejects.toBeInstanceOf(PhotoNeedsOnDeviceError);
    await expect(readPhoto(png, 'receipt', null)).rejects.toThrow(/not sent anywhere/);
    nothingSent();
  });

  it('when the on-device model is not switched on yet, it is not even asked', async () => {
    const d = device([]);
    await expect(readPhoto(png, 'statement', d, false)).rejects.toBeInstanceOf(PhotoNeedsOnDeviceError);
    expect(d.readImage).not.toHaveBeenCalled();
    nothingSent();
  });

  it('only JPEG and PNG are accepted', async () => {
    const d = device([]);
    await expect(readPhoto(new Blob(['x'], { type: 'image/heic' }), 'statement', d, true)).rejects.toThrow(/JPEG or PNG/);
    expect(d.readImage).not.toHaveBeenCalled();
  });

  it('the model is told which kind of photo it reads, and its rows come back in the pipeline shape', async () => {
    const d = device({ visibleRows: 1, rows: [{ line: 1, text: '2025-07-14 CARD 4111111111111111 BRIGHTSIDE CAFE -12.40' }] });
    const read = await readPhoto(png, 'statement', d, true);
    expect(d.readImage).toHaveBeenCalledWith(png, 'statement');
    expect(read.rows[0]).toMatchObject({ date: '2025-07-14', amountCents: -1240 });
    nothingSent();
  });

  it('a receipt photo becomes one row', async () => {
    const d = device({ merchant: 'BRIGHTSIDE CAFE', date: '09/03/2025', total: '18.75', cardLast4: '1111', payerName: 'Emily Carter', payerEmail: 'emily.carter@gmail.com' });
    const read = await readPhoto(png, 'receipt', d, true);
    expect(d.readImage).toHaveBeenCalledWith(png, 'receipt');
    expect(read.rows).toHaveLength(1);
    nothingSent();
  });
});

describe('statement rows read by the model', () => {
  // the model copies each printed row as one line of text; the code splits date, description and amount
  const row = (line: number, date: string, amount: string, description = `ROW ${line}`) => ({ line, text: `${date} ${description} ${amount}` });

  it('keeps valid rows in line order', () => {
    const read = statementFromModel({ visibleRows: 3, rows: [row(2, '09/03/2025', '-18.75'), row(1, '09/02/2025', '2,140.00'), row(3, '2025-09-04', '-450.00')] });
    expect(read.rows.map((r) => [r.date, r.description, r.amountCents])).toEqual([
      ['2025-09-02', 'ROW 1', 214000], ['2025-09-03', 'ROW 2', -1875], ['2025-09-04', 'ROW 3', -45000],
    ]);
    expect(read.warning).toBe('');
  });

  it('drops rows whose date does not parse or is not a real day', () => {
    const read = statementFromModel({ rows: [row(1, 'Sep 3', '-1.00'), row(2, '13/45/2025', '-1.00'), row(3, '02/30/2025', '-1.00'), row(4, '09/03/2025', '-1.00')] });
    expect(read.rows.map((r) => r.description)).toEqual(['ROW 4']);
  });

  it('drops rows whose amount is not a plain number', () => {
    const read = statementFromModel({ rows: [row(1, '09/03/2025', '-1O0.00'), row(2, '09/03/2025', 'n/a'), row(3, '09/03/2025', '-18.75 USD'), row(4, '09/03/2025', '$1,000.00'), row(5, '09/03/2025', '-236.40')] });
    expect(read.rows.map((r) => [r.description, r.amountCents])).toEqual([['ROW 4', 100000], ['ROW 5', -23640]]);
  });

  it('a row whose amount is missing is dropped, not read from a number inside the description', () => {
    const read = statementFromModel({ rows: [{ line: 1, text: '09/02/2025 ACH deposit Summit Fitness Co inv 3120' }, { line: 2, text: '09/03/2025 POS DEBIT\nBRIGHTSIDE CAFE\n-18.75' }] });
    expect(read.rows.map((r) => [r.description, r.amountCents])).toEqual([['POS DEBIT BRIGHTSIDE CAFE', -1875]]);
  });

  it('footer lines without a date are not transactions', () => {
    const read = statementFromModel({ visibleRows: 1, rows: [row(1, '09/02/2025', '1.00'), { line: 2, text: 'Page 1 of 1 · Member FDIC' }] });
    expect(read.rows).toHaveLength(1);
    expect(read.warning).toBe('');
  });

  it('drops rows without a description and repeated line numbers', () => {
    const read = statementFromModel({ rows: [row(1, '09/03/2025', '-1.00', ' '), row(2, '09/03/2025', '-2.00'), row(2, '09/04/2025', '-9.00', 'DUP')] });
    expect(read.rows.map((r) => r.description)).toEqual(['ROW 2']);
  });

  it('warns when the rows kept do not match the rows the model saw', () => {
    const read = statementFromModel({ visibleRows: 11, rows: [row(1, '09/02/2025', '1.00'), row(2, 'bad', '1.00')] });
    expect(read.rows).toHaveLength(1);
    expect(read.warning).toMatch(/11 rows/);
    expect(read.warning).toMatch(/read 1/);
  });

  it('fails clearly when nothing valid is left', () => {
    expect(() => statementFromModel({ rows: [row(1, '??', 'n/a')] })).toThrow(/No transactions/);
    expect(() => statementFromModel('garbage')).toThrow(/No transactions/);
  });
});

describe('receipt fields read by the model', () => {
  const fields = { merchant: 'BRIGHTSIDE CAFE', date: '09/03/2025', total: '18.75', cardLast4: '1111', payerName: 'Emily Carter', payerEmail: 'emily.carter@gmail.com' };

  it('build exactly one spending row from the fields', () => {
    const read = receiptFromModel(fields);
    expect(read.rows).toEqual([{ date: '2025-09-03', description: 'BRIGHTSIDE CAFE card ****1111 paid by Emily Carter emily.carter@gmail.com', amountCents: -1875, currency: 'USD', balanceCents: null }]);
    expect(read.persons).toEqual(['Emily Carter']);
  });

  it('the payer name and email are replaced by the usual detectors and aliases', () => {
    const read = receiptFromModel(fields);
    const a = analyzeLocally(read.rows, { entities: [{ persons: read.persons }] });
    expect(a.rows[0].redacted).not.toContain('Emily Carter');
    expect(a.rows[0].redacted).not.toContain('emily.carter@gmail.com');
    expect(a.rows[0].spans.map((s) => s.type).sort()).toEqual(['email', 'person']);
  });

  it('a date printed with the time still reads as that day', () => {
    expect(receiptFromModel({ ...fields, date: '09/03/2025 08:14' }).rows[0].date).toBe('2025-09-03');
  });

  it('a total printed with a minus sign or a dollar sign is still money going out', () => {
    expect(receiptFromModel({ ...fields, total: '-18.75' }).rows[0].amountCents).toBe(-1875);
    expect(receiptFromModel({ ...fields, total: '$1,018.75' }).rows[0].amountCents).toBe(-101875);
  });

  it('leaves out the parts the receipt does not have', () => {
    const read = receiptFromModel({ ...fields, cardLast4: 'n/a', payerName: '', payerEmail: 'none' });
    expect(read.rows[0].description).toBe('BRIGHTSIDE CAFE');
    expect(read.persons).toEqual([]);
  });

  it('without a valid total or date it fails clearly and nothing is built', () => {
    for (const bad of [{ total: '' }, { total: 'eighteen' }, { total: '0.00' }, { date: '' }, { date: '31/31/2025' }]) {
      expect(() => receiptFromModel({ ...fields, ...bad })).toThrow(/total and date/);
    }
    expect(() => receiptFromModel(null)).toThrow(/total and date/);
  });
});

describe('rows corrected on the review screen', () => {
  it('become pipeline rows', () => {
    expect(rowsFromReview([{ date: '2025-09-13', description: 'POS DEBIT HARBOR GRILL dinner', amount: '-236.40' }]))
      .toEqual([{ date: '2025-09-13', description: 'POS DEBIT HARBOR GRILL dinner', amountCents: -23640, currency: 'USD', balanceCents: null }]);
  });

  it('a row left invalid is named instead of silently dropped', () => {
    expect(() => rowsFromReview([{ date: '2025-09-13', description: 'ok', amount: '-1.00' }, { date: '2025-09-14', description: 'x', amount: 'abc' }])).toThrow(/Row 2/);
    expect(() => rowsFromReview([])).toThrow(/at least one/);
  });
});

describe('card numbers the model may have misread', () => {
  it('a card number with a digit missing is flagged, so the user fixes it before it slips past the card detector', () => {
    expect(misreadCard('POS DEBIT BRIGHTSIDE CAFE card 411111111111111')).toBe(true);
    expect(misreadCard('POS DEBIT BRIGHTSIDE CAFE card 411111111111')).toBe(true);
    expect(misreadCard('POS DEBIT BRIGHTSIDE CAFE card 41111111111')).toBe(true);
  });
  it('a valid card number, an account number or a short reference is not flagged', () => {
    expect(misreadCard('POS DEBIT BRIGHTSIDE CAFE card 4111111111111111')).toBe(false);
    expect(misreadCard('ONLINE TRANSFER TO SAVINGS acct 778120045533')).toBe(false);
    expect(misreadCard('POS DEBIT DELTA OFFICE DEPOT order 7712')).toBe(false);
    expect(misreadCard('Wire to Hans Meyer IBAN GB82WEST12345698765432 contractor')).toBe(false);
  });
});
