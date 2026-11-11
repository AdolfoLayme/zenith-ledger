import type { RowEntities } from '../core/types';

export interface CloudReport {
  findings: { title: string; detail: string; severity: 'low' | 'medium' | 'high' }[];
  questionsForAccountant: string[];
  narrative: string;
}

/** Runs on the device only. Sees raw descriptions, so it must never have a cloud path. */
export interface OnDevice {
  /** Needs a user gesture; the model download can take minutes. */
  init(onProgress: (fraction: number) => void): Promise<void>;
  /** One single-turn call per batch of up to 20 descriptions. */
  extract(descriptions: string[]): Promise<RowEntities[]>;
  /** Short offline summary of an already-redacted overview. */
  summarize(overview: string): Promise<string>;
  /** Reads transaction rows from a JPEG/PNG statement or receipt photo. Raw model output, normalized by the caller. */
  readImage(image: Blob): Promise<unknown>;
}

/** Receives only the payload the user approved in the Privacy Firewall. */
export interface CloudAuditor {
  audit(approvedPayloadJson: string): Promise<CloudReport>;
}

export const BATCH_SIZE = 20;
export const chunk = <T,>(xs: T[], n = BATCH_SIZE): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
