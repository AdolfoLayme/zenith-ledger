import { initializeApp, type FirebaseApp } from 'firebase/app';
import { getAI, GoogleAIBackend, type AI } from 'firebase/ai';
import { CustomProvider, initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';

const env = import.meta.env;

export const isChromeExtension = () => typeof location !== 'undefined' && location.protocol === 'chrome-extension:';
export const DEMO_FAKE_AI =
  env.VITE_DEMO_FAKE_AI === '1' ||
  (typeof location !== 'undefined' && new URLSearchParams(location.search).get('demo') === '1');
export const firebaseConfigured = Boolean(env.VITE_FIREBASE_API_KEY && env.VITE_FIREBASE_PROJECT_ID && env.VITE_FIREBASE_APP_ID);

let cached: { app: FirebaseApp; ai: AI } | null = null;

export function getFirebase(): { app: FirebaseApp; ai: AI } {
  if (cached) return cached;
  if (!firebaseConfigured) throw new Error('Firebase is not configured. Copy .env.example to .env and fill it in.');
  const app = initializeApp({
    apiKey: env.VITE_FIREBASE_API_KEY,
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: env.VITE_FIREBASE_PROJECT_ID,
    appId: env.VITE_FIREBASE_APP_ID,
  });
  const ext = isChromeExtension();
  if (env.DEV || ext) {
    // Local development and the Chrome extension use the App Check debug token provider; register the token printed in the console.
    (self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN: boolean | string }).FIREBASE_APPCHECK_DEBUG_TOKEN =
      env.VITE_APPCHECK_DEBUG_TOKEN || true;
  }
  if (ext) {
    initializeAppCheck(app, {
      provider: new CustomProvider({
        getToken: () => Promise.reject(new Error('Chrome extension uses App Check debug token mode.')),
      }),
      isTokenAutoRefreshEnabled: true,
    });
  } else if (env.VITE_APPCHECK_SITE_KEY || env.DEV) {
    initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(env.VITE_APPCHECK_SITE_KEY ?? 'debug'), isTokenAutoRefreshEnabled: true });
  }
  cached = { app, ai: getAI(app, { backend: new GoogleAIBackend() }) };
  return cached;
}
