import type { CloudPayload } from '../core/payload';
import type { Signal } from '../core/analytics';
import type { CloudAuditor, CloudReport } from './types';

const usd = (c: number) => `$${(Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

function describe(s: Signal): { title: string; detail: string; severity: 'low' | 'medium' | 'high' } {
  switch (s.type) {
    case 'duplicate': return { title: `Possible duplicate charge from ${s.vendor}`, detail: `${usd(s.amountCents)} charged on ${s.dates[0]} and again on ${s.dates[1]}.`, severity: 'high' };
    case 'price_increase': return { title: `${s.vendor} raised its price`, detail: `${usd(s.fromCents)} became ${usd(s.toCents)} on ${s.date}.`, severity: 'medium' };
    case 'outlier': return { title: `Unusually large ${s.category} expense at ${s.vendor}`, detail: `${usd(s.amountCents)} on ${s.date} (z-score ${s.zScore}).`, severity: 'high' };
    case 'round_transfer': return { title: `Round-number transfer to ${s.vendor}`, detail: `${usd(s.amountCents)} on ${s.date}.`, severity: 'medium' };
    case 'weekend_spend': return { title: `Weekend spend at ${s.vendor}`, detail: `${usd(s.amountCents)} on ${s.date} (${s.category}).`, severity: 'low' };
  }
}

/** Scripted stand-in for the cloud model. Reads the approved payload only, like the real one. */
export const fakeCloud: CloudAuditor = {
  async audit(json) {
    const p = JSON.parse(json) as CloudPayload;
    await new Promise((r) => setTimeout(r, 600));
    const findings = p.signals.map(describe);
    const report: CloudReport = {
      findings,
      questionsForAccountant: [
        ...p.signals.filter((s) => s.type === 'duplicate').map((s) => `Can you confirm whether the two ${usd(s.amountCents)} charges from ${s.vendor} were both legitimate?`),
        ...p.signals.filter((s) => s.type === 'price_increase').map((s) => `Was the new price from ${s.vendor} agreed, and is the plan still needed?`),
        ...p.signals.filter((s) => s.type === 'round_transfer').map((s) => `What was the ${usd(s.amountCents)} transfer for on ${s.date}, and is it documented?`),
      ],
      narrative: `Between ${p.period.from} and ${p.period.to} there were ${p.totals.count} transactions: ${usd(p.totals.incomeCents)} in and ${usd(p.totals.expenseCents)} out. ${findings.length} items need a second look, mostly around ${p.vendors[0]?.alias ?? 'a few vendors'} and other recurring vendors.`,
    };
    return report;
  },
};
