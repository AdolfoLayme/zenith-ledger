import { detectPii } from '../core/detectors';
import type { AlertDecision, EvidenceDossier } from '../core/dossier';
import { countRawLeaks, sha256Hex } from '../core/payload';
import type { LocalAnalysis } from '../core/pipeline';

export const PACK_KEYS = [
  'schema',
  'packId',
  'createdAt',
  'expiresAt',
  'expiresAtMs',
  'currency',
  'periodFrom',
  'periodTo',
  'totalStatementRows',
  'selectedAlertCount',
  'selectedRowCount',
  'hash',
  'items',
  'uid',
] as const;

export const PACK_ITEM_KEYS = [
  'alertId',
  'kind',
  'type',
  'severity',
  'vendorAlias',
  'category',
  'title',
  'proof',
  'ruleName',
  'thresholdSummary',
  'computedSummary',
  'question',
  'rows',
] as const;

export const PACK_ROW_KEYS = [
  'line',
  'page',
  'date',
  'vendorAlias',
  'category',
  'amountCents',
  'balanceCents',
] as const;

export const REPLY_KEYS = ['alertId', 'packId', 'reply', 'repliedAt', 'author'] as const;

export interface PackRow {
  line: number;
  page?: number;
  date: string;
  vendorAlias: string;
  category: string;
  amountCents: number;
  balanceCents: number | null;
}

export interface PackItem {
  alertId: string;
  kind: 'anomaly' | 'integrity' | 'comparison';
  type: string;
  severity: 'high' | 'medium' | 'low';
  vendorAlias: string;
  category: string;
  title: string;
  proof: string;
  ruleName: string;
  thresholdSummary: string;
  computedSummary: string;
  question: string;
  rows: PackRow[];
}

export interface AccountantPackDoc {
  schema: 'zenith-ledger/accountant-pack@1';
  packId: string;
  createdAt: string;
  expiresAt: string;
  expiresAtMs: number;
  currency: string;
  periodFrom: string;
  periodTo: string;
  totalStatementRows: number;
  selectedAlertCount: number;
  selectedRowCount: number;
  hash: string;
  items: PackItem[];
  uid?: string;
}

export interface PackReply {
  alertId: string;
  packId: string;
  reply: string;
  repliedAt: string;
  author: string;
}

export interface PackCounters {
  selectedAlerts: number;
  selectedRows: number;
  unselectedRowsExcluded: number;
  piiReplaced: number;
  rawDescriptionsSent: number;
}

export interface BuiltAccountantPack {
  pack: AccountantPackDoc;
  json: string;
  hash: string;
  counters: PackCounters;
}

