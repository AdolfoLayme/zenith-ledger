// Renders two synthetic "photos" (a printed statement page and a cafe receipt) for the demo.
// Every name, number and address is fake. Each PNG also carries its rows (and the receipt its fields) in tEXt chunks so the
// scripted on-device stand-in (VITE_DEMO_FAKE_AI=1) can "read" it; real Gemini Nano reads the pixels.
// Usage: pnpm photos   (needs a Chromium-based browser; set BROWSER_PATH, default /usr/bin/brave)
import { writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { addPngText } from '../src/core/pngText';

interface Row { date: string; description: string; amount: string }

const statement: Row[] = [
  { date: '09/02/2025', description: 'ACH deposit Summit Fitness Co inv 3120', amount: '2140.00' },
  { date: '09/03/2025', description: 'POS DEBIT BRIGHTSIDE CAFE card 4111111111111111', amount: '-18.75' },
  { date: '09/04/2025', description: 'Zelle payment to Marcus Lee marcus.lee@mail.example', amount: '-450.00' },
  { date: '09/05/2025', description: 'CLOUDNEST HOSTING monthly plan', amount: '-79.00' },
  { date: '09/08/2025', description: 'CLOUDNEST HOSTING monthly plan', amount: '-79.00' },
  { date: '09/09/2025', description: 'Wire to Hans Meyer IBAN GB82WEST12345698765432 contractor', amount: '-1200.00' },
  { date: '09/12/2025', description: 'POS DEBIT DELTA OFFICE DEPOT order 7712', amount: '-64.20' },
  { date: '09/13/2025', description: 'POS DEBIT HARBOR GRILL dinner', amount: '-236.40' },
  { date: '09/15/2025', description: 'ONLINE TRANSFER TO SAVINGS acct 778120045533', amount: '-1000.00' },
  { date: '09/18/2025', description: 'Payment from Priya Nair invoice 3121 tel (415) 555-0132', amount: '980.00' },
  { date: '09/22/2025', description: 'PINECREST INSURANCE ACH premium policy acct 4400981123', amount: '-380.00' },
];

const receipt: Row[] = [
  { date: '09/03/2025', description: 'BRIGHTSIDE CAFE VISA **** 1111 paid by Emily Carter emily.carter@gmail.com', amount: '-18.75' },
];

// What a receipt reader should return: fields, from which the app builds the single row above.
const receiptFields = { merchant: 'BRIGHTSIDE CAFE', date: '09/03/2025', total: '18.75', cardLast4: '1111', payerName: 'Emily Carter', payerEmail: 'emily.carter@gmail.com' };

const money = (s: string) => {
  const n = Number(s);
  return `${n < 0 ? '-' : ''}${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
};

const desk = (inner: string, w: number, h: number, rot: number) => `<!doctype html><html><head><style>
  html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden}
  body{background:radial-gradient(ellipse at 40% 30%,#8a7b6a,#5d5146 70%,#3f372f);display:flex;align-items:center;justify-content:center}
  .paper{transform:rotate(${rot}deg);box-shadow:0 18px 40px rgba(0,0,0,.45),0 2px 6px rgba(0,0,0,.3);position:relative}
  .paper:after{content:"";position:absolute;inset:0;background:linear-gradient(115deg,rgba(255,255,255,.18),rgba(0,0,0,.06) 60%,rgba(0,0,0,.12));pointer-events:none}
</style></head><body>${inner}</body></html>`;

const statementHtml = desk(`<div class="paper" style="width:820px;background:#fbfaf6;padding:36px 40px;font:14px/1.45 'DejaVu Sans',Arial,sans-serif;color:#1d2330">
  <div style="display:flex;justify-content:space-between;align-items:flex-start">
    <div><div style="font-size:22px;font-weight:700;color:#14365c">First Harbor Bank</div><div style="color:#555">Business Checking Statement</div></div>
    <div style="text-align:right;color:#555">Statement period<br><b style="color:#1d2330">Sep 1 - Sep 30, 2025</b></div>
  </div>
  <div style="margin:18px 0 14px;color:#333">ACME PLUMBING LLC &middot; Account ending 0457 &middot; 1200 Harbor Way, Oakland CA 94607</div>
  <table style="width:100%;border-collapse:collapse">
    <tr style="background:#14365c;color:#fff"><th style="text-align:left;padding:6px 8px">Date</th><th style="text-align:left;padding:6px 8px">Description</th><th style="text-align:right;padding:6px 8px">Amount (USD)</th></tr>
    ${statement.map((r, i) => `<tr style="background:${i % 2 ? '#f1efe8' : 'transparent'}"><td style="padding:6px 8px;white-space:nowrap">${r.date}</td><td style="padding:6px 8px">${r.description}</td><td style="padding:6px 8px;text-align:right;font-family:'DejaVu Sans Mono',monospace">${money(r.amount)}</td></tr>`).join('')}
  </table>
  <div style="margin-top:16px;color:#777;font-size:12px">Page 1 of 1 &middot; Member FDIC (fictional bank, sample document)</div>
</div>`, 1000, 760, -1.6);

const receiptHtml = desk(`<div class="paper" style="width:330px;background:#fffefa;padding:26px 24px;font:14px/1.5 'DejaVu Sans Mono',monospace;color:#222">
  <div style="text-align:center;font-weight:700;font-size:18px">BRIGHTSIDE CAFE</div>
  <div style="text-align:center">120 Market St, San Francisco CA</div>
  <div style="text-align:center">09/03/2025 08:14 &middot; Order 5531</div>
  <hr style="border:0;border-top:1px dashed #999;margin:12px 0">
  <div style="display:flex;justify-content:space-between"><span>Oat latte x2</span><span>11.00</span></div>
  <div style="display:flex;justify-content:space-between"><span>Almond croissant</span><span>4.95</span></div>
  <div style="display:flex;justify-content:space-between"><span>Tax</span><span>1.40</span></div>
  <div style="display:flex;justify-content:space-between"><span>Tip</span><span>1.40</span></div>
  <hr style="border:0;border-top:1px dashed #999;margin:12px 0">
  <div style="display:flex;justify-content:space-between;font-weight:700;font-size:16px"><span>TOTAL</span><span>18.75</span></div>
  <div style="margin-top:10px">VISA **** 1111</div>
  <div>Paid by Emily Carter</div>
  <div>Receipt sent to emily.carter@gmail.com</div>
  <div style="text-align:center;margin-top:14px">Thank you!</div>
</div>`, 520, 700, 2.2);

const browser = await chromium.launch({ executablePath: process.env.BROWSER_PATH ?? '/usr/bin/brave' });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const [name, html, rows, w, h] of [['statement-photo', statementHtml, statement, 1000, 760], ['receipt-photo', receiptHtml, receipt, 520, 700]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.setContent(html);
    const png = await page.screenshot({ type: 'png' });
    let out = addPngText(new Uint8Array(png), 'zenith-rows', JSON.stringify(rows));
    if (name === 'receipt-photo') out = addPngText(out, 'zenith-fields', JSON.stringify(receiptFields));
    writeFileSync(`public/samples/${name}.png`, out);
    console.log(`public/samples/${name}.png (${rows.length} rows)`);
  }
} finally {
  await browser.close();
}
