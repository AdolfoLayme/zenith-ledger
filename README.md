# Zenith Ledger

Audit your books with AI without your bank data ever leaving your laptop.

Zenith Ledger takes a bank statement (CSV), finds and replaces the sensitive parts in your browser, computes the anomalies with plain deterministic code, and shows you the exact JSON that would go to the cloud. Only after you click **Approve & send** does Gemini write the audit narrative and the questions for your accountant. The names come back as aliases (`Vendor_A`) and your browser turns them back into real names locally.

## Why hybrid

Each layer is an explicit choice, not an automatic fallback.

| Layer | Runs | Sees | Does |
| --- | --- | --- | --- |
| Rules (TypeScript) | Browser | Raw rows | CSV parsing, PII detection (Luhn, IBAN mod 97, SSN, EIN, email, phone, token URLs), aliasing, all money math in integer cents, anomaly detection |
| Gemini Nano, `ONLY_ON_DEVICE` | Browser (Chrome) | Raw descriptions, in batches of 20 | Finds person and merchant names, assigns categories |
| Gemini, `ONLY_IN_CLOUD` | Firebase AI Logic | Approved payload only | Explains signals, ranks them, writes the narrative and accountant questions (JSON schema output) |

We never use `PREFER_ON_DEVICE` for raw text. If Nano is missing, that mode would quietly send the text to the cloud, which is the leak this app is built to prevent. Without Nano the app runs in strict mode: detectors only, and free-text descriptions are never part of what is sent. A test (`src/ai/policy.test.ts`) fails if a fallback mode appears in `src/ai`.

## Run it

```
pnpm i
pnpm dev
```

Demo without Firebase, using scripted stand-ins for both models (the privacy logic is the real code):

```
VITE_DEMO_FAKE_AI=1 pnpm dev
```

Real Gemini: copy `.env.example` to `.env`, fill in your Firebase web config, enable Firebase AI Logic and App Check in the console. In development the App Check debug provider is used; register the debug token printed in the browser console.

Gemini Nano: desktop Chrome 139 or newer, enable `chrome://flags/#prompt-api-for-gemini-nano-multimodal-input`, restart, then click **Enable on-device AI** in the app (the model download can take a few minutes and needs a user click).

Other commands: `pnpm test`, `pnpm build`, `pnpm samples` (regenerates the synthetic statements in `public/samples`; all personal data in them is fake).

## What you see

1. Drop a CSV or try a sample.
2. Local analysis: sensitive values highlighted with their alias, counters, anomalies. Works offline.
3. Privacy Firewall: side-by-side before and after, the exact JSON, its SHA-256, counters (found, replaced, raw descriptions sent = 0). If you are offline it says deep analysis waits for the connection.
4. Audit report: findings with real names restored locally, questions for your accountant, and a Data Receipt (time, hash, fields sent) saved in IndexedDB.

## Honest limits

- It minimizes what leaves your device; it does not guarantee anonymity. Detectors can miss things, and without Nano person names in free text are not detected (they stay out of the payload only because descriptions are never sent).
- Review the Firewall screen before approving. That is the point of it.
- This is an exploratory audit, not tax, legal or compliance advice.
- Phase 1 covers CSV input. Statement photos are not implemented yet.
- Gemini Nano limits apply: one turn, about 9k tokens, no tools, desktop Chrome only.
