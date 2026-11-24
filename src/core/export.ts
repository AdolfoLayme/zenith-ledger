import type { AlertDecision, EvidenceDossier } from './dossier';
import { reidentify } from './pseudonymize';

export interface CaseExportOptions {
  fileName?: string;
  period?: { from: string; to: string };
  currency?: string;
  aliases?: Map<string, string>;
  replies?: Record<string, string>;
  generatedAt?: string;
}

const money = (cents: number) =>
  `${cents < 0 ? '-' : ''}${(Math.abs(cents) / 100).toFixed(2)}`;

const quoteCsv = (val: string) =>
  /[",\n\r]/.test(val) ? `"${val.replace(/"/g, '""')}"` : val;

export function buildAccountantCaseJson(
  dossiers: EvidenceDossier[],
  decisions: Record<string, AlertDecision>,
  opts: CaseExportOptions = {},
): string {
  const resolve = (text: string) => (opts.aliases ? reidentify(text, opts.aliases) : text);

  const payload = {
    schema: 'zenith-ledger/accountant-export@1',
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    fileName: opts.fileName ?? 'statement.csv',
    period: opts.period ?? { from: '', to: '' },
    currency: opts.currency ?? 'USD',
    alerts: dossiers.map((d) => {
      const dec = decisions[d.id];
      const reply = opts.replies?.[d.id] ?? '';
      return {
        id: d.id,
        kind: d.kind,
        type: d.type,
        severity: d.severity,
        title: resolve(d.title),
        vendor: resolve(d.vendorAlias),
        category: d.category,
        decision: {
          status: dec?.status ?? 'unreviewed',
          note: dec?.note ?? '',
          ...(dec?.updatedAt ? { updatedAt: dec.updatedAt } : {}),
        },
        accountantReply: reply ? resolve(reply) : '',
        evidence: {
          proof: resolve(d.proof),
          ruleName: d.rule.name,
          thresholdSummary: d.rule.thresholdSummary,
          computed: d.computed,
          sourceRows: d.sourceRows.map((r) => ({
            line: r.line,
            ...(r.page !== undefined ? { page: r.page } : {}),
            date: r.date,
            vendor: resolve(r.vendorAlias),
            category: r.category,
            amount: money(r.amountCents),
            balance: r.balanceCents !== null ? money(r.balanceCents) : '',
          })),
        },
      };
    }),
  };

  return JSON.stringify(payload, null, 2);
}

export function buildAccountantCaseCsv(
  dossiers: EvidenceDossier[],
  decisions: Record<string, AlertDecision>,
  opts: CaseExportOptions = {},
): string {
  const resolve = (text: string) => (opts.aliases ? reidentify(text, opts.aliases) : text);
  const header = [
    'alert_id',
    'kind',
    'type',
    'severity',
    'vendor',
    'category',
    'decision',
    'note',
    'accountant_reply',
    'rule',
    'threshold',
    'proof',
    'computed_evidence',
    'source_lines',
    'source_dates',
    'source_amounts',
  ];

  const lines = [header.join(',')];
  for (const d of dossiers) {
    const dec = decisions[d.id];
    const reply = opts.replies?.[d.id] ?? '';
    const row = [
      d.id,
      d.kind,
      d.type,
      d.severity,
      resolve(d.vendorAlias),
      d.category,
      dec?.status ?? 'unreviewed',
      dec?.note ?? '',
      reply ? resolve(reply) : '',
      d.rule.name,
      d.rule.thresholdSummary,
      resolve(d.proof),
      d.computed.map((m) => `${m.label}: ${m.value}`).join(' | '),
      d.sourceRows.map((r) => String(r.line)).join(';'),
      d.sourceRows.map((r) => r.date).join(';'),
      d.sourceRows.map((r) => money(r.amountCents)).join(';'),
    ];
    lines.push(row.map(quoteCsv).join(','));
  }

  return lines.join('\n') + '\n';
}
