import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCsv, parseStatement } from './csv';
import { buildDossiers, type AlertDecision } from './dossier';
import { buildAccountantCaseCsv, buildAccountantCaseJson } from './export';
import { analyzeLocally } from './pipeline';
import { DEFAULT_THRESHOLDS } from './thresholds';

describe('Accountant local CSV and JSON case export', () => {
  const rows = parseStatement(readFileSync('public/samples/acme-q3-gaps.csv', 'utf8'));
  const analysis = analyzeLocally(rows, { fileName: 'acme-q3-gaps.csv' });
  const dossiers = buildDossiers(analysis, DEFAULT_THRESHOLDS);
  const dup = dossiers.find((d) => d.type === 'duplicate')!;
  const bal = dossiers.find((d) => d.type === 'balance_mismatch')!;

  const decisions: Record<string, AlertDecision> = {
    [dup.id]: {
      alertId: dup.id,
      status: 'ask_accountant',
      note: 'Check duplicate invoice, store #12',
      updatedAt: '2026-11-24T16:00:00.000Z',
    },
    [bal.id]: {
      alertId: bal.id,
      status: 'explained',
      note: 'Bank export truncated one row.',
      updatedAt: '2026-11-24T16:05:00.000Z',
    },
  };

  it('builds a structured JSON case export containing alerts, evidence, origin rows, decisions and accountant replies', () => {
    const json = buildAccountantCaseJson(dossiers, decisions, {
      fileName: 'acme-q3-gaps.csv',
      period: analysis.period,
      currency: analysis.currency,
      aliases: analysis.aliases,
      replies: {
        [dup.id]: 'Hold the second charge in disputed receivables.',
      },
      generatedAt: '2026-11-24T16:10:00.000Z',
    });

    const parsed = JSON.parse(json) as {
      schema: string;
      generatedAt: string;
      fileName: string;
      alerts: {
        id: string;
        kind: string;
        type: string;
        decision: { status: string; note: string };
        accountantReply: string;
        evidence: {
          proof: string;
          ruleName: string;
          thresholdSummary: string;
          computed: { label: string; value: string }[];
          sourceRows: { line: number; date: string; amount: string }[];
        };
      }[];
    };

    expect(parsed.schema).toBe('zenith-ledger/accountant-export@1');
    expect(parsed.fileName).toBe('acme-q3-gaps.csv');
    expect(parsed.alerts).toHaveLength(dossiers.length);

    const dupItem = parsed.alerts.find((a) => a.id === dup.id)!;
    expect(dupItem.decision).toEqual({
      status: 'ask_accountant',
      note: 'Check duplicate invoice, store #12',
      updatedAt: '2026-11-24T16:00:00.000Z',
    });
    expect(dupItem.accountantReply).toBe('Hold the second charge in disputed receivables.');
    expect(dupItem.evidence.sourceRows).toHaveLength(2);
    expect(dupItem.evidence.ruleName).toContain('Duplicate');

    const balItem = parsed.alerts.find((a) => a.id === bal.id)!;
    expect(balItem.decision.status).toBe('explained');
    expect(balItem.evidence.proof).toContain('gap between rows 41–42');
  });

  it('builds a RFC-4180 CSV case export with headers and properly escaped commas/quotes', () => {
    const csv = buildAccountantCaseCsv(dossiers, decisions, {
      aliases: analysis.aliases,
      replies: {
        [dup.id]: 'Hold the second charge, request credit memo.',
      },
    });

    const table = parseCsv(csv);
    expect(table[0]).toEqual([
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
    ]);
    expect(table.length).toBe(dossiers.length + 1);

    const dupRow = table.find((r) => r[0] === dup.id)!;
    expect(dupRow[6]).toBe('ask_accountant');
    expect(dupRow[7]).toBe('Check duplicate invoice, store #12');
    expect(dupRow[8]).toBe('Hold the second charge, request credit memo.');
    expect(dupRow[13]).toContain('15');
  });
});
