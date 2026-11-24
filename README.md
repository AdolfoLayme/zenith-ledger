# Zenith Ledger

Audit your books with AI without your bank data ever leaving your laptop.

**Live demo:** https://zenith-ledger-app.web.app (desktop Chrome for Gemini Nano; any browser runs the strict mode)

Zenith Ledger takes a bank statement (CSV, a photo of a statement or receipt, or a transaction table on an open web page via the Chrome extension), finds and replaces the sensitive parts in your browser, computes the anomalies with plain deterministic code, and shows you the exact JSON that would go to the cloud. Only after you click **Approve & send** does Gemini write the audit narrative and the questions for your accountant. The names come back as aliases (`Vendor_A`) and your browser turns them back into real names locally.

## Platforms

- **Web application (`src/`):** single-page app hosted on Firebase Hosting. Runs hybrid on-device + cloud AI in desktop Chrome with Gemini Nano, and deterministic strict mode in any desktop or mobile browser.
- **Chrome Extension, Manifest V3 (`extension/`):** **Audit with Zenith** side panel that extracts the transaction table directly from the DOM of the open web page (for example, an online banking activity page) or accepts a dropped CSV statement, and runs the exact same `src/core` and `src/ai` pipeline on your device before anything reaches the Privacy Firewall.

## Why hybrid

Each layer is an explicit choice, not an automatic fallback.

| Layer | Runs | Sees | Does |
| --- | --- | --- | --- |
| Rules (TypeScript) | Browser / Extension | Raw rows (CSV, photo review, or DOM table) | Parsing, PII detection (Luhn, IBAN mod 97, SSN, EIN, email, phone, token URLs), aliasing, all money math in integer cents, anomaly detection |
| Gemini Nano, `ONLY_ON_DEVICE` | Browser / Extension (Chrome) | Raw descriptions in batches of 20, statement & receipt photos | Finds person and merchant names, assigns categories, reads rows/fields from JPEG/PNG photos, writes the offline summary (structured JSON output via `responseConstraint`) |
| Gemini, `ONLY_IN_CLOUD` | Firebase AI Logic | Approved payload only | Explains signals, ranks them, writes the narrative and accountant questions (JSON schema output) |

We never use `PREFER_ON_DEVICE` for raw text. If Nano is missing, that mode would quietly send the text to the cloud, which is the leak this app is built to prevent. Without Nano the app runs in strict mode: detectors only, and free-text descriptions are never part of what is sent. A test (`src/ai/policy.test.ts`) fails if a fallback mode appears in `src/ai`.

Photos follow the same rule. A statement photo is raw, unredacted data, so only Gemini Nano may read it. Without Nano the app refuses the photo with a clear message and it is not uploaded or sent anywhere (`src/ai/photo.test.ts` checks that no network call happens).

## Firebase products used

| Firebase product | What it does in Zenith Ledger |
| --- | --- |
| **Firebase AI Logic (`firebase/ai`)** | Drives both inference layers through the Gemini Developer API: `InferenceMode.ONLY_ON_DEVICE` for local entity extraction, photo reading and offline summaries with Gemini Nano, and `InferenceMode.ONLY_IN_CLOUD` with `responseSchema` for the user-approved anonymized audit payload. |
| **Firebase App Check (`firebase/app-check`)** | Protects Firebase AI Logic and backend calls with **reCAPTCHA Enterprise** on the web app, and uses the **App Check debug token flow** in local development and inside the Manifest V3 Chrome extension. |
| **Firebase Remote Config (`firebase/remote-config`)** | Configures anomaly detection thresholds (`anomaly_thresholds`: duplicate window days, minimum price-increase percent, outlier z-score and sample floor, round-transfer minimum and multiple, weekend spend minimum), the cloud Gemini model name (`cloud_model`), and feature flags (`feature_flags`: `receiptVault`, `offlineSummary`, `photoInput`) without a new release (`remoteconfig.template.json`, `src/config/`). Validated defaults live in code so the app works identically offline. |
| **Firebase Authentication (`firebase/auth`)** | Anonymous sign-in for the opt-in **Receipt Vault**, scoping every synced Data Receipt to the user's own `uid` without asking for an email or password. |
| **Cloud Firestore (`firebase/firestore`)** | Powers the opt-in **Receipt Vault** (`src/vault/`, `firestore.rules`). Syncs only receipt metadata (send time, payload SHA-256, allowlisted payload field names and counters) across devices — never descriptions, rows or alias maps. Server security rules enforce owner-only access (`request.auth.uid == uid`) and reject any field, type or length outside the metadata allowlist, so raw data cannot be stored even by a modified client. |
| **Firebase Hosting** | Serves the web app at https://zenith-ledger-app.web.app with SPA rewrites, security headers (`X-Content-Type-Options`, `Permissions-Policy`) and immutable asset caching (`firebase.json`). |

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

