// Generates two synthetic quarterly statements for a fictional small business.
// Every name, card, IBAN, SSN, EIN and phone below is fake test data.
import { mkdirSync, writeFileSync } from 'node:fs';

function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Tx { date: string; description: string; cents: number }
interface Truth {
  pii: Record<'cards' | 'emails' | 'phones' | 'ibans' | 'accounts' | 'ssns' | 'eins' | 'urls' | 'persons' | 'vendors', string[]>;
  anomalies: {
    duplicates: { vendor: string; cents: number; dates: string[] }[];
    priceIncreases: { vendor: string; fromCents: number; toCents: number; date: string }[];
    outliers: { category: string; vendor: string; cents: number; date: string }[];
    roundTransfers: { cents: number; date: string }[];
    weekendSpend: { vendor: string; cents: number; date: string }[];
  };
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);
const dow = (d: Date) => d.getUTCDay();
const weekday = (d: Date) => (dow(d) === 6 ? addDays(d, -1) : dow(d) === 0 ? addDays(d, -2) : d);
const day = (y: number, m: number, dd: number) => new Date(Date.UTC(y, m, dd));
const cents = (dollars: number) => Math.round(dollars * 100);

const PEOPLE = ['John Smith', 'Maria Garcia', 'Hans Meyer', 'Priya Nair', 'David Okafor', 'Emily Carter', 'Luis Fernandez', 'Sarah Johnson'];
const EMAILS = ['john.smith@gmail.com', 'maria.garcia@outlook.com', 'priya.nair@brightmail.example', 'd.okafor@mail.example', 'emily.carter@gmail.com'];
const PHONES = ['(415) 555-0132', '212-555-0187', '(312) 555-0149', '646.555.0166', '+1 718 555 0123'];
const CARDS = ['4111111111111111', '5555555555554444', '4012888888881881', '6011111111111117'];
const SSNS = ['512-44-7731', '421-18-3306', '314-77-2290'];
const EINS = ['84-1234567', '47-7654321'];
const IBANS = ['DE89370400440532013000', 'GB82WEST12345698765432', 'FR1420041010050500013M02606'];
const ACCTS = ['00123456789', '4400981123', '778120045533', '90210347'];

