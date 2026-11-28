/** Every model call, where it ran, and how many bytes left the device. Kept in memory for this tab only. */
export interface TraceEvent {
  at: number;
  where: 'device' | 'cloud';
  mode: 'ONLY_ON_DEVICE' | 'ONLY_IN_CLOUD';
  task: string;
  /** Bytes of request body that left this device. Always 0 for on-device calls. */
  bytesOut: number;
  ms: number;
  ok: boolean;
}

const events: TraceEvent[] = [];
const listeners = new Set<() => void>();

export function record(e: TraceEvent): void {
  events.push(e);
  listeners.forEach((l) => l());
}

export function traceEvents(): readonly TraceEvent[] {
  return events;
}

export function subscribeTrace(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Times a model call and records it, success or failure. */
export async function traced<T>(where: TraceEvent['where'], task: string, bytesOut: number, call: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  const base = { at: Date.now(), where, mode: where === 'device' ? 'ONLY_ON_DEVICE' : 'ONLY_IN_CLOUD', task, bytesOut: where === 'device' ? 0 : bytesOut } as const;
  try {
    const out = await call();
    record({ ...base, ms: Math.round(performance.now() - t0), ok: true });
    return out;
  } catch (err) {
    record({ ...base, ms: Math.round(performance.now() - t0), ok: false });
    throw err;
  }
}

export const traceTotals = (es: readonly TraceEvent[]) => ({
  device: es.filter((e) => e.where === 'device').length,
  cloud: es.filter((e) => e.where === 'cloud').length,
  bytesOut: es.reduce((s, e) => s + e.bytesOut, 0),
});
