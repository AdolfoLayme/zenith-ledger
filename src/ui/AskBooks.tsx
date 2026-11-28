import { useState } from 'react';
import { answerQuery, groundQuery, parseQuestionLocally, validateQuery, type BookAnswer } from '../core/ask';
import { CATEGORIES } from '../core/categories';
import type { LocalAnalysis } from '../core/pipeline';
import type { OnDevice } from '../ai/types';
import { usd as money } from './format';

const EXAMPLES = ['How much did we spend on Software in August?', 'How many times did we pay Delta Office Depot?', 'What was our largest charge in September?'];

/** Questions about the raw statement are answered on this device: Gemini Nano reads the question, code does the math. */
export function AskBooks({ analysis, onDevice, nanoReady }: { analysis: LocalAnalysis; onDevice: OnDevice | null; nanoReady: boolean }) {
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ answer: BookAnswer; source: string } | null>(null);
  const months = [...new Set(analysis.rows.map((r) => r.date.slice(0, 7)))].sort();

  const ask = async (q: string) => {
    if (!q.trim() || busy) return;
    setQuestion(q);
    setBusy(true);
    let query = null;
    let source = 'Keyword parser on this device (Gemini Nano not available)';
    if (nanoReady && onDevice) {
      try {
        const raw = validateQuery(await onDevice.parseQuestion(q.trim(), months), CATEGORIES);
        query = raw && groundQuery(raw, q);
        if (query) source = 'Gemini Nano on this device (ONLY_ON_DEVICE)';
      } catch {
        /* fall through to the keyword parser */
      }
    }
    query ??= parseQuestionLocally(q, CATEGORIES, months);
    setResult({ answer: answerQuery(query, analysis.rows, analysis.aliases), source });
    setBusy(false);
  };

  const q = result?.answer.query;
  return (
    <div className="card mt" data-testid="ask-books">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>Ask your books</h3>
        <span className="badge" title="The question and the answer stay in this browser">On this device · 0 bytes sent</span>
      </div>
      <p className="muted" style={{ margin: '6px 0 12px' }}>Ask in plain English. The question can contain real names because it never leaves this device: {nanoReady ? 'Gemini Nano turns it into a query' : 'a keyword parser turns it into a query (Gemini Nano is not available here)'}, and code finds the rows and adds the amounts.</p>
      <form className="row" onSubmit={(e) => { e.preventDefault(); void ask(question); }}>
        <input className="ask-input" aria-label="Question about this statement" placeholder="How much did we spend on Software in August?" value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={200} />
        <button className="btn primary" disabled={busy || !question.trim()}>{busy ? 'Reading…' : 'Ask'}</button>
      </form>
      <div className="row mt-s">
        {EXAMPLES.map((ex) => <button key={ex} type="button" className="btn small" onClick={() => void ask(ex)} disabled={busy}>{ex}</button>)}
      </div>
      {result && q && (
        <div className="ask-answer" data-testid="ask-answer">
          <b>{result.answer.headline}</b>
          <div className="row ask-query">
            <span className="badge accent">{q.metric}</span>
            <span className="badge accent">{q.flow === 'out' ? 'spending' : q.flow === 'in' ? 'income' : 'all'}</span>
            {q.category && <span className="badge accent">{q.category}</span>}
            {q.vendor && <span className="badge accent">“{q.vendor}”</span>}
            {q.month && <span className="badge accent">{q.month}</span>}
            <span className="muted" style={{ fontSize: 12.5 }}>Read by {result.source} · computed by code</span>
          </div>
          {result.answer.rows.length > 0 && (
            <table className="mt-s">
              <tbody>
                {result.answer.rows.slice(0, 8).map((r) => (
                  <tr key={r.index}><td className="mono">#{r.index}</td><td className="mono">{r.date}</td><td>{r.description}</td><td>{r.category}</td><td className="num">{money(r.amountCents)}</td></tr>
                ))}
              </tbody>
            </table>
          )}
          {result.answer.rows.length > 8 && <p className="muted" style={{ fontSize: 12.5 }}>and {result.answer.rows.length - 8} more rows.</p>}
        </div>
      )}
    </div>
  );
}
