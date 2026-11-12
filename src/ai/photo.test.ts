import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PhotoNeedsOnDeviceError, readStatementPhoto } from './photo';
import type { OnDevice } from './types';

const png = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
const device = (rows: unknown): OnDevice & { readImage: ReturnType<typeof vi.fn> } => ({
  init: vi.fn(), alreadyAvailable: vi.fn(async () => true), extract: vi.fn(), summarize: vi.fn(), readImage: vi.fn(async () => rows),
});

describe('statement photos', () => {
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
    await expect(readStatementPhoto(png, null)).rejects.toBeInstanceOf(PhotoNeedsOnDeviceError);
    await expect(readStatementPhoto(png, null)).rejects.toThrow(/not sent anywhere/);
    nothingSent();
  });

  it('when the on-device model is not switched on yet, it is not even asked', async () => {
    const d = device([]);
    await expect(readStatementPhoto(png, d, false)).rejects.toBeInstanceOf(PhotoNeedsOnDeviceError);
    expect(d.readImage).not.toHaveBeenCalled();
    nothingSent();
  });

  it('only JPEG and PNG are accepted', async () => {
    const d = device([]);
    await expect(readStatementPhoto(new Blob(['x'], { type: 'image/heic' }), d, true)).rejects.toThrow(/JPEG or PNG/);
    expect(d.readImage).not.toHaveBeenCalled();
  });

  it('with the on-device model ready, its rows go into the normal pipeline shape', async () => {
    const d = device([{ date: '2025-07-14', description: 'CARD 4111111111111111 BRIGHTSIDE CAFE', amount: '-12.40' }]);
    const rows = await readStatementPhoto(png, d, true);
    expect(d.readImage).toHaveBeenCalledWith(png);
    expect(rows[0]).toMatchObject({ date: '2025-07-14', amountCents: -1240 });
    nothingSent();
  });
});