export interface PackStore {
  create(pack: AccountantPackDoc): Promise<void>;
  get(packId: string): Promise<{ pack: AccountantPackDoc; replies: PackReply[] } | null>;
  reply(packId: string, reply: PackReply): Promise<void>;
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const VENDOR_ALIAS = /^(Vendor_[A-Z]+|Statement)$/;
const ROW_VENDOR_ALIAS = /^Vendor_[A-Z]+$/;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Replaces any real names or deterministic PII inside a free-text question with their local aliases. */
export function sanitizeQuestion(raw: string, aliases: Map<string, string>): string {
  let out = raw.trim();
  if (!out) return 'Please advise on accounting treatment and required documentation.';
  // 1. Replace deterministic PII spans with aliases if known, or [redacted]
  const reverse = new Map<string, string>();
  for (const [alias, original] of aliases) {
    if (original.trim()) reverse.set(original.trim().toLowerCase(), alias);
  }
  const spans = detectPii(out);
  if (spans.length) {
    let buf = '';
    let pos = 0;
    for (const s of [...spans].sort((a, b) => a.start - b.start)) {
      const replacement = reverse.get(s.value.trim().toLowerCase()) ?? `[redacted-${s.type}]`;
      buf += out.slice(pos, s.start) + replacement;
      pos = s.end;
    }
    out = buf + out.slice(pos);
  }
  // 2. Replace any known vendor/person/entity original values (longest first) with their alias
  const entries = [...aliases.entries()]
    .filter(([, orig]) => orig.trim().length >= 3)
    .sort((a, b) => b[1].length - a[1].length);
  for (const [alias, orig] of entries) {
    out = out.replace(new RegExp(escapeRe(orig.trim()), 'gi'), alias);
  }
  // 3. Catch any remaining capitalized full person name after common prepositions/conjunctions and alias it locally
  const personCount = [...aliases.keys()].filter((k) => k.startsWith('Person_')).length;
  let nextPerson = personCount + 1;
  out = out.replace(/\b(from|to|by|pay|with|or|ask|for)\s+([A-Z][a-z]{2,}\s+[A-Z][a-z]{2,})\b/g, (_m, prep: string, name: string) => {
    const existing = reverse.get(name.toLowerCase());
    if (existing) return `${prep} ${existing}`;
    const alias = `Person_${nextPerson++}`;
    aliases.set(alias, name);
    reverse.set(name.toLowerCase(), alias);
    return `${prep} ${alias}`;
  });
  return out.slice(0, 500);
}

export async function buildAccountantPack(
  analysis: LocalAnalysis,
  dossiers: EvidenceDossier[],
  decisions: Record<string, AlertDecision>,
  opts: { nowMs?: number; ttlMs?: number } = {},
): Promise<BuiltAccountantPack> {
  const chosen = dossiers.filter((d) => decisions[d.id]?.status === 'ask_accountant');
  if (!chosen.length) {
    throw new Error('Mark at least one alert as "Ask my accountant" before building a review pack.');
  }

  const nowMs = opts.nowMs ?? Date.now();
  const ttlMs = opts.ttlMs ?? 7 * 86400000;
  const createdAt = new Date(nowMs).toISOString();
  const expiresAtMs = nowMs + ttlMs;
  const expiresAt = new Date(expiresAtMs).toISOString();

  const distinctLines = new Set<number>();
  const items: PackItem[] = chosen.map((d) => {
    const rows: PackRow[] = d.sourceRows.map((sr) => {
      distinctLines.add(sr.line);
      return {
        line: sr.line,
        ...(sr.page !== undefined ? { page: sr.page } : {}),
        date: sr.date,
        vendorAlias: sr.vendorAlias,
        category: sr.category,
        amountCents: sr.amountCents,
        balanceCents: sr.balanceCents,
      };
    });
    return {
      alertId: d.id,
      kind: d.kind,
      type: d.type,
      severity: d.severity,
      vendorAlias: d.vendorAlias,
      category: d.category,
      title: d.title,
      proof: d.proof,
      ruleName: d.rule.name,
      thresholdSummary: d.rule.thresholdSummary,
      computedSummary: d.computed.map((m) => `${m.label}: ${m.value}`).join(' · '),
      question: sanitizeQuestion(decisions[d.id]?.note ?? '', analysis.aliases),
      rows,
    };
  });

  const bodyForHash = {
    schema: 'zenith-ledger/accountant-pack@1' as const,
    createdAt,
    expiresAt,
    expiresAtMs,
    currency: analysis.currency,
    periodFrom: analysis.period.from,
    periodTo: analysis.period.to,
    totalStatementRows: analysis.rows.length,
    selectedAlertCount: items.length,
    selectedRowCount: distinctLines.size,
    items,
  };

  const hashInput = JSON.stringify(bodyForHash, null, 2);
  const hash = await sha256Hex(hashInput);
  const packId = `${nowMs}-${hash.slice(0, 16)}`;

  const pack: AccountantPackDoc = {
    schema: 'zenith-ledger/accountant-pack@1',
    packId,
    createdAt,
    expiresAt,
    expiresAtMs,
    currency: analysis.currency,
    periodFrom: analysis.period.from,
    periodTo: analysis.period.to,
    totalStatementRows: analysis.rows.length,
    selectedAlertCount: items.length,
    selectedRowCount: distinctLines.size,
    hash,
    items,
  };

  const json = JSON.stringify(pack, null, 2);
  const rawDescriptionsSent = countRawLeaks(
    json,
    analysis.rows.map((r) => r.description),
  );

  return {
    pack,
    json,
    hash,
    counters: {
      selectedAlerts: items.length,
      selectedRows: distinctLines.size,
      unselectedRowsExcluded: Math.max(0, analysis.rows.length - distinctLines.size),
      piiReplaced: analysis.counters.piiReplaced,
      rawDescriptionsSent,
    },
  };
}

export function isPackExpired(pack: Pick<AccountantPackDoc, 'expiresAtMs'>, nowMs = Date.now()): boolean {
  return pack.expiresAtMs <= nowMs;
}

const hasOnlyKeys = (o: Record<string, unknown>, allowed: readonly string[]) => {
  const set = new Set(allowed);
  return Object.keys(o).every((k) => set.has(k));
};

function parsePackRow(raw: unknown): PackRow | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (!hasOnlyKeys(o, PACK_ROW_KEYS)) return null;
  if (typeof o.line !== 'number' || !Number.isInteger(o.line) || o.line < 1 || o.line > 1_000_000) return null;
  if (o.page !== undefined && (typeof o.page !== 'number' || !Number.isInteger(o.page) || o.page < 1 || o.page > 10_000)) return null;
  if (typeof o.date !== 'string' || !ISO_DATE.test(o.date)) return null;
  if (typeof o.vendorAlias !== 'string' || !ROW_VENDOR_ALIAS.test(o.vendorAlias)) return null;
  if (typeof o.category !== 'string' || !o.category || o.category.length > 40) return null;
  if (typeof o.amountCents !== 'number' || !Number.isInteger(o.amountCents)) return null;
  if (o.balanceCents !== null && (typeof o.balanceCents !== 'number' || !Number.isInteger(o.balanceCents))) return null;
  return {
    line: o.line,
    ...(o.page !== undefined ? { page: o.page } : {}),
    date: o.date,
    vendorAlias: o.vendorAlias,
    category: o.category,
    amountCents: o.amountCents,
    balanceCents: o.balanceCents,
  };
}

