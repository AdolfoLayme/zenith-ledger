import type { AnalyzedRow } from './pipeline';

/**
 * "Ask your books": the on-device model only turns a question into this query.
 * Deterministic code below finds the rows and does the math, so the model never computes money.
 */
export interface BookQuery {
  metric: 'sum' | 'count' | 'largest' | 'list';
  flow: 'out' | 'in' | 'any';
  category?: string;
  /** Text the user typed for a merchant or person, matched against local real names and aliases. */
  vendor?: string;
  /** YYYY-MM */
  month?: string;
}

export interface BookAnswer {
  query: BookQuery;
  headline: string;
  totalCents: number;
  rows: AnalyzedRow[];
}

const METRICS = ['sum', 'count', 'largest', 'list'] as const;
const FLOWS = ['out', 'in', 'any'] as const;

/** Accepts only a well-formed query; anything else from the model is dropped. */
export function validateQuery(raw: unknown, categories: string[]): BookQuery | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!METRICS.includes(o.metric as BookQuery['metric'])) return null;
  const q: BookQuery = { metric: o.metric as BookQuery['metric'], flow: FLOWS.includes(o.flow as BookQuery['flow']) ? (o.flow as BookQuery['flow']) : 'any' };
  const cat = typeof o.category === 'string' ? categories.find((c) => c.toLowerCase() === o.category!.toString().trim().toLowerCase()) : undefined;
  if (cat) q.category = cat;
  if (typeof o.vendor === 'string' && o.vendor.trim().length >= 2) q.vendor = o.vendor.trim().slice(0, 60);
  if (typeof o.month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(o.month.trim())) q.month = o.month.trim();
  return q;
}

const usd = (cents: number) => `$${(Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthName = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;

const CATEGORY_WORDS: Record<string, RegExp> = {
  Revenue: /revenue|income|sales|earn|deposit/, Supplies: /suppl/, Meals: /meal|food|lunch|dinner|restaurant|coffee/,
  Software: /software|subscription|saas|license/, Insurance: /insurance/, Payroll: /payroll|salar|wage/,
  Utilities: /utilit|power|electric|water|internet/, Travel: /travel|flight|hotel|trip/, Transfers: /transfer/, Other: /\bother\b/,
};

/** Keeps only the filters the question actually mentions: a small model tends to fill optional fields it was not asked for. */
export function groundQuery(q: BookQuery, question: string): BookQuery {
  const t = question.toLowerCase();
  const out: BookQuery = { metric: q.metric, flow: q.flow };
  if (q.category && CATEGORY_WORDS[q.category]?.test(t)) out.category = q.category;
  if (q.month) {
    const name = MONTHS[Number(q.month.slice(5, 7)) - 1].toLowerCase();
    if (t.includes(name) || t.includes(name.slice(0, 3) + ' ') || t.includes(q.month)) out.month = q.month;
  }
  if (q.vendor && t.includes(q.vendor.toLowerCase())) out.vendor = q.vendor;
  return out;
}

/** Runs the query over the local rows. Real names are used here because nothing leaves the device. */
export function answerQuery(q: BookQuery, rows: AnalyzedRow[], aliases: Map<string, string>): BookAnswer {
  const needle = q.vendor?.toLowerCase();
  const matchesVendor = (r: AnalyzedRow) => {
    if (!needle) return true;
    const real = aliases.get(r.vendorAlias)?.toLowerCase() ?? '';
    return r.description.toLowerCase().includes(needle) || real.includes(needle) || r.vendorAlias.toLowerCase() === needle;
  };
  let hits = rows.filter(
    (r) =>
      (q.flow === 'any' || (q.flow === 'out' ? r.amountCents < 0 : r.amountCents > 0)) &&
      (!q.category || r.category === q.category) &&
      (!q.month || r.date.startsWith(q.month)) &&
      matchesVendor(r),
  );
  if (q.metric === 'largest') hits = [...hits].sort((a, b) => Math.abs(b.amountCents) - Math.abs(a.amountCents)).slice(0, 1);
  const totalCents = hits.reduce((s, r) => s + r.amountCents, 0);

  const scope = [q.vendor ? `with ${q.vendor}` : '', q.category ? `in ${q.category}` : '', q.month ? `in ${monthName(q.month)}` : ''].filter(Boolean).join(' ');
  const what = q.flow === 'in' ? 'received' : q.flow === 'out' ? 'spent' : 'moved';
  let headline: string;
  if (!hits.length) headline = `No transactions match${scope ? ` ${scope}` : ''}.`;
  else if (q.metric === 'count') headline = `${hits.length} transaction${hits.length === 1 ? '' : 's'}${scope ? ` ${scope}` : ''}.`;
  else if (q.metric === 'largest') headline = `Largest: ${usd(hits[0].amountCents)} on ${hits[0].date}${scope ? ` ${scope}` : ''}.`;
  else headline = `You ${what} ${usd(totalCents)}${scope ? ` ${scope}` : ''} across ${hits.length} transaction${hits.length === 1 ? '' : 's'}.`;
  return { query: q, headline, totalCents, rows: hits };
}

/** Deterministic fallback when Gemini Nano is not available: keywords only. */
export function parseQuestionLocally(question: string, categories: string[], months: string[]): BookQuery {
  const t = question.toLowerCase();
  const metric: BookQuery['metric'] = /how many|count|number of/.test(t) ? 'count' : /largest|biggest|highest|most expensive/.test(t) ? 'largest' : /\b(list|show|which)\b/.test(t) ? 'list' : 'sum';
  const flow: BookQuery['flow'] = /receiv|income|revenue|earn|paid us|deposit/.test(t) ? 'in' : /spen|paid|pay|cost|expense|charge/.test(t) ? 'out' : 'any';
  const q: BookQuery = { metric, flow };
  const cat = categories.find((c) => t.includes(c.toLowerCase()));
  if (cat) q.category = cat;
  const month = months.find((m) => t.includes(MONTHS[Number(m.slice(5, 7)) - 1].toLowerCase()));
  if (month) q.month = month;
  const v = /\b(?:(?:pay|paid)(?:\s+to)?|on|at|to|from|with|by)\s+([a-z0-9][a-z0-9 &.'-]{2,40}?)(?=\s+(?:in|during|for|this|last|on)\b|[?.!,]|$)/i.exec(question);
  if (v && !categories.some((c) => c.toLowerCase() === v[1].trim().toLowerCase()) && !MONTHS.some((m) => v[1].toLowerCase().startsWith(m.toLowerCase()))) q.vendor = v[1].trim();
  return q;
}
