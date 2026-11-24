import { useEffect, useMemo, useRef, useState } from 'react';
import { getAi } from '../ai';
import { misreadCard, PHOTO_TYPES, PhotoNeedsOnDeviceError, readPhoto, rowsFromReview, type PhotoKind } from '../ai/photo';
import type { CloudReport } from '../ai/types';
import { useConfig } from '../config/useConfig';
import { comparePeriods, inferPeriodLabel, summarizePeriod, type PeriodSummary } from '../core/compare';
import { parseStatement } from '../core/csv';
import { buildDossiers, type AlertDecision, type DecisionStatus, type EvidenceDossier } from '../core/dossier';
import { buildAccountantCaseCsv, buildAccountantCaseJson } from '../core/export';
import { analyzeLocally, buildPayload, countFlaggedAnomalies, summaryOverview, type AnalyzedRow, type BuiltPayload, type LocalAnalysis } from '../core/pipeline';
import type { StatementRow } from '../core/types';
import { reidentify } from '../core/pseudonymize';
import { clearLocalData, listDecisions, listPeriodSummaries, listReceipts, loadAliasMap, saveAliasMap, saveDecision, saveDossiers, savePeriodSummary, saveReceipt, type Receipt } from '../store/receipts';
import { openPackStore } from '../pack/firestore';
import { buildAccountantPack, type AccountantPackDoc, type BuiltAccountantPack, type PackItem, type PackReply } from '../pack/pack';
import { isMobileDevice, MOBILE_NO_NANO_NOTICE } from '../pwa/pwa';
import { openReceiptVault } from '../vault/firestore';
import { syncVault, type ReceiptVault } from '../vault/sync';
import { usd } from './format';

type Screen = 'upload' | 'review' | 'local' | 'firewall' | 'report' | 'receipts' | 'accountant';
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

export interface ExtensionBridge {
  auditPage: () => Promise<{ rows: StatementRow[]; name: string }>;
}