function build(q: 2 | 3 | 4, year: number, seed: number) {
  const r = rng(seed);
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
  const between = (lo: number, hi: number) => Math.round((lo + r() * (hi - lo)) * 100) / 100;
  const txs: Tx[] = [];
  const truth: Truth = {
    pii: { cards: [], emails: [], phones: [], ibans: [], accounts: [], ssns: [], eins: [], urls: [], persons: [], vendors: [] },
    anomalies: { duplicates: [], priceIncreases: [], outliers: [], roundTransfers: [], weekendSpend: [] },
  };
  const seen = (k: keyof Truth['pii'], v: string) => { if (!truth.pii[k].includes(v)) truth.pii[k].push(v); return v; };
  const vendor = (v: string) => seen('vendors', v);
  const person = (v: string) => seen('persons', v);
  const add = (d: Date, description: string, dollars: number) => txs.push({ date: iso(d), description, cents: cents(dollars) });
  const firstMonth = q === 2 ? 3 : q === 3 ? 6 : 9;

  for (let m = 0; m < 3; m++) {
    const mo = firstMonth + m;
    const dayIn = (n: number) => day(year, mo, n);

    // Fixed monthly items
    add(weekday(dayIn(3)), `${vendor('PINECREST INSURANCE')} ACH premium policy ${seen('accounts', ACCTS[1])!.replace(/^/, 'acct ')}`, -380);
    if (q === 2) {
      add(weekday(dayIn(7)), `${vendor('CLOUDNEST HOSTING')} subscription renewal`, -49);
      add(weekday(dayIn(11)), `${vendor('ATLAS BACKUP PRO')} cloud backup subscription`, -39);
      const nwPrice = m < 2 ? 89 : 99;
      add(weekday(dayIn(12)), `${vendor('NORTHWIND SOFTWARE')} license`, -nwPrice);
      if (m === 2) truth.anomalies.priceIncreases.push({ vendor: 'NORTHWIND SOFTWARE', fromCents: 8900, toCents: 9900, date: iso(weekday(dayIn(12))) });
    } else if (q === 3) {
      const price = m < 2 ? 49 : 59;
      add(weekday(dayIn(7)), `${vendor('CLOUDNEST HOSTING')} subscription renewal`, -price);
      if (m === 2) truth.anomalies.priceIncreases.push({ vendor: 'CLOUDNEST HOSTING', fromCents: 4900, toCents: 5900, date: iso(weekday(dayIn(7))) });
      add(weekday(dayIn(9)), `${vendor('STREAMDESK PRO')} monthly plan`, -15.99);
      add(weekday(dayIn(12)), `${vendor('NORTHWIND SOFTWARE')} license`, -129);
    } else {
      const price = m < 2 ? 15.99 : 19.99;
      add(weekday(dayIn(9)), `${vendor('STREAMDESK PRO')} monthly plan`, -price);
      if (m === 2) truth.anomalies.priceIncreases.push({ vendor: 'STREAMDESK PRO', fromCents: 1599, toCents: 1999, date: iso(weekday(dayIn(9))) });
      add(weekday(dayIn(7)), `${vendor('CLOUDNEST HOSTING')} subscription renewal`, -59);
      add(weekday(dayIn(12)), `${vendor('NORTHWIND SOFTWARE')} license`, -129);
    }
    add(weekday(dayIn(20)), `${vendor('CITY POWER & WATER')} utility bill`, -between(160, 260));
    add(weekday(dayIn(21)), `${vendor('METRO TELECOM')} business line ${seen('phones', PHONES[m % 2])}`, -between(85, 99));
    add(weekday(dayIn(14)), `IRS EFTPS payroll tax EIN ${seen('eins', EINS[0])}`, -between(900, 1100));

    // Contractors (people)
    const c1 = person(PEOPLE[2]);
    add(weekday(dayIn(15)), `Wire to ${c1} IBAN ${seen('ibans', IBANS[m % IBANS.length])} contractor`, -between(1800, 2400));
    const c2 = person(PEOPLE[3]);
    add(weekday(dayIn(28)), `ACH contractor pay ${c2} ${seen('emails', EMAILS[2])}`, -between(1200, 1500));

    // Customer revenue
    const nRev = 9 + Math.floor(r() * 3);
    for (let i = 0; i < nRev; i++) {
      const d = weekday(dayIn(1 + Math.floor(r() * 27)));
      const kind = Math.floor(r() * 4);
      if (kind === 0) add(d, `Zelle payment from ${person(pick(PEOPLE.slice(0, 2).concat(PEOPLE.slice(4))))} ${seen('emails', pick(EMAILS))}`, between(300, 1400));
      else if (kind === 1) add(d, `Invoice ${2200 + txs.length} paid by ${person(pick(PEOPLE.slice(4)))} tel ${seen('phones', pick(PHONES))}`, between(450, 2600));
      else if (kind === 2) add(d, `ACH deposit ${vendor(pick(['Lakeside Dental LLC', 'Redwood Bakery', 'Summit Fitness Co']))} inv ${3100 + txs.length}`, between(700, 2200));
      else add(d, `Online payment ${vendor('Northwind Retail')} ${seen('urls', `https://pay.northwind-retail.example/checkout?token=${Math.floor(r() * 1e12).toString(16).padStart(10, 'a')}`)}`, between(250, 900));
    }

    // Supplies
    const nSup = 5 + Math.floor(r() * 2);
    for (let i = 0; i < nSup; i++) {
      const d = weekday(dayIn(1 + Math.floor(r() * 27)));
      const v = pick(['ACME SUPPLY CO', 'BRIGHTLINE PLUMBING LLC', 'DELTA OFFICE DEPOT']);
      const tail = i === 0 ? ` card ${seen('cards', CARDS[(m + q) % CARDS.length])}` : ` order ${4000 + Math.floor(r() * 5000)}`;
      add(d, `POS DEBIT ${vendor(v)}${tail}`, -between(q === 2 ? 30 : 40, q === 2 ? 110 : 220));
    }
    // Meals
    const nMeals = 10 + Math.floor(r() * 3);
    for (let i = 0; i < nMeals; i++) {
      const d = weekday(dayIn(1 + Math.floor(r() * 27)));
      add(d, `POS DEBIT ${vendor(pick(['HARBOR COFFEE ROASTERS', 'GREEN TABLE CAFE', 'CORNER BISTRO']))}`, -between(8, 62));
    }
    // Travel
    if (m === 1) add(weekday(dayIn(18)), `${vendor('SKYLINE AIRLINES')} ticket ${seen('ssns', SSNS[q === 2 ? 2 : q - 3])} passenger record`, -between(300, 480));
  }

  // --- seeded anomalies
  const dupDay = day(year, firstMonth + 1, 10);
  const dupA = cents(184.2);
  add(dupDay, `POS DEBIT ${vendor('DELTA OFFICE DEPOT')} order 77120`, -184.2);
  add(addDays(dupDay, 1), `POS DEBIT ${vendor('DELTA OFFICE DEPOT')} order 77120`, -184.2);
  truth.anomalies.duplicates.push({ vendor: 'DELTA OFFICE DEPOT', cents: -dupA, dates: [iso(dupDay), iso(addDays(dupDay, 1))] });
  const dup2 = day(year, firstMonth + 2, 4);
  add(dup2, `${vendor('CORNER BISTRO')} client lunch`, -96.35);
  add(addDays(dup2, 2), `${vendor('CORNER BISTRO')} client lunch`, -96.35);
  truth.anomalies.duplicates.push({ vendor: 'CORNER BISTRO', cents: -9635, dates: [iso(dup2), iso(addDays(dup2, 2))] });

  const supDay = weekday(day(year, firstMonth + 1, 22));
  const supOutlierDollars = q === 2 ? 890 : 2380;
  add(supDay, `POS DEBIT ${vendor('BRIGHTLINE PLUMBING LLC')} emergency repair acct ${seen('accounts', ACCTS[q - 1])}`, -supOutlierDollars);
  truth.anomalies.outliers.push({ category: 'Supplies', vendor: 'BRIGHTLINE PLUMBING LLC', cents: -cents(supOutlierDollars), date: iso(supDay) });
  const mealDay = weekday(day(year, firstMonth, 24));
  add(mealDay, `POS DEBIT ${vendor('CORNER BISTRO')} team dinner`, -417.8);
  truth.anomalies.outliers.push({ category: 'Meals', vendor: 'CORNER BISTRO', cents: -41780, date: iso(mealDay) });

  const t1 = day(year, firstMonth, 30 - (q === 3 ? 0 : 1));
  add(weekday(t1), 'Online transfer to savings xfer', -5000);
  truth.anomalies.roundTransfers.push({ cents: -500000, date: iso(weekday(t1)) });
  const t2 = day(year, firstMonth + 2, 16);
  add(weekday(t2), 'Zelle transfer to owner draw', -1500);
  truth.anomalies.roundTransfers.push({ cents: -150000, date: iso(weekday(t2)) });
  add(weekday(day(year, firstMonth + 1, 5)), `Zelle transfer to ${person(PEOPLE[7])} reimbursement`, -237.4);

  // weekend spend: pick a Saturday in month 2
  let wk = day(year, firstMonth + 1, 14);
  while (dow(wk) !== 6) wk = addDays(wk, 1);
  add(wk, `POS DEBIT ${vendor('DELTA OFFICE DEPOT')} order 88231`, -640.15);
  truth.anomalies.weekendSpend.push({ vendor: 'DELTA OFFICE DEPOT', cents: -64015, date: iso(wk) });

  txs.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { txs, truth };
}

const quote = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const money = (c: number) => `${c < 0 ? '-' : ''}${Math.floor(Math.abs(c) / 100)}.${String(Math.abs(c) % 100).padStart(2, '0')}`;

function write(name: string, q: 2 | 3 | 4, year: number, seed: number, usDates: boolean) {
  const { txs, truth } = build(q, year, seed);
  let bal = q === 2 ? 1980000 : 2435000;
  const lines = ['date,description,amount,currency,balance'];
  for (const t of txs) {
    bal += t.cents;
    const [y, m, d] = t.date.split('-');
    const date = usDates ? `${m}/${d}/${y}` : t.date;
    // a few descriptions get a trailing comma clause so the parser is exercised
    const desc = t.cents < 0 && t.description.startsWith('POS DEBIT') && t.cents % 7 === 0 ? `${t.description}, store #12` : t.description;
    lines.push([date, quote(desc), money(t.cents), 'USD', money(bal)].join(','));
  }
  writeFileSync(`public/samples/${name}.csv`, lines.join('\n') + '\n');
  writeFileSync(`public/samples/${name}.truth.json`, JSON.stringify(truth, null, 2) + '\n');
  console.log(name, txs.length, 'rows');
  return { rows: txs.length, truth };
}

mkdirSync('public/samples', { recursive: true });
const q2 = write('acme-q2', 2, 2025, 202, false);
const q3 = write('acme-q3', 3, 2025, 303, false);
const q4 = write('acme-q4', 4, 2025, 404, true);

function writeCorruptedQ3(name: string) {
  const { txs, truth } = build(3, 2025, 303);
  // 1. Incomplete period: drop everything after 2025-09-12 (missing last 18 days of declared Q3)
  // 2. Date gap: drop transactions between 2025-07-16 and 2025-08-03 (creating an 18-day gap)
  const filtered = txs.filter((t) => t.date <= '2025-09-12' && !(t.date > '2025-07-15' && t.date < '2025-08-04'));

  let bal = 2435000;
  const rows: { date: string; desc: string; cents: number; bal: number }[] = [];
  for (const t of filtered) {
    bal += t.cents;
    const desc =
      t.cents < 0 && t.description.startsWith('POS DEBIT') && t.cents % 7 === 0
        ? `${t.description}, store #12`
        : t.description;
    rows.push({ date: t.date, desc, cents: t.cents, bal });
  }

  // 3. Seed an exact export duplicate row right after row 15 (1-based rows 15 and 16 identical)
  const dupTarget = { ...rows[14] };
  rows.splice(15, 0, dupTarget);

  // 4. Seed a running balance jump of -$100.00 (-10,000 cents) between 1-based rows 41 and 42
  const expectedAt42 = rows[40].bal + rows[41].cents;
  const actualAt42 = expectedAt42 - 10000;
  for (let i = 41; i < rows.length; i++) {
    rows[i].bal = (i === 41 ? actualAt42 : rows[i - 1].bal + rows[i].cents);
  }

  const gapIdx = rows.findIndex((r, i) => i > 0 && r.date >= '2025-08-04' && rows[i - 1].date <= '2025-07-15');
  const gapDays =
    Math.round((Date.parse(rows[gapIdx].date + 'T00:00:00Z') - Date.parse(rows[gapIdx - 1].date + 'T00:00:00Z')) / 86400000);

  const missingDays = Math.round(
    (Date.parse('2025-09-30T00:00:00Z') - Date.parse(rows[rows.length - 1].date + 'T00:00:00Z')) / 86400000,
  );

  const fmt = (c: number) =>
    `${c < 0 ? '-' : ''}${(Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const integrityTruth = {
    ...truth,
    integrity: {
      balanceMismatches: [
        {
          rows: [41, 42] as [number, number],
          expectedCents: expectedAt42,
          actualCents: actualAt42,
          proof: `expected ${fmt(expectedAt42)}, statement says ${fmt(actualAt42)}, gap between rows 41–42`,
        },
      ],
      duplicateRows: [
        {
          rows: [15, 16] as [number, number],
          proof: `rows 15 and 16 are identical (date, description, amount, balance ${fmt(dupTarget.bal)}): the balance did not move, so the export repeated the line`,
        },
      ],
      dateGaps: [
        {
          rows: [gapIdx, gapIdx + 1] as [number, number],
          gapDays,
          proof: `no transactions for ${gapDays} days between ${rows[gapIdx - 1].date} (row ${gapIdx}) and ${rows[gapIdx].date} (row ${gapIdx + 1})`,
        },
      ],
      incompletePeriod: {
        declaredFrom: '2025-07-01',
        declaredTo: '2025-09-30',
        actualTo: rows[rows.length - 1].date,
        proof: `statement covers ${rows[0].date} to ${rows[rows.length - 1].date}, declared Q3 is 2025-07-01 to 2025-09-30: ${missingDays} days missing at the end`,
      },
    },
  };

  const lines = ['date,description,amount,currency,balance'];
  for (const r of rows) {
    lines.push([r.date, quote(r.desc), money(r.cents), 'USD', money(r.bal)].join(','));
  }
  writeFileSync(`public/samples/${name}.csv`, lines.join('\n') + '\n');
  writeFileSync(`public/samples/${name}.truth.json`, JSON.stringify(integrityTruth, null, 2) + '\n');
  console.log(name, rows.length, 'rows');
}

writeCorruptedQ3('acme-q3-gaps');

const list = (title: string, f: (t: Truth) => string[]) =>
  `### ${title}\n\n${[q2, q3, q4].map((q, i) => f(q.truth).map((l) => `- acme-q${i + 2}: ${l}`).join('\n')).join('\n')}\n`;
const usd = (c: number) => `$${(Math.abs(c) / 100).toFixed(2)}`;
writeFileSync('public/samples/README.md', `# Sample statements

Synthetic, three months each, USD, for a fictional small business ("Acme").
Everything personal in these files is invented test data: names, emails, phone
numbers, card numbers (Luhn-valid test numbers), IBANs, SSNs and EINs.

- acme-q2.csv: ${q2.rows} rows, ISO dates (Apr-Jun 2025, coherent prior period for Q3 comparison)
- acme-q3.csv: ${q3.rows} rows, ISO dates (Jul-Sep 2025)
- acme-q4.csv: ${q4.rows} rows, MM/DD/YYYY dates (Oct-Dec 2025)
- *.truth.json: the seeded PII and anomalies, used by the privacy rule tests

Regenerate with \`pnpm samples\`.

## Seeded anomalies

${list('Duplicate charges (same merchant and amount, at most 3 days apart)', (t) => t.anomalies.duplicates.map((d) => `${d.vendor} ${usd(d.cents)} on ${d.dates.join(' and ')}`))}
${list('Subscription price increases', (t) => t.anomalies.priceIncreases.map((d) => `${d.vendor} ${usd(d.fromCents)} to ${usd(d.toCents)} on ${d.date}`))}
${list('Outliers within a category', (t) => t.anomalies.outliers.map((d) => `${d.category}: ${d.vendor} ${usd(d.cents)} on ${d.date}`))}
${list('Round transfers (multiples of $500)', (t) => t.anomalies.roundTransfers.map((d) => `${usd(d.cents)} on ${d.date}`))}
${list('Weekend spend (large charge on a Saturday)', (t) => t.anomalies.weekendSpend.map((d) => `${d.vendor} ${usd(d.cents)} on ${d.date}`))}
`);
