# Zenith Ledger

Audit your books with AI without your bank data ever leaving your laptop.

**Live demo:** https://zenith-ledger-app.web.app (desktop Chrome for Gemini Nano; any browser runs the strict mode)

Zenith Ledger takes a bank statement (CSV, or a photo of a statement or receipt), finds and replaces the sensitive parts in your browser, computes the anomalies with plain deterministic code, and shows you the exact JSON that would go to the cloud. Only after you click **Approve & send** does Gemini write the audit narrative and the questions for your accountant. The names come back as aliases (`Vendor_A`) and your browser turns them back into real names locally.

## Why hybrid

Each layer is an explicit choice, not an automatic fallback.

| Layer | Runs | Sees | Does |
| --- | --- | --- | --- |
| Rules (TypeScript) | Browser | Raw rows | CSV parsing, PII detection (Luhn, IBAN mod 97, SSN, EIN, email, phone, token URLs), aliasing, all money math in integer cents, anomaly detection |
| Gemini Nano, `ONLY_ON_DEVICE` | Browser (Chrome) | Raw descriptions in batches of 20, statement photos | Finds person and merchant names, assigns categories, reads rows from JPEG/PNG photos, writes the offline summary (structured JSON output via `responseConstraint`) |
| Gemini, `ONLY_IN_CLOUD` | Firebase AI Logic | Approved payload only | Explains signals, ranks them, writes the narrative and accountant questions (JSON schema output) |

We never use `PREFER_ON_DEVICE` for raw text. If Nano is missing, that mode would quietly send the text to the cloud, which is the leak this app is built to prevent. Without Nano the app runs in strict mode: detectors only, and free-text descriptions are never part of what is sent. A test (`src/ai/policy.test.ts`) fails if a fallback mode appears in `src/ai`.

Photos follow the same rule. A statement photo is raw, unredacted data, so only Gemini Nano may read it. Without Nano the app refuses the photo with a clear message and it is not uploaded or sent anywhere (`src/ai/photo.test.ts` checks that no network call happens).

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

Gemini Nano: desktop Chrome 139 or newer. Click **Enable on-device AI** in the app; the first download (about 4 GB) takes a few minutes and needs that click. Once downloaded, the app starts the model by itself on later visits. If the button reports the model as unavailable, enable `chrome://flags/#prompt-api-for-gemini-nano-multimodal-input` and restart Chrome. Tested on Chrome 157 (Linux).

Other commands:

- `pnpm test`: unit tests and the design rules written as tests (`src/core/privacy.rules.test.ts`, `src/ai/policy.test.ts`).
- `pnpm e2e`: UI tests of the whole flow in a headless Chromium-based browser with the scripted stand-ins. Set `BROWSER_PATH` if your browser is not `/usr/bin/brave`. `SHOTS_DIR=<dir> pnpm e2e screens` also saves desktop and mobile screenshots.
- `pnpm build`: type check and production build into `dist/`.
- `pnpm samples` regenerates the synthetic CSV statements and `pnpm photos` the synthetic statement and receipt photos in `public/samples`. All personal data in them is fake. The sample photos also carry their rows in a PNG text chunk, which is how the scripted stand-in "reads" them in demo mode; real Gemini Nano reads the pixels.

## Deploy to Firebase Hosting

`firebase.json` serves `dist/` as a single-page app. `.firebaserc` points at the demo project (`zenith-ledger-app`); use your own id for your deploy.

1. Create a Firebase project, enable **AI Logic** (Gemini Developer API) and register a web app. App Check is enforced for AI Logic: create a reCAPTCHA Enterprise key and register it as the App Check provider for the web app.
2. Put the web config and the reCAPTCHA Enterprise site key in `.env` (see `.env.example`), with `VITE_DEMO_FAKE_AI=0`.
3. Put your project id in `.firebaserc`.
4. Build and deploy:

```
pnpm build
pnpm dlx firebase-tools login
pnpm dlx firebase-tools deploy --only hosting
```

To check the config locally without an account: `pnpm dlx firebase-tools emulators:start --only hosting --project demo-zenith-ledger`.

## What you see

1. Drop a CSV or a statement/receipt photo, or try a sample. Photos need on-device AI turned on.
2. Local analysis: sensitive values highlighted with their alias, counters, anomalies. Works offline: without a connection, Gemini Nano writes a short summary from the anonymized overview (aliases and computed numbers only), and names are restored locally for display.
3. Privacy Firewall: side-by-side before and after, the exact JSON, its SHA-256, counters (found, replaced, raw descriptions sent = 0). If you are offline it says deep analysis waits for the connection.
4. Audit report: findings with real names restored locally, questions for your accountant, and a Data Receipt (time, hash, fields sent) saved in IndexedDB.
5. Data Receipts (top right): every approved send with its time, SHA-256 and fields. **Delete all** removes the receipts and the stored alias maps from this browser.

## Honest limits

- It minimizes what leaves your device; it does not guarantee anonymity. Detectors can miss things, and without Nano person names in free text are not detected (they stay out of the payload only because descriptions are never sent).
- Review the Firewall screen before approving. That is the point of it.
- This is an exploratory audit, not tax, legal or compliance advice.
- Photo reading quality depends on Gemini Nano and the picture. Check the rows on the Local analysis screen before sending anything.
- Gemini Nano limits apply: one turn, about 9k tokens, no tools, desktop Chrome only.

## License

Apache License 2.0, see `LICENSE`.
