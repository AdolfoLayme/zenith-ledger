import type { RowEntities } from '../core/types';

export interface CloudReport {
  findings: { title: string; detail: string; severity: 'low' | 'medium' | 'high' }[];
  questionsForAccountant: string[];
  narrative: string;
}

export type PhotoKind = 'statement' | 'receipt';

/** Runs on the device only. Sees raw descriptions, so it must never have a cloud path. */
export interface OnDevice {
  /** Needs a user gesture; the model download can take minutes. */
  init(onProgress: (fraction: number) => void): Promise<void>;
  /** True when the model is already downloaded, so it can start without a click. */
  alreadyAvailable(): Promise<boolean>;
  /** One single-turn call per batch of up to 20 descriptions. */
  extract(descriptions: string[], onBatch?: (done: number, total: number) => void): Promise<RowEntities[]>;
  /** Short offline summary of an already-redacted overview. */
  summarize(overview: string): Promise<string>;
  /** Reads a JPEG/PNG photo of the given kind. Raw model output, validated by the caller (see photo.ts). */
  readImage(image: Blob, kind: PhotoKind): Promise<unknown>;
}

/** Receives only the payload the user approved in the Privacy Firewall. */
export interface CloudAuditor {
  audit(approvedPayloadJson: string, model: string): Promise<CloudReport>;
  /** Writes a draft accountant reply for one pseudonymized review pack alert item (aliases only). */
  draftReply(packItemJson: string, model: string): Promise<string>;
}

export const BATCH_SIZE = 20;
export const chunk = <T,>(xs: T[], n = BATCH_SIZE): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