export function App({ extension }: { extension?: ExtensionBridge } = {}) {
  const ai = useMemo(getAi, []);
  const isMobile = useMemo(() => isMobileDevice(), []);
  const config = useConfig(ai.mode === 'firebase');
  const online = useOnline();
  const [screen, setScreen] = useState<Screen>('upload');
  const [fileName, setFileName] = useState('');
  const [analysis, setAnalysis] = useState<LocalAnalysis | null>(null);
  const [built, setBuilt] = useState<BuiltPayload | null>(null);
  const [nano, setNano] = useState<Nano>(ai.onDevice && !isMobile ? 'idle' : 'unavailable');
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState('');
  const [error, setError] = useState('');
  const [nanoNote, setNanoNote] = useState('');
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
  const [review, setReview] = useState<{ name: string; persons: string[]; warning: string; rows: ReviewRow[]; initialRows: ReviewRow[] } | null>(null);
  const [dossiers, setDossiers] = useState<EvidenceDossier[]>([]);
  const [openDossierId, setOpenDossierId] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<Record<string, AlertDecision>>({});
  const [priorPeriod, setPriorPeriod] = useState<PeriodSummary | null>(null);
  const [savedPeriods, setSavedPeriods] = useState<PeriodSummary[]>([]);
  const [firewallKind, setFirewallKind] = useState<'audit' | 'pack'>('audit');
  const [builtPack, setBuiltPack] = useState<BuiltAccountantPack | null>(null);
  const [sharedPack, setSharedPack] = useState<{ pack: AccountantPackDoc; replies: PackReply[] } | null>(null);
  const [accountantView, setAccountantView] = useState<{ pack: AccountantPackDoc; replies: Record<string, PackReply> } | null>(null);
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [replyBusyId, setReplyBusyId] = useState<string | null>(null);
  const [vaultBusy, setVaultBusy] = useState(false);
  const [vaultOn, setVaultOn] = useState(false);
  const [vaultNote, setVaultNote] = useState('');
  const vaultRef = useRef<ReceiptVault | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const priorFileRef = useRef<HTMLInputElement>(null);

  const refreshHistory = () => listReceipts().then(setHistory).catch(() => {});
  const refreshPeriods = () => listPeriodSummaries().then(setSavedPeriods).catch(() => {});
  const refreshDecisions = () =>
    listDecisions()
      .then((all) => setDecisions(Object.fromEntries(all.map((d) => [d.alertId, d]))))
      .catch(() => {});
  useEffect(() => { refreshHistory(); refreshDecisions(); refreshPeriods(); }, [receipt]);

  // Offline: the cloud is out of reach, so Gemini Nano writes a short summary from the anonymized overview.
  useEffect(() => {
    if (online || !config.flags.offlineSummary || !analysis || nano !== 'ready' || !ai.onDevice || summary.state !== 'idle') return;
    setSummary({ state: 'working', text: '' });
    ai.onDevice.summarize(summaryOverview(analysis))
      .then((text) => setSummary({ state: 'done', text }))
      .catch(() => setSummary({ state: 'error', text: '' }));
  }, [online, config.flags.offlineSummary, analysis, nano, ai.onDevice, summary.state]);

  // A model downloaded on an earlier visit needs no click: start it right away.
  useEffect(() => {
    if (!ai.onDevice || isMobile) return;
    ai.onDevice.alreadyAvailable().then((yes) => { if (yes) enableNano(); }).catch(() => {});
  }, [ai.onDevice, isMobile]);

  // If opened with ?pack=<packId>, load the Accountant Review Pack directly without requiring an account.
  useEffect(() => {
    if (typeof location === 'undefined') return;
    const packId = new URLSearchParams(location.search).get('pack');
    if (!packId) return;
    setScreen('accountant');
    setBusy(true);
    openPackStore()
      .then((store) => store.get(packId))
      .then((res) => {
        if (!res) {
          setError('Accountant review pack not found or expired.');
          return;
        }
        const byAlert = Object.fromEntries(res.replies.map((r) => [r.alertId, r]));
        setAccountantView({ pack: res.pack, replies: byAlert });
        setReplyDrafts(Object.fromEntries(res.replies.map((r) => [r.alertId, r.reply])));
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setBusy(false));
  }, []);

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
    setNanoNote('');
    let entities;
    if (nano === 'ready' && ai.onDevice) {
      try {
        // recurring charges repeat the same text: the model reads each distinct description once
        const descs = rows.map((r) => r.description);
        const unique = [...new Set(descs)];
        const found = await ai.onDevice.extract(unique, (d, t) => setReading(`Gemini Nano is reading descriptions on this device: batch ${d + 1} of ${t}`));
        const byText = new Map(unique.map((d, i) => [d, found[i]]));
        entities = descs.map((d) => byText.get(d) ?? { persons: [] });
      } catch (e) {
        // keep going safely in strict mode, but say why instead of hiding it
        console.warn('On-device extraction failed, strict mode:', e);
        setNanoNote(`Gemini Nano could not finish reading (${(e as Error).message}). This analysis used strict mode.`);
        entities = undefined;
      }
    }
    if (entities && persons.length) entities = entities.map((e) => ({ ...e, persons: [...(e.persons ?? []), ...persons] }));
    const sortedDates = rows.map((r) => r.date).sort();
    const firstDate = sortedDates[0] ?? '';
    const existingSummaries = await listPeriodSummaries().catch(() => [] as PeriodSummary[]);
    const autoPrior = existingSummaries.find((p) => p.period.to < firstDate) ?? null;
    const priorAliases = autoPrior ? await loadAliasMap(`period:${autoPrior.id}`).catch(() => null) : null;

    const a = analyzeLocally(rows, {
      entities,
      thresholds: config.thresholds,
      integrity: config.integrity,
      fileName: name,
      ...(priorAliases ? { initialAliases: priorAliases } : {}),
    });
    const currentSummary = summarizePeriod(a, name);
    await savePeriodSummary(currentSummary).catch(() => {});
    await saveAliasMap(`period:${currentSummary.id}`, a.aliases).catch(() => {});

    const compFindings = autoPrior ? comparePeriods(a, autoPrior, config.thresholds, name) : [];
    const builtDossiers = buildDossiers(a, config.thresholds, config.integrity, compFindings);
    setAnalysis(a); setPriorPeriod(autoPrior); setDossiers(builtDossiers); setOpenDossierId(builtDossiers[0]?.id ?? null);
    setFileName(name); setSource(from); setBuilt(null); setReport(null); setReceipt(null); setShowAll(false);
    setSummary({ state: 'idle', text: '' });
    saveAliasMap(name, a.aliases).catch(() => {});
    saveDossiers(builtDossiers).catch(() => {});
    await refreshDecisions();
    await refreshPeriods();
    setScreen('local');
  }

  async function compareWithPriorRows(priorRows: StatementRow[], priorName: string) {
    if (!analysis) return;
    const priorAnalysis = analyzeLocally(priorRows, {
      thresholds: config.thresholds,
      integrity: config.integrity,
      fileName: priorName,
      initialAliases: analysis.aliases,
    });
    for (const [alias, orig] of priorAnalysis.aliases) {
      analysis.aliases.set(alias, orig);
    }
    const priorSummary = summarizePeriod(priorAnalysis, priorName);
    await savePeriodSummary(priorSummary).catch(() => {});
    await saveAliasMap(`period:${priorSummary.id}`, analysis.aliases).catch(() => {});
    await saveAliasMap(fileName, analysis.aliases).catch(() => {});
    const compFindings = comparePeriods(analysis, priorSummary, config.thresholds, fileName);
    const builtDossiers = buildDossiers(analysis, config.thresholds, config.integrity, compFindings);
    setPriorPeriod(priorSummary);
    setDossiers(builtDossiers);
    const firstComp = builtDossiers.find((d) => d.kind === 'comparison');
    if (firstComp) setOpenDossierId(firstComp.id);
    await saveDossiers(builtDossiers).catch(() => {});
    await refreshPeriods();
  }

  async function compareWithSavedSummary(summary: PeriodSummary) {
    if (!analysis) return;
    const savedAliases = await loadAliasMap(`period:${summary.id}`).catch(() => null);
    if (savedAliases) {
      for (const [alias, orig] of savedAliases) {
        if (!analysis.aliases.has(alias)) analysis.aliases.set(alias, orig);
      }
    }
    const compFindings = comparePeriods(analysis, summary, config.thresholds, fileName);
    const builtDossiers = buildDossiers(analysis, config.thresholds, config.integrity, compFindings);
    setPriorPeriod(summary);
    setDossiers(builtDossiers);
    const firstComp = builtDossiers.find((d) => d.kind === 'comparison');
    if (firstComp) setOpenDossierId(firstComp.id);
    await saveDossiers(builtDossiers).catch(() => {});
  }

  const load = (read: () => Promise<StatementRow[]>, name: string) => run(async () => analyze(await read(), name, 'csv'));
  const auditOpenPage = () => extension && run(async () => {
    const p = await extension.auditPage();
    await analyze(p.rows, p.name, 'csv');
  });

  const sample = (name: string) => fetch(`${import.meta.env.BASE_URL}samples/${name}`);
  const loadSample = (n: 'q2' | 'q3' | 'q4' | 'q3-gaps') => load(async () => parseStatement(await (await sample(`acme-${n}.csv`)).text()), `acme-${n}.csv`);
  const compareWithSampleQ2 = () => run(async () => compareWithPriorRows(parseStatement(await (await sample('acme-q2.csv')).text()), 'acme-q2.csv'));
  const onPriorFile = async (f?: File) => {
    if (!f) return;
    await run(async () => compareWithPriorRows(parseStatement(await f.text()), f.name));
  };
  // A photo is only ever read by the on-device model; without it, readPhoto refuses before anything happens.
  const readPhotoAs = (photo: { image: Blob; name: string }, kind: PhotoKind) => run(async () => {
    setReading(`Gemini Nano is reading the ${kind} on this device…`);
    const r = await readPhoto(photo.image, kind, ai.onDevice, nano === 'ready');
    setPending(null);
    const initialRows = r.rows.map((x) => ({ date: x.date, description: x.description, amount: (x.amountCents / 100).toFixed(2) }));
    setReview({ name: photo.name, persons: r.persons, warning: r.warning, rows: initialRows.map((x) => ({ ...x })), initialRows });
    setScreen('review');
  });
  const loadSamplePhoto = async (name: string, kind: PhotoKind) => readPhotoAs({ image: await (await sample(name)).blob(), name }, kind);
  const onFile = async (f?: File) => {
    if (!f) return;
    setPending(null);
    if (!f.type.startsWith('image/')) return load(async () => parseStatement(await f.text()), f.name);
    if (!config.flags.photoInput) return setError('Photo input is turned off.');
    if (nano !== 'ready' || !ai.onDevice) return setError(new PhotoNeedsOnDeviceError().message);
    setError('');
    setPending({ image: f, name: f.name });
  };

  const editRow = (i: number, k: keyof ReviewRow, v: string) => setReview((r) => r && { ...r, rows: r.rows.map((x, j) => (j === i ? { ...x, [k]: v } : x)) });
  const confirmReview = () => review && run(() => analyze(rowsFromReview(review.rows.map((x) => ({ ...x, page: 1 })), review.initialRows), review.name, 'photo', review.persons));

  async function updateDecision(alertId: string, status: DecisionStatus, note?: string) {
    const prev = decisions[alertId];
    const next: AlertDecision = {
      alertId,
      status,
      note: note !== undefined ? note : (prev?.note ?? ''),
      updatedAt: new Date().toISOString(),
    };
    setDecisions((curr) => ({ ...curr, [alertId]: next }));
    await saveDecision(next);
  }

  async function updateDecisionNote(alertId: string, note: string) {
    const prev = decisions[alertId];
    const next: AlertDecision = {
      alertId,
      status: prev?.status ?? 'ask_accountant',
      note,
      updatedAt: new Date().toISOString(),
    };
    setDecisions((curr) => ({ ...curr, [alertId]: next }));
    await saveDecision(next);
  }

  async function deleteAll() {
    await clearLocalData();
    setConfirmClear(false);
    setDecisions({});
    setPriorPeriod(null);
    setSavedPeriods([]);
    await refreshHistory();
  }

  async function syncReceipts() {
    setError(''); setVaultBusy(true);
    try {
      const v = vaultRef.current ?? (vaultRef.current = await openReceiptVault());
      const res = await syncVault(v, await listReceipts());
      setVaultOn(true);
      setVaultNote(`Synced with Receipt Vault: ${res.uploaded} uploaded, ${res.restored} restored.`);
      await refreshHistory();
    } catch (e) { setError(`Receipt Vault sync failed: ${(e as Error).message}`); }
    finally { setVaultBusy(false); }
  }

  async function wipeVault() {
    setError(''); setVaultBusy(true);
    try {
      const v = vaultRef.current ?? (vaultRef.current = await openReceiptVault());
      await v.wipe();
      setVaultOn(false);
      setVaultNote('Vault copy deleted. Local receipts on this device were kept.');
    } catch (e) { setError(`Could not delete vault copy: ${(e as Error).message}`); }
    finally { setVaultBusy(false); }
  }

  async function toFirewall() {
    if (!analysis) return;
    setBuilt(await buildPayload(analysis));
    setFirewallKind('audit');
    setScreen('firewall');
  }

  async function toPackFirewall() {
    if (!analysis) return;
    setError('');
    try {
      const bp = await buildAccountantPack(analysis, dossiers, decisions);
      setBuiltPack(bp);
      setFirewallKind('pack');
      setScreen('firewall');
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function approvePack() {
    if (!builtPack || !analysis) return;
    setBusy(true); setError('');
    try {
      await saveAliasMap(builtPack.pack.packId, analysis.aliases);
      const store = await openPackStore();
      await store.create(builtPack.pack);
      const rc: Receipt = {
        sentAt: builtPack.pack.createdAt,
        hash: builtPack.hash,
        fields: ['schema', 'currency', 'period', 'signals'],
        rowCount: builtPack.counters.selectedRows,
        piiFound: analysis.counters.piiFound,
        piiReplaced: analysis.counters.piiReplaced,
        rawDescriptionsSent: builtPack.counters.rawDescriptionsSent,
      };
      await saveReceipt(rc);
      setReceipt(rc);
      setSharedPack({ pack: builtPack.pack, replies: [] });
      setScreen('local');
    } catch (e) {
      setError(`Could not share accountant review pack: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function refreshSharedPackReplies() {
    if (!sharedPack) return;
    setBusy(true); setError('');
    try {
      const store = await openPackStore();
      const res = await store.get(sharedPack.pack.packId);
      if (res) setSharedPack(res);
    } catch (e) {
      setError(`Could not load accountant responses: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function draftReplyWithAi(item: PackItem) {
    if (!ai.cloud) return;
    setReplyBusyId(item.alertId); setError('');
    try {
      const draft = await ai.cloud.draftReply(JSON.stringify(item), config.cloudModel);
      setReplyDrafts((curr) => ({ ...curr, [item.alertId]: draft }));
    } catch (e) {
      setError(`Could not draft reply: ${(e as Error).message}`);
    } finally {
      setReplyBusyId(null);
    }
  }

  async function sendAccountantReply(item: PackItem) {
    if (!accountantView) return;
    const text = (replyDrafts[item.alertId] ?? '').trim();
    if (!text) return setError('Write or draft a response before sending.');
    setReplyBusyId(item.alertId); setError('');
    try {
      const store = await openPackStore();
      const reply: PackReply = {
        alertId: item.alertId,
        packId: accountantView.pack.packId,
        reply: text,
        repliedAt: new Date().toISOString(),
        author: 'Accountant',
      };
      await store.reply(accountantView.pack.packId, reply);
      setAccountantView((curr) => curr && { ...curr, replies: { ...curr.replies, [item.alertId]: reply } });
    } catch (e) {
      setError(`Could not send response: ${(e as Error).message}`);
    } finally {
      setReplyBusyId(null);
    }
  }

  async function approve() {
    if (!built || !ai.cloud) return;
    setBusy(true); setError('');
    try {
      const r = await ai.cloud.audit(built.json, config.cloudModel);
      const rc: Receipt = { sentAt: new Date().toISOString(), hash: built.hash, fields: Object.keys(built.payload), rowCount: analysis!.rows.length, ...built.counters };
      await saveReceipt(rc);
      setReport(r); setReceipt(rc); setScreen('report');
    } catch (e) { setError(`The cloud analysis failed: ${(e as Error).message}`); }
    finally { setBusy(false); }
  }

  const real = (s: string) => (analysis ? reidentify(s, analysis.aliases) : s);
  const askCount = dossiers.filter((d) => decisions[d.id]?.status === 'ask_accountant').length;
  const idx = STEPS.findIndex(([k]) => k === (screen === 'review' ? 'upload' : screen));

  function downloadFile(name: string, content: string, mime: string) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function exportCase(kind: 'csv' | 'json') {
    if (!analysis) return;
    const repliesMap = Object.fromEntries((sharedPack?.replies ?? []).map((r) => [r.alertId, r.reply]));
    const opts = {
      fileName,
      period: analysis.period,
      currency: analysis.currency,
      aliases: analysis.aliases,
      replies: repliesMap,
    };
    const base = (fileName || 'statement').replace(/\.[^.]+$/, '');
    if (kind === 'csv') {
      downloadFile(`${base}-accountant-case.csv`, buildAccountantCaseCsv(dossiers, decisions, opts), 'text/csv;charset=utf-8');
    } else {
      downloadFile(`${base}-accountant-case.json`, buildAccountantCaseJson(dossiers, decisions, opts), 'application/json');
    }
  }

  return (
    <div className="shell">
      {screen === 'accountant' ? (
        <header className="top minimal" data-testid="accountant-header">
          <span className="brand static"><i />Zenith Ledger · Accountant review</span>
          <span className={`badge ${online ? 'accent' : 'warn'}`} data-testid="net"><span className="dot" />{online ? 'Online' : 'Offline'}</span>
        </header>
      ) : (
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
      )}

      {error && <div className="note warn" role="alert" style={{ marginBottom: 16 }}>{error}</div>}

      {screen === 'upload' && (
        <section>
          {extension ? (
            <>
              <h1>Audit with Zenith</h1>
              <p className="lead">Audit the transaction table on the open page or drop a CSV statement. Names, cards, emails and account numbers are found and replaced on this device before anything reaches the Privacy Firewall.</p>
              <div className="card" style={{ marginBottom: 16 }}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <div>
                    <h3>Open web page</h3>
                    <span className="muted">Extracts the transaction table from the active tab’s DOM on this device and runs it through the same hybrid pipeline.</span>
                  </div>
                  <button className="btn primary" data-testid="audit-page" onClick={auditOpenPage} disabled={busy}>{busy ? 'Reading…' : 'Audit table on this page'}</button>
                </div>
              </div>
            </>
          ) : (
            <>
              <h1>Audit your books with AI,<br />without your bank data leaving your laptop.</h1>
              <p className="lead">Drop a bank statement. Names, cards, emails and account numbers are found and replaced on this device. You see exactly what would be sent, and nothing leaves until you approve it.</p>
            </>
          )}
          <div className={`drop ${over ? 'over' : ''}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); onFile(e.dataTransfer.files[0]); }}>
            <p className="droptitle">{extension ? 'Or drop a CSV statement here' : 'Drop a CSV statement, or a photo of a statement or receipt'}</p>
            <p>CSV columns: date, description, amount. {!extension && 'Photos (JPEG or PNG) are read by the on-device model only.'}</p>
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
            {!extension && (
              <div className="samples">
                <span className="muted">Or try synthetic samples:</span>
                <button className="link" onClick={() => loadSample('q2')} disabled={busy}>Q2 statement (CSV)</button>
                <button className="link" onClick={() => loadSample('q3')} disabled={busy}>Q3 statement (CSV)</button>
                <button className="link" onClick={() => loadSample('q4')} disabled={busy}>Q4 statement (CSV, US dates)</button>
                <button className="link" onClick={() => loadSample('q3-gaps')} disabled={busy}>Q3 with integrity gaps (CSV)</button>
                {config.flags.photoInput && <button className="link" onClick={() => loadSamplePhoto('statement-photo.png', 'statement')} disabled={busy}>Statement photo</button>}
                {config.flags.photoInput && <button className="link" onClick={() => loadSamplePhoto('receipt-photo.png', 'receipt')} disabled={busy}>Receipt photo</button>}
              </div>
            )}
          </div>
          <div className="card mt">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div>
                <h3>On-device AI (Gemini Nano)</h3>
                <span className="muted" data-testid={nano === 'unavailable' ? 'no-nano-notice' : undefined}>
                  {nano === 'ready' ? 'Ready. Names and merchants will be found by the on-device model.'
                    : nano === 'unavailable' ? `${MOBILE_NO_NANO_NOTICE}. Strict mode: only rule-based detectors run, free-text descriptions are dropped from anything sent, and photos cannot be read.`
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
            <div className="card stat" data-testid="anomalies-stat">
              <b>{countFlaggedAnomalies(analysis.signals)}</b>
              <span>anomalies flagged</span>
              {dossiers.some((d) => d.kind === 'anomaly' && d.exportDuplicate) && (
                <span data-testid="export-duplicate-stat" style={{ display: 'block', marginTop: 2, fontSize: 12 }}>
                  +{dossiers.filter((d) => d.kind === 'anomaly' && d.exportDuplicate).length} export duplicate shown separately
                </span>
              )}
            </div>
          </div>
          {analysis.mode === 'strict' && nanoNote && <div className="note mt" role="status">{nanoNote}</div>}
          {analysis.mode === 'strict' && <div className="note mt">Strict mode: person names inside free text are not detected without the on-device model, so free-text descriptions are never included in what is sent.</div>}

          <div className="card mt" data-testid="integrity-check">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div>
                <h3 style={{ margin: 0 }}>Statement integrity check</h3>
                <span className="muted">Deterministic verification of running balances, chronological dates, export duplicates and period coverage. Click any issue to inspect its evidence dossier.</span>
              </div>
              <span className={`badge ${analysis.integrity.length === 0 ? '' : 'warn'}`}>
                <span className="dot" />
                {analysis.integrity.length === 0 ? 'Reconciled · 0 gaps' : `${analysis.integrity.length} integrity ${analysis.integrity.length === 1 ? 'issue' : 'issues'}`}
              </span>
            </div>
            {dossiers.filter((d) => d.kind === 'integrity').length > 0 && (
              <div className="mt">
                {dossiers.filter((d) => d.kind === 'integrity').map((d) => (
                  <DossierRow
                    key={d.id}
                    dossier={d}
                    open={openDossierId === d.id}
                    onToggle={() => setOpenDossierId(openDossierId === d.id ? null : d.id)}
                    decision={decisions[d.id]}
                    onDecision={(status) => updateDecision(d.id, status)}
                    onNote={(note) => updateDecisionNote(d.id, note)}
                    real={real}
                    rowsByIndex={analysis.rows}
                  />
                ))}
              </div>
            )}
          </div>

          <div className="card mt" data-testid="period-comparison">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div style={{ maxWidth: 660 }}>
                <h3 style={{ margin: 0 }}>Period-over-period comparison</h3>
                <span className="muted">
                  {priorPeriod
                    ? `Comparing ${inferPeriodLabel(analysis.period, fileName)} against ${priorPeriod.label} (${priorPeriod.fileName} · aggregate aliases, amounts & counts in IndexedDB, 0 raw rows). Detects new subscriptions, recurring price increases, disappeared recurring charges, and categories growing >= ${config.thresholds.categoryGrowthMinPercent}%.`
                    : `Load a prior statement or use the aggregate period summary saved in IndexedDB (aliases, amounts and counts only; never raw rows) to spot new subscriptions, recurring price increases, disappeared recurring charges, and categories growing >= ${config.thresholds.categoryGrowthMinPercent}%.`}
                </span>
              </div>
              <div className="row">
                {!fileName.includes('q2') && (
                  <button type="button" className="btn small" data-testid="compare-sample-q2" onClick={compareWithSampleQ2} disabled={busy}>
                    Compare with Q2 sample
                  </button>
                )}
                <button type="button" className="btn small" data-testid="compare-upload-btn" onClick={() => priorFileRef.current?.click()} disabled={busy}>
                  Load prior CSV
                </button>
                <input
                  ref={priorFileRef}
                  type="file"
                  accept=".csv,text/csv"
                  hidden
                  data-testid="prior-file"
                  onChange={(e) => { onPriorFile(e.target.files?.[0]); e.target.value = ''; }}
                />
                {savedPeriods
                  .filter((p) => p.id !== `${analysis.period.from}_${analysis.period.to}` && p.id !== priorPeriod?.id)
                  .slice(0, 1)
                  .map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className="btn small"
                      data-testid="compare-saved-period"
                      onClick={() => compareWithSavedSummary(p)}
                      disabled={busy}
                    >
                      Use saved {p.label} (IndexedDB)
                    </button>
                  ))}
                {priorPeriod && (
                  <span className={`badge ${dossiers.filter((d) => d.kind === 'comparison').length === 0 ? '' : 'warn'}`} data-testid="comparison-badge">
                    <span className="dot" />
                    {dossiers.filter((d) => d.kind === 'comparison').length} period{' '}
                    {dossiers.filter((d) => d.kind === 'comparison').length === 1 ? 'change' : 'changes'} vs {priorPeriod.label}
                  </span>
                )}
              </div>
            </div>
            {dossiers.filter((d) => d.kind === 'comparison').length > 0 && (
              <div className="mt">
                {dossiers.filter((d) => d.kind === 'comparison').map((d) => (
                  <DossierRow
                    key={d.id}
                    dossier={d}
                    open={openDossierId === d.id}
                    onToggle={() => setOpenDossierId(openDossierId === d.id ? null : d.id)}
                    decision={decisions[d.id]}
                    onDecision={(status) => updateDecision(d.id, status)}
                    onNote={(note) => updateDecisionNote(d.id, note)}
                    real={real}
                    rowsByIndex={analysis.rows}
                  />
                ))}
              </div>
            )}
          </div>

          <div className="grid g2 mt">
            <div className="card">
              <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
                <h3 style={{ margin: 0 }}>Anomalies &amp; Evidence Dossiers</h3>
                <span className="muted" style={{ fontSize: 12.5 }}>Click an alert for origin rows &amp; decision</span>
              </div>
              {dossiers.filter((d) => d.kind === 'anomaly' && !d.exportDuplicate).length === 0 && <span className="muted">Nothing unusual found.</span>}
              {dossiers.filter((d) => d.kind === 'anomaly' && !d.exportDuplicate).map((d) => (
                <DossierRow
                  key={d.id}
                  dossier={d}
                  open={openDossierId === d.id}
                  onToggle={() => setOpenDossierId(openDossierId === d.id ? null : d.id)}
                  decision={decisions[d.id]}
                  onDecision={(status) => updateDecision(d.id, status)}
                  onNote={(note) => updateDecisionNote(d.id, note)}
                  real={real}
                  rowsByIndex={analysis.rows}
                />
              ))}
              {dossiers.some((d) => d.kind === 'anomaly' && d.exportDuplicate) && (
                <div className="mt" data-testid="export-duplicates-section" style={{ borderTop: '1px solid var(--line)', paddingTop: 12 }}>
                  <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
                    <h4 style={{ margin: 0, fontSize: 13 }}>Confirmed export duplicates (excluded from anomaly count)</h4>
                    <span className="badge"><span className="dot" />Verified by integrity check</span>
                  </div>
                  {dossiers.filter((d) => d.kind === 'anomaly' && d.exportDuplicate).map((d) => (
                    <DossierRow
                      key={d.id}
                      dossier={d}
                      open={openDossierId === d.id}
                      onToggle={() => setOpenDossierId(openDossierId === d.id ? null : d.id)}
                      decision={decisions[d.id]}
                      onDecision={(status) => updateDecision(d.id, status)}
                      onNote={(note) => updateDecisionNote(d.id, note)}
                      real={real}
                      rowsByIndex={analysis.rows}
                    />
                  ))}
                </div>
              )}
            </div>
            <div className="card">
              <h3>Totals</h3>
              <div className="row" style={{ justifyContent: 'space-between' }}><span className="muted">Money in</span><b>{usd(analysis.totals.incomeCents)}</b></div>
              <div className="row mt" style={{ justifyContent: 'space-between', marginTop: 10 }}><span className="muted">Money out</span><b>{usd(-analysis.totals.expenseCents)}</b></div>
              <div className="row" style={{ justifyContent: 'space-between', marginTop: 10 }}><span className="muted">Net</span><b>{usd(analysis.totals.incomeCents - analysis.totals.expenseCents)}</b></div>
              <p className="muted" style={{ fontSize: 13, marginBottom: 0 }}>Computed with integer cents by deterministic code, not by the model.</p>
            </div>
          </div>

          <div className="card mt" data-testid="accountant-pack-builder">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div style={{ maxWidth: 680 }}>
                <h3 style={{ margin: 0 }}>Accountant Review Pack — the accountant gets the proof, not your statement</h3>
                <span className="muted">
                  {askCount === 0
                    ? 'Mark any anomaly or integrity alert above as "Ask my accountant" to package only its pseudonymized origin rows, computed evidence, and your question.'
                    : `${askCount} ${askCount === 1 ? 'alert' : 'alerts'} marked for your accountant. Only those origin rows will be shared, with aliases.`}
                </span>
              </div>
              <div className="row">
                <button type="button" className="btn small" data-testid="export-case-csv" onClick={() => exportCase('csv')}>
                  Export case CSV
                </button>
                <button type="button" className="btn small" data-testid="export-case-json" onClick={() => exportCase('json')}>
                  Export case JSON
                </button>
                <button
                  type="button"
                  className="btn primary"
                  data-testid="review-pack-firewall"
                  disabled={askCount === 0 || busy}
                  onClick={toPackFirewall}
                >
                  Review pack in Privacy Firewall
                </button>
              </div>
            </div>

            {sharedPack && (
              <div className="dossier mt" data-testid="shared-pack-card">
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <div>
                    <b>Expiring accountant review link ready</b>
                    <div className="muted">
                      Sharing {sharedPack.pack.selectedRowCount} of {sharedPack.pack.totalStatementRows} statement rows · expires {new Date(sharedPack.pack.expiresAt).toLocaleString('en-US')}
                    </div>
                  </div>
                  <button type="button" className="btn small" data-testid="refresh-pack-replies" onClick={refreshSharedPackReplies} disabled={busy}>
                    {busy ? 'Checking…' : 'Refresh accountant responses'}
                  </button>
                </div>
                <div className="kv mt">
                  <span>Shareable link (no account required for accountant)</span>
                  <code data-testid="pack-share-url">
                    {`${typeof location !== 'undefined' ? `${location.origin}${location.pathname}` : ''}?pack=${sharedPack.pack.packId}`}
                  </code>
                </div>
                <div className="mt" data-testid="client-pack-replies">
                  <h4>Accountant responses (real names restored locally on this device)</h4>
                  {sharedPack.replies.length === 0 ? (
                    <span className="muted">No responses yet. When your accountant replies using aliases, real names are restored here locally.</span>
                  ) : (
                    <div className="origin-list">
                      {sharedPack.replies.map((r) => {
                        const item = sharedPack.pack.items.find((it) => it.alertId === r.alertId);
                        return (
                          <div className="origin-row" key={r.alertId} data-testid="reidentified-reply">
                            <div className="row" style={{ justifyContent: 'space-between' }}>
                              <b>{real(item?.title ?? r.alertId)}</b>
                              <span className="badge"><span className="dot" />Re-identified locally</span>
                            </div>
                            <p style={{ margin: '6px 0 0' }}>{real(r.reply)}</p>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}
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

      {screen === 'firewall' && analysis && firewallKind === 'audit' && built && (
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

      {screen === 'firewall' && analysis && firewallKind === 'pack' && builtPack && (
        <section data-testid="pack-firewall">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div>
              <h2>Privacy Firewall · Accountant Review Pack</h2>
              <span className="muted">Your accountant gets only the selected alerts, pseudonymized rows, and computed proof. All other rows stay on this device.</span>
            </div>
            <span className="badge accent"><span className="dot" />Expiring pack link</span>
          </div>
          <div className="grid g4 mt">
            <div className="card stat"><b>{builtPack.counters.selectedAlerts}</b><span>alerts in pack</span></div>
            <div className="card stat"><b>{builtPack.counters.selectedRows} / {analysis.rows.length}</b><span>rows included ({builtPack.counters.unselectedRowsExcluded} excluded)</span></div>
            <div className="card stat"><b>{builtPack.counters.rawDescriptionsSent}</b><span>raw descriptions sent</span></div>
            <div className="card stat"><b>{(builtPack.json.length / 1024).toFixed(1)} KB</b><span>pack size</span></div>
          </div>

          <h3 className="mt2">Before and after</h3>
          <div className="diff">
            <div className="col">
              <h3>Stays on this device ({builtPack.counters.unselectedRowsExcluded} unselected rows + real names)</h3>
              {builtPack.pack.items.flatMap((it) => it.rows).slice(0, 5).map((r) => {
                const full = analysis.rows[r.line - 1];
                return <div className="line" key={r.line}>Line #{r.line}: {full ? <Highlighted row={full} /> : ''}</div>;
              })}
            </div>
            <div className="col">
              <h3 className="out">What the accountant gets instead</h3>
              {builtPack.pack.items.flatMap((it) => it.rows).slice(0, 5).map((r) => (
                <div className="line" key={r.line}>
                  <span className="mono">Line #{r.line} · {r.date} · {r.vendorAlias}</span> · {r.category} · <b className="mono">{usd(r.amountCents)}</b>
                </div>
              ))}
            </div>
          </div>

          <h3 className="mt2">Exact Accountant Review Pack JSON</h3>
          <pre className="json" tabIndex={0}>{builtPack.json}</pre>
          <p className="muted" style={{ fontSize: 13 }}>SHA-256 <code>{builtPack.hash}</code></p>

          {!online && <div className="note warn mt">You are offline. Reconnect to publish the expiring review link.</div>}
          <div className="row mt2">
            <button className="btn" onClick={() => setScreen('local')}>Back</button>
            <button className="btn primary" data-testid="approve-pack" disabled={!online || busy} onClick={approvePack}>
              {busy ? 'Creating link…' : 'Approve & create expiring link'}
            </button>
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
          <p className="muted" style={{ fontSize: 13 }}>Receipts and alias maps live in this browser's IndexedDB. Nothing here is uploaded unless you sync the Receipt Vault below.</p>
          {config.flags.receiptVault && (
            <div className="card mt" data-testid="receipt-vault">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <div style={{ maxWidth: 680 }}>
                  <h3>Receipt Vault (opt-in)</h3>
                  <span className="muted">Syncs only receipt metadata (send time, payload SHA-256, field names and counters) across devices via anonymous Firebase Auth and Firestore. Server security rules reject any field outside the allowlist. Alias maps and descriptions never leave this browser.</span>
                </div>
                <div className="row">
                  <button className="btn" onClick={syncReceipts} disabled={vaultBusy || !online || ai.mode === 'none'}>{vaultBusy ? 'Syncing…' : 'Sync receipts'}</button>
                  {vaultOn && <button className="btn" onClick={wipeVault} disabled={vaultBusy || !online}>Delete vault copy</button>}
                </div>
              </div>
              {vaultNote && <p className="muted" style={{ fontSize: 13, margin: '10px 0 0' }} role="status">{vaultNote}</p>}
            </div>
          )}
          <div className="row mt"><button className="btn" onClick={() => setScreen(analysis ? 'local' : 'upload')}>Back</button></div>
        </section>
      )}

      {screen === 'accountant' && (
        <section data-testid="accountant-view">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div>
              <h2>Accountant Review Pack</h2>
              <span className="muted">
                {accountantView
                  ? `Period ${accountantView.pack.periodFrom} to ${accountantView.pack.periodTo} · ${accountantView.pack.selectedRowCount} of ${accountantView.pack.totalStatementRows} statement rows shared · expires ${new Date(accountantView.pack.expiresAt).toLocaleDateString('en-US')}`
                  : 'Loading review pack…'}
              </span>
            </div>
            <span className="badge accent"><span className="dot" />Accountant view · no account required · aliases only</span>
          </div>

          {accountantView && (
            <>
              <div className="card mt">
                <div className="grid g3">
                  <div><span className="muted">Alerts to review</span><div><b>{accountantView.pack.selectedAlertCount}</b></div></div>
                  <div><span className="muted">Rows included</span><div><b>{accountantView.pack.selectedRowCount} / {accountantView.pack.totalStatementRows}</b> (0 raw descriptions)</div></div>
                  <div><span className="muted">Pack SHA-256</span><div><code>{accountantView.pack.hash}</code></div></div>
                </div>
              </div>

              {accountantView.pack.items.map((item) => {
                const savedReply = accountantView.replies[item.alertId];
                const isBusy = replyBusyId === item.alertId;
                return (
                  <div className="card mt" key={item.alertId} data-testid={`pack-item-${item.type}`}>
                    <div className="row" style={{ justifyContent: 'space-between' }}>
                      <div className="sig-main">
                        <div className={`sev ${item.severity === 'high' ? 'high' : item.severity === 'low' ? 'low' : ''}`} style={{ alignSelf: 'stretch' }} />
                        <div>
                          <b>{item.title}</b>
                          <div className="mono">{item.proof}</div>
                        </div>
                      </div>
                      <span className="pill">{item.category}</span>
                    </div>

                    <div className="dossier mt">
                      <h4>Client question</h4>
                      <p style={{ margin: 0 }} data-testid="pack-item-question">{item.question}</p>

                      <h4>Rule &amp; computed evidence</h4>
                      <div className="kv-grid">
                        <div className="kv"><span>Rule</span><b>{item.ruleName}</b></div>
                        <div className="kv"><span>Threshold</span><b className="mono">{item.thresholdSummary}</b></div>
                        <div className="kv"><span>Computed</span><b>{item.computedSummary}</b></div>
                      </div>

                      <h4>Shared pseudonymized origin rows ({item.rows.length})</h4>
                      <div className="tablewrap pack-table">
                        <table>
                          <thead>
                            <tr><th>Line</th><th>Date</th><th>Vendor alias</th><th>Category</th><th className="num">Amount</th><th className="num">Balance</th></tr>
                          </thead>
                          <tbody>
                            {item.rows.map((r) => (
                              <tr key={r.line}>
                                <td className="mono">#{r.line}{r.page !== undefined ? ` (p.${r.page})` : ''}</td>
                                <td className="mono">{r.date}</td>
                                <td className="mono">{r.vendorAlias}</td>
                                <td><span className="pill">{r.category}</span></td>
                                <td className="num">{usd(r.amountCents)}</td>
                                <td className="num">{r.balanceCents !== null ? usd(r.balanceCents) : '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>

                      <h4>Your accounting response (uses aliases; client browser restores real names locally)</h4>
                      <textarea
                        rows={3}
                        className="note-input"
                        data-testid="accountant-reply-input"
                        aria-label={`Accountant response for ${item.title}`}
                        placeholder={`Write your advice referencing ${item.vendorAlias}…`}
                        value={replyDrafts[item.alertId] ?? ''}
                        onChange={(e) => setReplyDrafts((curr) => ({ ...curr, [item.alertId]: e.target.value }))}
                      />
                      <div className="row mt accountant-actions">
                        {ai.cloud && (
                          <button
                            type="button"
                            className="btn small"
                            data-testid="draft-reply-gemini"
                            disabled={isBusy || !online}
                            onClick={() => draftReplyWithAi(item)}
                          >
                            {isBusy ? 'Working…' : 'Draft reply with Gemini (aliases only)'}
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn small primary"
                          data-testid="send-accountant-reply"
                          disabled={isBusy || !online}
                          onClick={() => sendAccountantReply(item)}
                        >
                          Send response
                        </button>
                        {savedReply && <span className="badge" data-testid="reply-saved-badge"><span className="dot" />Response sent</span>}
                      </div>
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </section>
      )}
    </div>
  );
}

const DECISION_LABELS: Record<DecisionStatus, { label: string; badgeClass: string }> = {
  explained: { label: 'Explained', badgeClass: '' },
  ask_accountant: { label: 'Ask my accountant', badgeClass: 'accent' },
  ignore: { label: 'Ignore', badgeClass: 'warn' },
};

function DossierRow({
  dossier,
  open,
  onToggle,
  decision,
  onDecision,
  onNote,
  real,
  rowsByIndex,
}: {
  dossier: EvidenceDossier;
  open: boolean;
  onToggle: () => void;
  decision?: AlertDecision;
  onDecision: (status: DecisionStatus) => void;
  onNote: (note: string) => void;
  real: (t: string) => string;
  rowsByIndex: AnalyzedRow[];
}) {
  return (
    <div className="sig-wrap" data-testid={`alert-${dossier.type}`}>
      <button type="button" className="sig-btn" aria-expanded={open} onClick={onToggle}>
        <div className="sig-main">
          <div className={`sev ${dossier.severity === 'high' ? 'high' : dossier.severity === 'low' ? 'low' : ''}`} style={{ alignSelf: 'stretch' }} />
          <div>
            <b>{real(dossier.title)}</b>
            <div className={dossier.kind === 'integrity' ? 'mono' : 'muted'}>{real(dossier.summary)}</div>
          </div>
        </div>
        <div className="row" style={{ gap: 6, flexShrink: 0 }}>
          {decision && (
            <span className={`badge ${DECISION_LABELS[decision.status].badgeClass}`}>
              {DECISION_LABELS[decision.status].label}
            </span>
          )}
          <span className="pill">{open ? 'Hide dossier' : 'Evidence dossier'}</span>
        </div>
      </button>
      {open && (
        <div className="dossier" data-testid="evidence-dossier">
          <h4>Origin rows ({dossier.sourceRows.length})</h4>
          <div className="origin-list">
            {dossier.sourceRows.map((sr) => {
              const fullRow = sr.rowIndex >= 0 ? rowsByIndex[sr.rowIndex] : undefined;
              return (
                <div className="origin-row" key={`${sr.line}-${sr.date}`}>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <span className="mono">
                      {sr.page !== undefined ? `Page ${sr.page} · ` : ''}Line #{sr.line} · {sr.date} · {sr.vendorAlias} ({real(sr.vendorAlias)})
                    </span>
                    <b className="mono">{usd(sr.amountCents)}{sr.balanceCents !== null ? ` · bal ${usd(sr.balanceCents)}` : ''}</b>
                  </div>
                  <div style={{ marginTop: 4 }}>{fullRow ? <Highlighted row={fullRow} /> : real(sr.description)}</div>
                  {sr.photo && (
                    <div className="muted" style={{ marginTop: 6, fontSize: 12.5 }} data-testid="photo-provenance">
                      Gemini Nano read: <code>{sr.photo.rawDate} · {sr.photo.rawDescription} · {sr.photo.rawAmount}</code>
                      {' · '}
                      <b>{sr.photo.editedByUser ? 'Edited by user in "Check what was read"' : 'Unmodified from Gemini Nano read'}</b>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <h4>Applied rule &amp; Remote Config threshold</h4>
          <div className="kv">
            <b>{dossier.rule.name}</b>
            <span className="mono">{dossier.rule.thresholdSummary}</span>
          </div>

          <h4>Computed evidence</h4>
          <div className="kv-grid">
            {dossier.computed.map((m) => (
              <div className="kv" key={m.label}>
                <span>{m.label}</span>
                <b>{m.value}</b>
              </div>
            ))}
          </div>

          <h4>Your decision (saved in IndexedDB)</h4>
          <div className="decision-bar" role="group" aria-label="Alert decision">
            {(['explained', 'ask_accountant', 'ignore'] as DecisionStatus[]).map((st) => (
              <button
                key={st}
                type="button"
                className={`btn small ${decision?.status === st ? 'active' : ''}`}
                onClick={() => onDecision(st)}
              >
                {DECISION_LABELS[st].label}
              </button>
            ))}
          </div>
          <input
            type="text"
            className="note-input"
            aria-label="Decision note"
            placeholder="Add a note or question for your accountant (stored locally in IndexedDB)…"
            value={decision?.note ?? ''}
            onChange={(e) => onNote(e.target.value)}
          />
        </div>
      )}
    </div>
  );
}
