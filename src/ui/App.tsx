import { useEffect, useMemo, useRef, useState } from 'react';
import { getAi } from '../ai';
import { misreadCard, PHOTO_TYPES, PhotoNeedsOnDeviceError, readPhoto, rowsFromReview, type PhotoKind } from '../ai/photo';
import type { CloudReport } from '../ai/types';
import { parseStatement } from '../core/csv';
import { analyzeLocally, buildPayload, summaryOverview, type AnalyzedRow, type BuiltPayload, type LocalAnalysis } from '../core/pipeline';
import type { StatementRow } from '../core/types';
import { reidentify } from '../core/pseudonymize';
import type { Signal } from '../core/analytics';
import { clearLocalData, listReceipts, saveAliasMap, saveReceipt, type Receipt } from '../store/receipts';
import { usd } from './format';

type Screen = 'upload' | 'review' | 'local' | 'firewall' | 'report' | 'receipts';
type ReviewRow = { date: string; description: string; amount: string };
type Nano = 'idle' | 'downloading' | 'ready' | 'unavailable';

const STEPS: [Screen, string][] = [['upload', 'Statement'], ['local', 'Local analysis'], ['firewall', 'Privacy Firewall'], ['report', 'Audit report']];

function useOnline() {
  const [on, setOn] = useState(navigator.onLine);
  useEffect(() => {
    const a = () => setOn(true), b = () => setOn(false);
    window.addEventListener('online', a); window.addEventListener('offline', b);
    return () => { window.removeEventListener('online', a); window.removeEventListener('offline', b); };
  }, []);
  return on;
}

function Highlighted({ row }: { row: AnalyzedRow }) {
  const parts: React.ReactNode[] = [];
  let pos = 0;
  const aliasOf = new Map<string, string>();
  // alias labels come from the redacted text so the chip matches what the payload logic uses
  const aliases = row.redacted.match(/\b(?:Person|Card|IBAN|Account|Email|Phone|SSN|EIN|Link)_\d+\b/g) ?? [];
  row.spans.forEach((s, i) => aliasOf.set(`${s.start}`, aliases[i] ?? s.type));
  row.spans.forEach((s) => {
    parts.push(row.description.slice(pos, s.start));
    parts.push(<mark key={s.start}>{s.value}<small>{aliasOf.get(`${s.start}`)}</small></mark>);
    pos = s.end;
  });
  parts.push(row.description.slice(pos));
  return <>{parts}</>;
}

