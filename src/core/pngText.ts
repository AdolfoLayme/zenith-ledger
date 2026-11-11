// Minimal PNG tEXt chunk reader/writer. Used only for the bundled synthetic demo photos:
// they carry their own rows so the scripted stand-in can "read" them without a model.

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
const latin1 = (b: Uint8Array) => String.fromCharCode(...b);

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Uint8Array) => {
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

export function readPngText(png: Uint8Array, key: string): string | null {
  if (png.length < 8 || SIG.some((v, i) => png[i] !== v)) return null;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  for (let p = 8; p + 8 <= png.length;) {
    const len = view.getUint32(p);
    const type = latin1(png.subarray(p + 4, p + 8));
    if (type === 'tEXt') {
      const data = png.subarray(p + 8, p + 8 + len);
      const nul = data.indexOf(0);
      if (nul > 0 && latin1(data.subarray(0, nul)) === key) return new TextDecoder().decode(data.subarray(nul + 1));
    }
    if (type === 'IEND') break;
    p += 12 + len;
  }
  return null;
}

/** Inserts a tEXt chunk right before IEND. Text is stored as UTF-8 bytes (keep it ASCII). */
export function addPngText(png: Uint8Array, key: string, text: string): Uint8Array {
  const body = new Uint8Array([...new TextEncoder().encode(key), 0, ...new TextEncoder().encode(text)]);
  const chunk = new Uint8Array(12 + body.length);
  const v = new DataView(chunk.buffer);
  v.setUint32(0, body.length);
  chunk.set([...'tEXt'].map((c) => c.charCodeAt(0)), 4);
  chunk.set(body, 8);
  v.setUint32(8 + body.length, crc32(chunk.subarray(4, 8 + body.length)));
  const iend = png.length - 12;
  const out = new Uint8Array(png.length + chunk.length);
  out.set(png.subarray(0, iend));
  out.set(chunk, iend);
  out.set(png.subarray(iend), iend + chunk.length);
  return out;
}
