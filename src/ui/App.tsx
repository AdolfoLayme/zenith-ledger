import { useEffect, useMemo, useRef, useState } from 'react';
import { getAi } from '../ai';
import type { CloudReport } from '../ai/types';
import { parseStatement } from '../core/csv';
import { analyzeLocally, buildPayload, type AnalyzedRow, type BuiltPayload, type LocalAnalysis } from '../core/pipeline';
import { reidentify } from '../core/pseudonymize';
import type { Signal } from '../core/analytics';
import { listReceipts, saveAliasMap, saveReceipt, type Receipt } from '../store/receipts';
import { usd } from './format';

type Screen = 'upload' | 'local' | 'firewall' | 'report';
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
  const [error, setError] = useState('');
  const [report, setReport] = useState<CloudReport | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [history, setHistory] = useState<Receipt[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { listReceipts().then(setHistory).catch(() => {}); }, [receipt]);

  async function enableNano() {
    if (!ai.onDevice) return;
    setNano('downloading');
    try { await ai.onDevice.init(setProgress); setNano('ready'); }
    catch (e) { setNano('unavailable'); setError(`On-device model could not start: ${(e as Error).message}`); }
  }

  async function load(text: string, name: string) {
    setError(''); setBusy(true);
    try {
      const rows = parseStatement(text);
      let entities;
      if (nano === 'ready' && ai.onDevice) {
        try { entities = await ai.onDevice.extract(rows.map((r) => r.description)); } catch { entities = undefined; }
      }
      const a = analyzeLocally(rows, { entities });
      setAnalysis(a); setFileName(name); setBuilt(null); setReport(null); setReceipt(null); setShowAll(false);
      saveAliasMap(name, a.aliases).catch(() => {});
      setScreen('local');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  const loadSample = async (n: 'q3' | 'q4') => load(await (await fetch(`${import.meta.env.BASE_URL}samples/acme-${n}.csv`)).text(), `acme-${n}.csv`);
  const onFile = async (f?: File) => { if (f) await load(await f.text(), f.name); };

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
  const idx = STEPS.findIndex(([k]) => k === screen);

  return (
    <div className="shell">
      <header className="top">
        <div className="brand"><i />Zenith Ledger</div>
        <nav className="steps" aria-label="Progress">
          {STEPS.map(([k, label], i) => <span key={k} className={i === idx ? 'on' : i < idx ? 'past' : ''}>{i + 1}. {label}</span>)}
        </nav>
      </header>

      {error && <div className="note warn" role="alert" style={{ marginBottom: 16 }}>{error}</div>}

      {screen === 'upload' && (
        <section>
          <h1>Audit your books with AI,<br />without your bank data leaving your laptop.</h1>
          <p className="lead">Drop a bank statement. Names, cards, emails and account numbers are found and replaced on this device. You see exactly what would be sent, and nothing leaves until you approve it.</p>
          <div className={`drop ${over ? 'over' : ''}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); onFile(e.dataTransfer.files[0]); }}>
            <p>Drag a CSV statement here (columns: date, description, amount)</p>
            <div className="row" style={{ justifyContent: 'center' }}>
              <button className="btn primary" onClick={() => fileRef.current?.click()} disabled={busy}>Choose a CSV file</button>
              <button className="btn" onClick={() => loadSample('q3')} disabled={busy}>Try sample statement</button>
              <button className="btn" onClick={() => loadSample('q4')} disabled={busy}>Sample Q4 (US dates)</button>
            </div>
            <input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={(e) => onFile(e.target.files?.[0])} />
          </div>
          <div className="card mt">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div>
                <h3>On-device AI (Gemini Nano)</h3>
                <span className="muted">
                  {nano === 'ready' ? 'Ready. Names and merchants will be found by the on-device model.'
                    : nano === 'unavailable' ? 'Not available in this browser. Strict mode: only rule-based detectors run, and free-text descriptions are dropped from anything sent.'
                    : nano === 'downloading' ? 'Preparing the model. The first download can take a few minutes.'
                    : 'Optional. Finds person and business names inside free-text descriptions, fully offline.'}
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

      {screen === 'local' && analysis && (
        <section>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div><h2>Local analysis</h2><span className="muted">{fileName} · {analysis.period.from} to {analysis.period.to}</span></div>
            <span className="badge"><span className="dot" />On this device · offline-capable</span>
          </div>
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
            <span className={`badge ${online ? 'accent' : 'warn'}`}><span className="dot" />{online ? 'Online' : 'Offline'}</span>
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
            <div className="col"><h3 className="out">Sent to the cloud</h3>
              {analysis.rows.filter((r) => r.spans.length).slice(0, 5).map((r) => <div className="line" key={r.index}><span className="mono">{r.vendorAlias}</span> · {r.category} · {usd(r.amountCents)} · {r.date}</div>)}
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
          <div className="row mt2"><button className="btn" onClick={() => setScreen('upload')}>Audit another statement</button></div>
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