- `pnpm test`: unit tests and the design rules written as tests (`src/core/privacy.rules.test.ts`, `src/ai/policy.test.ts`, `src/config/config.test.ts`, `src/vault/receipt.test.ts`, `src/vault/sync.test.ts`, `extension/extractTable.test.ts`).
- `pnpm test:rules`: runs the 20 Firestore security rule tests (`src/vault/rules.test.ts`) against the local Firebase Auth and Firestore emulators.
- `pnpm e2e`: Playwright UI tests of the web flow and the packaged Chrome MV3 extension in a Chromium-based browser with the scripted stand-ins. Set `BROWSER_PATH` if your browser is not `/usr/bin/brave`. `SHOTS_DIR=<dir> pnpm e2e screens` also saves desktop and mobile screenshots.
- `pnpm build`: type check and production web build into `dist/`.
- `pnpm build:ext`: type check and production Chrome MV3 extension build into `extension/dist/`.
- `pnpm samples` regenerates the synthetic CSV statements and `pnpm photos` the synthetic statement and receipt photos in `public/samples`. All personal data in them is fake. The sample photos also carry their rows in a PNG text chunk, which is how the scripted stand-in "reads" them in demo mode; real Gemini Nano reads the pixels.

## Try the Chrome Extension ("Audit with Zenith")

1. Build the extension into `extension/dist/`:

```
pnpm build:ext
```

(Or build with the scripted model stand-ins so it runs without a Firebase project: `VITE_DEMO_FAKE_AI=1 pnpm build:ext`.)

2. Open `chrome://extensions` in desktop Chrome, enable **Developer mode** (top right), click **Load unpacked**, and choose the `extension/dist` directory.
3. Open a page containing a transaction table — for example https://zenith-ledger-app.web.app/samples/bank-statement.html (or `http://localhost:5173/samples/bank-statement.html` while `pnpm dev` is running).
4. Click the **Zenith Ledger — Audit with Zenith** toolbar button to open the side panel, then click **Audit table on this page** (or drop a CSV statement directly into the side panel).
5. The table is extracted from the active tab's DOM on your device and goes through the same Local analysis → Privacy Firewall → Audit report flow.
6. When running against live Firebase AI Logic (`VITE_DEMO_FAKE_AI=0`), the extension activates Firebase App Check in debug-token mode: open the side panel's DevTools console once, copy the printed debug token, and register it under **Firebase Console → App Check → Apps → Manage debug tokens**.

## Deploy to Firebase

`firebase.json` configures Hosting (`dist/`), Remote Config (`remoteconfig.template.json`), and Firestore security rules (`firestore.rules`). `.firebaserc` points at the demo project (`zenith-ledger-app`); use your own id for your deploy.

1. Create a Firebase project, enable **AI Logic** (Gemini Developer API), **Remote Config**, **Firestore**, and **Authentication** (Anonymous sign-in provider), and register a web app. App Check is enforced for AI Logic: create a reCAPTCHA Enterprise key and register it as the App Check provider for the web app.
2. Put the web config and the reCAPTCHA Enterprise site key in `.env` (see `.env.example`), with `VITE_DEMO_FAKE_AI=0`.
3. Put your project id in `.firebaserc`.
4. Build and deploy:

```
pnpm build
pnpm dlx firebase-tools@latest login
pnpm dlx firebase-tools@latest deploy --only hosting,firestore:rules,remoteconfig
```

To check Hosting locally without an account: `pnpm dlx firebase-tools@latest emulators:start --only hosting --project demo-zenith-ledger`.

## What you see

