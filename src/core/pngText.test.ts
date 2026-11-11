import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { addPngText, readPngText } from './pngText';

// smallest valid PNG: 1x1 transparent pixel
const tiny = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));

describe('PNG text chunks (demo photos carry their rows for the scripted stand-in)', () => {
  it('round-trips a tEXt chunk with a valid CRC, placed before IEND', () => {
    const out = addPngText(tiny, 'zenith-rows', '[{"a":1}]');
    expect(readPngText(out, 'zenith-rows')).toBe('[{"a":1}]');
    const i = Buffer.from(out).indexOf('tEXt');
    const len = new DataView(out.buffer).getUint32(i - 4);
    expect(new DataView(out.buffer).getUint32(i + 4 + len)).toBe(crc32(out.subarray(i, i + 4 + len)));
    expect(Buffer.from(out).indexOf('IEND')).toBeGreaterThan(i);
  });
  it('returns null for a missing key or a non-PNG file', () => {
    expect(readPngText(tiny, 'zenith-rows')).toBeNull();
    expect(readPngText(new Uint8Array([1, 2, 3]), 'zenith-rows')).toBeNull();
  });
});
