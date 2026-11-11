import { toStatementRows } from '../core/csv';
import type { StatementRow } from '../core/types';
import type { OnDevice } from './types';

export const PHOTO_TYPES = ['image/jpeg', 'image/png'];

export class PhotoNeedsOnDeviceError extends Error {
  constructor() {
    super('Reading a photo needs the on-device model (Gemini Nano in desktop Chrome). Turn on on-device AI and try again. Your photo stayed on this device and was not sent anywhere.');
  }
}

/**
 * A statement photo is raw, unredacted data, so only the on-device model may read it.
 * There is no cloud path here: no on-device model means the photo is refused.
 */
export async function readStatementPhoto(image: Blob, onDevice: OnDevice | null, ready = false): Promise<StatementRow[]> {
  if (!PHOTO_TYPES.includes(image.type)) throw new Error('Use a JPEG or PNG photo.');
  if (!onDevice || !ready) throw new PhotoNeedsOnDeviceError();
  return toStatementRows(await onDevice.readImage(image));
}