1. Drop a CSV or a statement/receipt photo, try a sample, or click **Audit table on this page** in the Chrome extension side panel. Photos need on-device AI turned on.
2. Local analysis: sensitive values highlighted with their alias, counters, anomalies. Works offline: without a connection, Gemini Nano writes a short summary from the anonymized overview (aliases and computed numbers only), and names are restored locally for display.
3. Privacy Firewall: side-by-side before and after, the exact JSON, its SHA-256, counters (found, replaced, raw descriptions sent = 0). If you are offline it says deep analysis waits for the connection.
4. Audit report: findings with real names restored locally, questions for your accountant, and a Data Receipt (time, hash, fields sent, counters) saved in IndexedDB.
5. Data Receipts (top right): every approved send with its time, SHA-256 and fields. **Sync receipts** (opt-in Receipt Vault) syncs only the allowlisted receipt metadata across devices via anonymous Firebase Auth and Firestore. **Delete all** removes the receipts and the stored alias maps from this browser.

## Built during the submission period

This repository was started on Nov 10, 2026 (one day before the #BuildHybridAI 2026 submission period opened on Nov 11, 2026 at 1:30 PM PT).

**Existed before Nov 11, 2026 (1:30 PM PT):**
- Initial project setup, synthetic CSV statement generator, deterministic CSV parser, PII detectors, aliasing, anomaly math, payload builder with unit tests, the initial four-step web UI with scripted model stand-ins, and an untested `firebase/ai` wrapper.

**Built during the submission period (Nov 11 – Nov 30, 2026):**
- **Live Firebase project & end-to-end hybrid integration:** configured Firebase AI Logic (`ONLY_ON_DEVICE` and `ONLY_IN_CLOUD`), App Check with reCAPTCHA Enterprise and debug token support, and Firebase Hosting deployment (https://zenith-ledger-app.web.app).
- **Real Gemini Nano on-device hardening:** auto-starts Nano when already downloaded, reports batch progress, declares English input/output in `createOptions`, matches model answers by line number, validates that any person or merchant named by the model actually appears in that row, deduplicates repeated descriptions (cutting on-device calls by ~38%), restores names even when a model pluralizes an alias (`Vendors_C`), and displays an explicit notice if on-device reading fails instead of silently dropping to strict mode.
- **On-device statement & receipt photo pipeline:** added synthetic photo generators, separate statement vs. receipt photo prompts and JSON schemas for Gemini Nano (`ONLY_ON_DEVICE`), an interactive **Check what was read** review screen before analysis, and a detector for misread card numbers with missing digits.
- **Firebase Remote Config (`src/config/`, `remoteconfig.template.json`):** live configuration of anomaly thresholds (`duplicateWindowDays`, `priceIncreaseMinPercent`, `outlierZ`, `outlierMinSamples`, `roundTransferMinCents`, `roundTransferMultipleCents`, `weekendMinCents`), cloud model name (`cloud_model`), and feature flags (`receiptVault`, `offlineSummary`, `photoInput`) with validated in-code fallbacks for offline use.
- **Opt-in Receipt Vault (`src/vault/`, `firestore.rules`):** cross-device synchronization of Data Receipts (timestamp, payload SHA-256, field names, and counters — never statement content or alias maps) using anonymous Firebase Auth and Cloud Firestore, backed by strict server-side Firestore security rules tested against the Firebase Emulator Suite (`src/vault/rules.test.ts`).
- **Chrome Extension MV3 ("Audit with Zenith", `extension/`):** side-panel extension reusing `src/core` and `src/ai` to audit transaction tables extracted directly from the active web page's DOM (plus dropped CSV files), built with Vite (`pnpm build:ext`) and verified with an end-to-end Playwright Chromium extension test (`e2e/extension.spec.ts`).

## Honest limits

- It minimizes what leaves your device; it does not guarantee anonymity. Detectors can miss things, and without Nano person names in free text are not detected (they stay out of the payload only because descriptions are never sent).
- Review the Firewall screen before approving. That is the point of it.
- This is an exploratory audit, not tax, legal or compliance advice.
- Photo reading quality depends on Gemini Nano and the picture. Check the rows on the review screen before sending anything.
- Gemini Nano limits apply: one turn, about 9k tokens, no tools, desktop Chrome only.

## License

Apache License 2.0, see `LICENSE`.
