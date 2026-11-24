import type { CloudPayload } from '../core/payload';
import type { Signal } from '../core/analytics';
import type { CloudAuditor, CloudReport } from './types';

const usd = (c: number) => `$${(Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

function describe(s: Signal): { title: string; detail: string; severity: 'low' | 'medium' | 'high' } {
  switch (s.type) {
    case 'duplicate':
      if (s.exportDuplicate) return { title: `Likely export duplicate from ${s.vendor}, not a double charge`, detail: `The ${usd(s.amountCents)} line on ${s.dates[0]} appears twice but the running balance did not move.`, severity: 'low' };
      return { title: `Possible duplicate charge from ${s.vendor}`, detail: `${usd(s.amountCents)} charged on ${s.dates[0]} and again on ${s.dates[1]}.`, severity: 'high' };
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
        ...p.signals.flatMap((s) => (s.type === 'duplicate' && !s.exportDuplicate ? [`Can you confirm whether the two ${usd(s.amountCents)} charges from ${s.vendor} were both legitimate?`] : [])),
        ...p.signals.filter((s) => s.type === 'price_increase').map((s) => `Was the new price from ${s.vendor} agreed, and is the plan still needed?`),
        ...p.signals.filter((s) => s.type === 'round_transfer').map((s) => `What was the ${usd(s.amountCents)} transfer for on ${s.date}, and is it documented?`),
      ],
      narrative: `Between ${p.period.from} and ${p.period.to} there were ${p.totals.count} transactions: ${usd(p.totals.incomeCents)} in and ${usd(p.totals.expenseCents)} out. ${findings.length} items need a second look, starting with ${(p.signals.find((x) => x.type === 'duplicate' && !x.exportDuplicate) ?? p.signals[0])?.vendor ?? 'a few vendors'}.`,
    };
    return report;
  },
  async draftReply(packItemJson) {
    const item = JSON.parse(packItemJson) as {
      type: string;
      vendorAlias: string;
      proof: string;
      question: string;
    };
    await new Promise((r) => setTimeout(r, 200));
    const evidence = `Evidence: ${item.proof}.`;
    if (item.type === 'duplicate' && item.proof.includes('export duplicate')) {
      return `No payment to dispute for ${item.vendorAlias}: the bank export repeated the line. Ask the bank for a corrected export instead of treating it as a double charge. ${evidence}`;
    }
    if (item.type === 'duplicate') {
      return `Hold the second charge from ${item.vendorAlias} in Accounts Receivable — Disputed Charges until ${item.vendorAlias} confirms a refund or provides a second invoice. ${evidence}`;
    }
    if (item.type === 'balance_mismatch' || item.type === 'missing_page') {
      return `Do not close the period yet: request the full bank statement PDF to reconcile the missing balance movement. ${evidence}`;
    }
    if (item.type === 'date_gap' || item.type === 'incomplete_period') {
      return `Request the bank statement for the missing days before closing the period. ${evidence}`;
    }
    return `Reviewed ${item.vendorAlias}: keep the receipt or contract amendment attached to this entry for audit support. ${evidence}`;
  },
};