function parsePackItem(raw: unknown): PackItem | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (!hasOnlyKeys(o, PACK_ITEM_KEYS)) return null;
  if (typeof o.alertId !== 'string' || o.alertId.length < 3 || o.alertId.length > 160) return null;
  if (o.kind !== 'anomaly' && o.kind !== 'integrity' && o.kind !== 'comparison') return null;
  if (typeof o.type !== 'string' || !o.type || o.type.length > 40) return null;
  if (o.severity !== 'high' && o.severity !== 'medium' && o.severity !== 'low') return null;
  if (typeof o.vendorAlias !== 'string' || !VENDOR_ALIAS.test(o.vendorAlias)) return null;
  if (typeof o.category !== 'string' || !o.category || o.category.length > 40) return null;
  if (typeof o.title !== 'string' || !o.title || o.title.length > 160) return null;
  if (typeof o.proof !== 'string' || !o.proof || o.proof.length > 300) return null;
  if (typeof o.ruleName !== 'string' || !o.ruleName || o.ruleName.length > 120) return null;
  if (typeof o.thresholdSummary !== 'string' || !o.thresholdSummary || o.thresholdSummary.length > 160) return null;
  if (typeof o.computedSummary !== 'string' || !o.computedSummary || o.computedSummary.length > 400) return null;
  if (typeof o.question !== 'string' || !o.question || o.question.length > 500) return null;
  if (!Array.isArray(o.rows) || o.rows.length < 1 || o.rows.length > 20) return null;
  const rows: PackRow[] = [];
  for (const r of o.rows) {
    const parsed = parsePackRow(r);
    if (!parsed) return null;
    rows.push(parsed);
  }
  return {
    alertId: o.alertId,
    kind: o.kind,
    type: o.type,
    severity: o.severity,
    vendorAlias: o.vendorAlias,
    category: o.category,
    title: o.title,
    proof: o.proof,
    ruleName: o.ruleName,
    thresholdSummary: o.thresholdSummary,
    computedSummary: o.computedSummary,
    question: o.question,
    rows,
  };
}