export function App() {
  const ai = useMemo(getAi, []);
  const online = useOnline();
  const [screen, setScreen] = useState<Screen>('upload');
  const [fileName, setFileName] = useState('');
  const [analysis, setAnalysis] = useState<LocalAnalysis | null>(null);
  const [built, setBuilt] = useState<BuiltPayload | null>(null);
  const [nano, setNano] = useState<Nano>(ai.onDevice ? 'idle' : 'unavailable');
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState('');
  const [error, setError] = useState('');
  const [report, setReport] = useState<CloudReport | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [history, setHistory] = useState<Receipt[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [over, setOver] = useState(false);
  const [source, setSource] = useState<'csv' | 'photo'>('csv');
  const [summary, setSummary] = useState<{ state: 'idle' | 'working' | 'done' | 'error'; text: string }>({ state: 'idle', text: '' });
  const [confirmClear, setConfirmClear] = useState(false);
  // a dropped photo waits here until the user says whether it is a statement or a receipt
  const [pending, setPending] = useState<{ image: Blob; name: string } | null>(null);
  // rows read from a photo, editable until the user confirms them
  const [review, setReview] = useState<{ name: string; persons: string[]; warning: string; rows: ReviewRow[] } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const refreshHistory = () => listReceipts().then(setHistory).catch(() => {});
  useEffect(() => { refreshHistory(); }, [receipt]);

  // Offline: the cloud is out of reach, so Gemini Nano writes a short summary from the anonymized overview.
  useEffect(() => {
    if (online || !analysis || nano !== 'ready' || !ai.onDevice || summary.state !== 'idle') return;
    setSummary({ state: 'working', text: '' });
    ai.onDevice.summarize(summaryOverview(analysis))
      .then((text) => setSummary({ state: 'done', text }))
      .catch(() => setSummary({ state: 'error', text: '' }));
  }, [online, analysis, nano, ai.onDevice, summary.state]);

  // A model downloaded on an earlier visit needs no click: start it right away.
  useEffect(() => {
    if (!ai.onDevice) return;
    ai.onDevice.alreadyAvailable().then((yes) => { if (yes) enableNano(); }).catch(() => {});
  }, [ai.onDevice]);

  async function enableNano() {
    if (!ai.onDevice) return;
    setNano('downloading');
    try { await ai.onDevice.init(setProgress); setNano('ready'); }
    catch (e) { setNano('unavailable'); setError(`On-device model could not start: ${(e as Error).message}`); }
  }

  async function run(task: () => Promise<void>) {
    setError(''); setBusy(true);
    try { await task(); } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); setReading(''); }
  }

  /** persons: names the code already knows are in the rows (a receipt's payer), redacted even if the model misses them. */
  async function analyze(rows: StatementRow[], name: string, from: 'csv' | 'photo', persons: string[] = []) {
    let entities;
    if (nano === 'ready' && ai.onDevice) {
      try {
        // recurring charges repeat the same text: the model reads each distinct description once
        const descs = rows.map((r) => r.description);
        const unique = [...new Set(descs)];
        const found = await ai.onDevice.extract(unique, (d, t) => setReading(`Gemini Nano is reading descriptions on this device: batch ${d + 1} of ${t}`));
        const byText = new Map(unique.map((d, i) => [d, found[i]]));
        entities = descs.map((d) => byText.get(d) ?? { persons: [] });
      } catch { entities = undefined; }
    }
    if (entities && persons.length) entities = entities.map((e) => ({ ...e, persons: [...(e.persons ?? []), ...persons] }));
    const a = analyzeLocally(rows, { entities });
    setAnalysis(a); setFileName(name); setSource(from); setBuilt(null); setReport(null); setReceipt(null); setShowAll(false);
    setSummary({ state: 'idle', text: '' });
    saveAliasMap(name, a.aliases).catch(() => {});
    setScreen('local');
  }

  const load = (read: () => Promise<StatementRow[]>, name: string) => run(async () => analyze(await read(), name, 'csv'));

  const sample = (name: string) => fetch(`${import.meta.env.BASE_URL}samples/${name}`);
  const loadSample = (n: 'q3' | 'q4') => load(async () => parseStatement(await (await sample(`acme-${n}.csv`)).text()), `acme-${n}.csv`);
  // A photo is only ever read by the on-device model; without it, readPhoto refuses before anything happens.
  const readPhotoAs = (photo: { image: Blob; name: string }, kind: PhotoKind) => run(async () => {
    setReading(`Gemini Nano is reading the ${kind} on this device…`);
    const r = await readPhoto(photo.image, kind, ai.onDevice, nano === 'ready');
    setPending(null);
    setReview({ name: photo.name, persons: r.persons, warning: r.warning, rows: r.rows.map((x) => ({ date: x.date, description: x.description, amount: (x.amountCents / 100).toFixed(2) })) });
    setScreen('review');
  });
  const loadSamplePhoto = async (name: string, kind: PhotoKind) => readPhotoAs({ image: await (await sample(name)).blob(), name }, kind);
  const onFile = async (f?: File) => {
    if (!f) return;
    setPending(null);
    if (!f.type.startsWith('image/')) return load(async () => parseStatement(await f.text()), f.name);
    if (nano !== 'ready' || !ai.onDevice) return setError(new PhotoNeedsOnDeviceError().message);
    setError('');
    setPending({ image: f, name: f.name });
  };

  const editRow = (i: number, k: keyof ReviewRow, v: string) => setReview((r) => r && { ...r, rows: r.rows.map((x, j) => (j === i ? { ...x, [k]: v } : x)) });
  const confirmReview = () => review && run(() => analyze(rowsFromReview(review.rows), review.name, 'photo', review.persons));

  async function deleteAll() {
    await clearLocalData();
    setConfirmClear(false);
    await refreshHistory();
  }

  async function toFirewall() {
    if (!analysis) return;
    setBuilt(await buildPayload(analysis));
    setScreen('firewall');
  }

  async function approve() {
    if (!built || !ai.cloud) return;
    setBusy(true); setError('');
    try {
      const r = await ai.cloud.audit(built.json);
      const rc: Receipt = { sentAt: new Date().toISOString(), hash: built.hash, fields: Object.keys(built.payload), rowCount: analysis!.rows.length };
      await saveReceipt(rc);
      setReport(r); setReceipt(rc); setScreen('report');
    } catch (e) { setError(`The cloud analysis failed: ${(e as Error).message}`); }
    finally { setBusy(false); }
  }

  const real = (s: string) => (analysis ? reidentify(s, analysis.aliases) : s);
  const idx = STEPS.findIndex(([k]) => k === (screen === 'review' ? 'upload' : screen));

  return (
    <div className="shell">
      <header className="top">
        <button className="brand" onClick={() => setScreen('upload')}><i />Zenith Ledger</button>
        <nav className="steps" aria-label="Progress">
          {STEPS.map(([k, label], i) => <span key={k} className={i === idx ? 'on' : i < idx ? 'past' : ''}>{i + 1}. {label}</span>)}
        </nav>
        <div className="row tools">
          <span className={`badge ${online ? 'accent' : 'warn'}`} data-testid="net"><span className="dot" />{online ? 'Online' : 'Offline'}</span>
          <button className={`btn small ${screen === 'receipts' ? 'active' : ''}`} onClick={() => setScreen('receipts')}>Data Receipts <span className="count">{history.length}</span></button>
        </div>
      </header>

      {error && <div className="note warn" role="alert" style={{ marginBottom: 16 }}>{error}</div>}

      {screen === 'upload' && (
        <section>
          <h1>Audit your books with AI,<br />without your bank data leaving your laptop.</h1>
          <p className="lead">Drop a bank statement. Names, cards, emails and account numbers are found and replaced on this device. You see exactly what would be sent, and nothing leaves until you approve it.</p>
          <div className={`drop ${over ? 'over' : ''}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); onFile(e.dataTransfer.files[0]); }}>
            <p className="droptitle">Drop a CSV statement, or a photo of a statement or receipt</p>
            <p>CSV columns: date, description, amount. Photos (JPEG or PNG) are read by the on-device model only.</p>
            {pending ? (
              <div className="choose" role="group" aria-label="Photo type">
                <p><b>What is in {pending.name}?</b> The on-device model reads each kind differently.</p>
                <div className="row">
                  <button className="btn primary" onClick={() => readPhotoAs(pending, 'statement')} disabled={busy}>Statement</button>
                  <button className="btn primary" onClick={() => readPhotoAs(pending, 'receipt')} disabled={busy}>Receipt</button>
                  <button className="btn" onClick={() => setPending(null)} disabled={busy}>Cancel</button>
                </div>
              </div>
            ) : <button className="btn primary" onClick={() => fileRef.current?.click()} disabled={busy}>{busy ? 'Reading…' : 'Choose a file'}</button>}
            {reading && <p className="muted" role="status">{reading}</p>}
            <input ref={fileRef} type="file" accept={['.csv', 'text/csv', ...PHOTO_TYPES].join(',')} hidden data-testid="file" onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ''; }} />
            <div className="samples">
              <span className="muted">Or try synthetic samples:</span>
              <button className="link" onClick={() => loadSample('q3')} disabled={busy}>Q3 statement (CSV)</button>
              <button className="link" onClick={() => loadSample('q4')} disabled={busy}>Q4 statement (CSV, US dates)</button>
              <button className="link" onClick={() => loadSamplePhoto('statement-photo.png', 'statement')} disabled={busy}>Statement photo</button>
              <button className="link" onClick={() => loadSamplePhoto('receipt-photo.png', 'receipt')} disabled={busy}>Receipt photo</button>
            </div>
          </div>
          <div className="card mt">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div>
                <h3>On-device AI (Gemini Nano)</h3>
                <span className="muted">
                  {nano === 'ready' ? 'Ready. Names and merchants will be found by the on-device model.'
                    : nano === 'unavailable' ? 'Not available in this browser. Strict mode: only rule-based detectors run, free-text descriptions are dropped from anything sent, and photos cannot be read.'
                    : nano === 'downloading' ? 'Preparing the model. The first download can take a few minutes.'
                    : 'Optional for CSV, required for photos. Finds person and business names inside free-text descriptions, fully offline.'}
                </span>
              </div>
              {nano === 'idle' && <button className="btn" onClick={enableNano}>Enable on-device AI</button>}
              {nano === 'downloading' && <div className="progress" role="progressbar" aria-valuenow={Math.round(progress * 100)}><div style={{ width: `${progress * 100}%` }} /></div>}
              {nano === 'ready' && <span className="badge"><span className="dot" />Active</span>}
              {nano === 'unavailable' && <span className="badge warn"><span className="dot" />Strict mode</span>}
            </div>
          </div>
          {ai.mode === 'demo' && <p className="muted mt" style={{ fontSize: 13 }}>Demo mode: scripted stand-ins replace Gemini. The privacy logic is the real code.</p>}
          {ai.mode === 'none' && <p className="muted mt" style={{ fontSize: 13 }}>Firebase is not configured, so deep analysis is unavailable. Local analysis works.</p>}
        </section>
      )}

      {screen === 'review' && review && (
        <section>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div><h2>Check what was read</h2><span className="muted">{review.name} · read on this device by Gemini Nano. Fix anything it misread, then continue.</span></div>
            <span className="badge"><span className="dot" />On this device · nothing sent</span>
          </div>
          {review.warning && <div className="note warn mt" data-testid="review-warning">{review.warning}</div>}
          <div className="tablewrap mt">
            <table className="review">
              <thead><tr><th>Date</th><th>Description</th><th className="num">Amount</th><th><span className="sr">Remove</span></th></tr></thead>
              <tbody>
                {review.rows.map((r, i) => (
                  <tr key={i}>
                    <td><input className="mono" aria-label={`Date, row ${i + 1}`} value={r.date} onChange={(e) => editRow(i, 'date', e.target.value)} /></td>
                    <td>
                      <input aria-label={`Description, row ${i + 1}`} value={r.description} onChange={(e) => editRow(i, 'description', e.target.value)} />
                      {misreadCard(r.description) && <small className="hint">This looks like a card number with a wrong or missing digit. Check it against the photo: an invalid card number is not recognized as sensitive.</small>}
                    </td>
                    <td className="num"><input className="mono num" aria-label={`Amount, row ${i + 1}`} value={r.amount} onChange={(e) => editRow(i, 'amount', e.target.value)} /></td>
                    <td><button className="link" aria-label={`Remove row ${i + 1}`} onClick={() => setReview({ ...review, rows: review.rows.filter((_, j) => j !== i) })}>Remove</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button className="btn small mt" onClick={() => setReview({ ...review, rows: [...review.rows, { date: '', description: '', amount: '' }] })}>Add a row</button>
          <p className="muted" style={{ fontSize: 13 }}>Dates as YYYY-MM-DD, amounts with a minus sign for money going out.</p>
          <div className="row mt2">
            <button className="btn" onClick={() => setScreen('upload')}>Back</button>
            <button className="btn primary" onClick={confirmReview} disabled={busy}>{busy ? 'Reading…' : 'Looks right'}</button>
          </div>
          {reading && <p className="muted" role="status">{reading}</p>}
        </section>
      )}

      {screen === 'local' && analysis && (
        <section>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div><h2>Local analysis</h2><span className="muted">{fileName}{source === 'photo' ? ' · photo read on this device by Gemini Nano' : ''} · {analysis.period.from} to {analysis.period.to}</span></div>
            <span className="badge"><span className="dot" />On this device · works offline</span>
          </div>
          {!online && (
            <div className="card offline mt" data-testid="offline-summary">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <h3 style={{ margin: 0 }}>Offline summary</h3>
                <span className="badge warn"><span className="dot" />No connection · Gemini Nano on this device</span>
              </div>
              <p style={{ margin: '10px 0 0' }}>
                {nano !== 'ready' ? 'You are offline. Everything on this page keeps working. Turn on on-device AI to get a written summary without a connection.'
                  : summary.state === 'done' ? real(summary.text)
                  : summary.state === 'error' ? 'The on-device model could not write a summary this time. The numbers below are complete.'
                  : 'Writing a short summary on this device…'}
              </p>
              <p className="muted" style={{ fontSize: 13, margin: '8px 0 0' }}>Deep analysis in the cloud comes back when you reconnect.</p>
            </div>
          )}
          <div className="grid g4 mt">
            <div className="card stat"><b>{analysis.rows.length}</b><span>transactions</span></div>
            <div className="card stat"><b>{analysis.counters.piiFound}</b><span>sensitive values found</span></div>
            <div className="card stat"><b>{analysis.counters.piiReplaced}</b><span>replaced with aliases</span></div>
            <div className="card stat"><b>{analysis.signals.length}</b><span>anomalies flagged</span></div>
          </div>
          {analysis.mode === 'strict' && <div className="note mt">Strict mode: person names inside free text are not detected without the on-device model, so free-text descriptions are never included in what is sent.</div>}

          <div className="grid g2 mt">
            <div className="card">
              <h3>Anomalies</h3>
              {analysis.signals.length === 0 && <span className="muted">Nothing unusual found.</span>}
              {analysis.signals.map((s, i) => <SignalItem key={i} s={s} real={real} />)}
            </div>
            <div className="card">
              <h3>Totals</h3>
              <div className="row" style={{ justifyContent: 'space-between' }}><span className="muted">Money in</span><b>{usd(analysis.totals.incomeCents)}</b></div>
              <div className="row mt" style={{ justifyContent: 'space-between', marginTop: 10 }}><span className="muted">Money out</span><b>{usd(-analysis.totals.expenseCents)}</b></div>
              <div className="row" style={{ justifyContent: 'space-between', marginTop: 10 }}><span className="muted">Net</span><b>{usd(analysis.totals.incomeCents - analysis.totals.expenseCents)}</b></div>
              <p className="muted" style={{ fontSize: 13, marginBottom: 0 }}>Computed with integer cents by deterministic code, not by the model.</p>
            </div>
          </div>

          <h3 className="mt2">Transactions, with sensitive values highlighted</h3>
          <div className="tablewrap">
            <table>
              <thead><tr><th>Date</th><th>Description (original, local only)</th><th>Category</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {(showAll ? analysis.rows : analysis.rows.slice(0, 25)).map((r) => (
                  <tr key={r.index}>
                    <td className="mono">{r.date}</td>
                    <td><Highlighted row={r} /></td>
                    <td><span className="pill">{r.category}</span></td>
                    <td className={`num ${r.amountCents >= 0 ? 'pos' : 'neg'}`}>{usd(r.amountCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!showAll && analysis.rows.length > 25 && <button className="btn mt" onClick={() => setShowAll(true)}>Show all {analysis.rows.length} rows</button>}
          <div className="row mt2">
            <button className="btn" onClick={() => setScreen('upload')}>Back</button>
            <button className="btn primary" onClick={toFirewall}>Review what would be sent</button>
          </div>
        </section>
      )}

      {screen === 'firewall' && analysis && built && (
        <section>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div><h2>Privacy Firewall</h2><span className="muted">This is the exact JSON that will leave your device if you approve.</span></div>
          </div>
          <div className="grid g4 mt">
            <div className="card stat"><b>{built.counters.piiFound}</b><span>sensitive values found</span></div>
            <div className="card stat"><b>{built.counters.piiReplaced}</b><span>replaced</span></div>
            <div className="card stat"><b>{built.counters.rawDescriptionsSent}</b><span>raw descriptions sent</span></div>
            <div className="card stat"><b>{(built.json.length / 1024).toFixed(1)} KB</b><span>payload size</span></div>
          </div>

          <h3 className="mt2">Before and after</h3>
          <div className="diff">
            <div className="col"><h3>Stays on this device</h3>
              {analysis.rows.filter((r) => r.spans.length).slice(0, 5).map((r) => <div className="line" key={r.index}><Highlighted row={r} /></div>)}
            </div>
            <div className="col"><h3 className="out">What the cloud gets instead</h3>
              {analysis.rows.filter((r) => r.spans.length).slice(0, 5).map((r) => <div className="line" key={r.index}><span className="mono">{r.vendorAlias}</span> · {r.category} · <span className="muted">row not sent, only counted in totals</span></div>)}
            </div>
          </div>

          <h3 className="mt2">Exact payload</h3>
          <pre className="json" tabIndex={0}>{built.json}</pre>
          <p className="muted" style={{ fontSize: 13 }}>SHA-256 <code>{built.hash}</code></p>

          {!online && <div className="note warn mt">You are offline. Deep analysis waits for the connection; everything on the previous screen keeps working.</div>}
          {!ai.cloud && <div className="note warn mt">Cloud analysis is not configured in this build.</div>}
          <div className="row mt2">
            <button className="btn" onClick={() => setScreen('local')}>Back</button>
            <button className="btn primary" disabled={!online || !ai.cloud || busy} onClick={approve}>{busy ? 'Analyzing…' : 'Approve & send'}</button>
          </div>
        </section>
      )}

      {screen === 'report' && analysis && report && receipt && (
        <section>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div><h2>Audit report</h2><span className="muted">Names below were restored on this device. The model only saw aliases.</span></div>
            <span className="badge"><span className="dot" />Re-identified locally</span>
          </div>
          <div className="card mt"><h3>Summary</h3><p style={{ margin: 0 }}>{real(report.narrative)}</p></div>
          <div className="grid g2 mt">
            <div className="card"><h3>Findings</h3>
              {report.findings.map((f, i) => (
                <div className="sig" key={i}><div className={`sev ${f.severity}`} /><div><b>{real(f.title)}</b><div className="muted">{real(f.detail)}</div></div></div>
              ))}
            </div>
            <div className="card"><h3>Questions for your accountant</h3>
              <ul className="clean">{report.questionsForAccountant.map((q, i) => <li key={i}>{real(q)}</li>)}</ul>
            </div>
          </div>
          <div className="card mt2">
            <h3>Data Receipt</h3>
            <div className="grid g2">
              <div><span className="muted">Sent at</span><div>{new Date(receipt.sentAt).toLocaleString('en-US')}</div></div>
              <div><span className="muted">Rows summarized</span><div>{receipt.rowCount}</div></div>
              <div><span className="muted">Fields sent</span><div>{receipt.fields.join(', ')}</div></div>
              <div><span className="muted">Payload SHA-256</span><div><code>{receipt.hash}</code></div></div>
            </div>
            <p className="muted" style={{ fontSize: 13, marginBottom: 0 }}>Stored in this browser only ({history.length} receipt{history.length === 1 ? '' : 's'} so far).</p>
          </div>
          <div className="row mt2">
            <button className="btn" onClick={() => setScreen('upload')}>Audit another statement</button>
            <button className="btn" onClick={() => setScreen('receipts')}>All Data Receipts</button>
          </div>
        </section>
      )}

      {screen === 'receipts' && (
        <section>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div><h2>Data Receipts</h2><span className="muted">One entry per approved send: when, the SHA-256 of the exact payload, and which fields left this device.</span></div>
            {history.length > 0 && (confirmClear
              ? <div className="row"><button className="btn" onClick={() => setConfirmClear(false)}>Cancel</button><button className="btn danger" onClick={deleteAll}>Delete receipts and alias maps</button></div>
              : <button className="btn" onClick={() => setConfirmClear(true)}>Delete all</button>)}
          </div>
          {history.length === 0
            ? <div className="card mt empty"><b>No data has left this device.</b><span className="muted">Receipts appear here after you approve a send in the Privacy Firewall.</span></div>
            : (
              <ol className="receipts mt">
                {history.map((r) => (
                  <li className="card" key={r.id ?? r.sentAt}>
                    <div className="grid g3">
                      <div><span className="muted">Sent at</span><div>{new Date(r.sentAt).toLocaleString('en-US')}</div></div>
                      <div><span className="muted">Rows summarized</span><div>{r.rowCount}</div></div>
                      <div><span className="muted">Fields sent</span><div>{r.fields.join(', ')}</div></div>
                    </div>
                    <div className="mt hash"><span className="muted">Payload SHA-256</span><div><code>{r.hash}</code></div></div>
                  </li>
                ))}
              </ol>
            )}
          <p className="muted" style={{ fontSize: 13 }}>Receipts and alias maps live in this browser's IndexedDB. Nothing here is uploaded.</p>
          <div className="row mt"><button className="btn" onClick={() => setScreen(analysis ? 'local' : 'upload')}>Back</button></div>
        </section>
      )}
    </div>
  );
}

function SignalItem({ s, real }: { s: Signal; real: (t: string) => string }) {
  const label: Record<Signal['type'], string> = { duplicate: 'Possible duplicate', price_increase: 'Price increase', outlier: 'Outlier', round_transfer: 'Round transfer', weekend_spend: 'Weekend spend' };
  const who = real(s.vendor);
  const detail = s.type === 'duplicate' ? `${usd(s.amountCents)} on ${s.dates[0]} and ${s.dates[1]}`
    : s.type === 'price_increase' ? `${usd(s.fromCents)} to ${usd(s.toCents)} on ${s.date}`
    : `${usd(s.amountCents)} on ${s.date}`;
  return (
    <div className="sig"><div className={`sev ${s.type === 'duplicate' || s.type === 'outlier' ? 'high' : s.type === 'weekend_spend' ? 'low' : ''}`} />
      <div><b>{label[s.type]}</b> · {who}<div className="muted">{detail}</div></div></div>
  );
}