/** Validates and strips an Accountant Review Pack down to the allowlisted schema, or returns null if invalid. */
export function parseAccountantPack(raw: unknown): AccountantPackDoc | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (!hasOnlyKeys(o, PACK_KEYS)) return null;
  if (o.schema !== 'zenith-ledger/accountant-pack@1') return null;
  if (typeof o.hash !== 'string' || !SHA256.test(o.hash)) return null;
  if (typeof o.packId !== 'string' || !new RegExp(`^[0-9]{10,15}-${o.hash.slice(0, 16)}$`).test(o.packId)) return null;
  if (typeof o.createdAt !== 'string' || !ISO_UTC.test(o.createdAt)) return null;
  if (typeof o.expiresAt !== 'string' || !ISO_UTC.test(o.expiresAt)) return null;
  if (typeof o.expiresAtMs !== 'number' || !Number.isInteger(o.expiresAtMs)) return null;
  if (o.expiresAtMs <= Date.parse(o.createdAt)) return null;
  if (typeof o.currency !== 'string' || o.currency.length !== 3) return null;
  if (typeof o.periodFrom !== 'string' || !ISO_DATE.test(o.periodFrom)) return null;
  if (typeof o.periodTo !== 'string' || !ISO_DATE.test(o.periodTo)) return null;
  if (typeof o.totalStatementRows !== 'number' || !Number.isInteger(o.totalStatementRows) || o.totalStatementRows < 1) return null;
  if (typeof o.selectedAlertCount !== 'number' || !Number.isInteger(o.selectedAlertCount) || o.selectedAlertCount < 1 || o.selectedAlertCount > 50) return null;
  if (typeof o.selectedRowCount !== 'number' || !Number.isInteger(o.selectedRowCount) || o.selectedRowCount < 1 || o.selectedRowCount > 200) return null;
  if (!Array.isArray(o.items) || o.items.length !== o.selectedAlertCount) return null;
  if (o.uid !== undefined && (typeof o.uid !== 'string' || !o.uid || o.uid.length > 128)) return null;

  const items: PackItem[] = [];
  for (const it of o.items) {
    const parsed = parsePackItem(it);
    if (!parsed) return null;
    items.push(parsed);
  }

  return {
    schema: 'zenith-ledger/accountant-pack@1',
    packId: o.packId,
    createdAt: o.createdAt,
    expiresAt: o.expiresAt,
    expiresAtMs: o.expiresAtMs,
    currency: o.currency,
    periodFrom: o.periodFrom,
    periodTo: o.periodTo,
    totalStatementRows: o.totalStatementRows,
    selectedAlertCount: o.selectedAlertCount,
    selectedRowCount: o.selectedRowCount,
    hash: o.hash,
    items,
    ...(o.uid !== undefined ? { uid: o.uid } : {}),
  };
}

export function parsePackReply(raw: unknown): PackReply | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (!hasOnlyKeys(o, REPLY_KEYS)) return null;
  if (typeof o.alertId !== 'string' || o.alertId.length < 3 || o.alertId.length > 160) return null;
  if (typeof o.packId !== 'string' || !/^[0-9]{10,15}-[0-9a-f]{16}$/.test(o.packId)) return null;
  if (typeof o.reply !== 'string' || !o.reply.trim() || o.reply.length > 2000) return null;
  if (typeof o.repliedAt !== 'string' || !ISO_UTC.test(o.repliedAt)) return null;
  if (typeof o.author !== 'string' || !o.author.trim() || o.author.length > 80) return null;
  return {
    alertId: o.alertId,
    packId: o.packId,
    reply: o.reply.trim(),
    repliedAt: o.repliedAt,
    author: o.author.trim(),
  };
}

export function memoryPackStore(now: () => number = Date.now): PackStore {
  const packs = new Map<string, { pack: AccountantPackDoc; replies: Map<string, PackReply> }>();
  return {
    async create(raw) {
      const clean = parseAccountantPack(raw);
      if (!clean) throw new Error('Refusing to store a pack that failed allowlist validation.');
      if (isPackExpired(clean, now())) throw new Error('Refusing to store an already expired pack.');
      packs.set(clean.packId, { pack: clean, replies: new Map() });
    },
    async get(packId) {
      const entry = packs.get(packId);
      if (!entry) return null;
      if (isPackExpired(entry.pack, now())) throw new Error('This accountant review pack has expired.');
      return { pack: entry.pack, replies: [...entry.replies.values()] };
    },
    async reply(packId, rawReply) {
      const entry = packs.get(packId);
      if (!entry) throw new Error('Accountant review pack not found.');
      if (isPackExpired(entry.pack, now())) throw new Error('Cannot reply to an expired accountant review pack.');
      const clean = parsePackReply(rawReply);
      if (!clean || clean.packId !== packId) throw new Error('Reply failed allowlist validation.');
      entry.replies.set(clean.alertId, clean);
    },
  };
}
