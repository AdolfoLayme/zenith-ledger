export const MOBILE_NO_NANO_NOTICE =
  'On-device AI is not available on this device: local rules still run; cloud only sees aliases after your approval';

/** Detects Android, iPhone, iPad, and iPod user agents where Chrome desktop's Gemini Nano is unavailable. */
export function isMobileDevice(
  userAgent: string = typeof navigator !== 'undefined' ? navigator.userAgent : '',
): boolean {
  return /\b(Android|iPhone|iPad|iPod|Mobile)\b/i.test(userAgent);
}

export interface SwEnv {
  protocol?: string;
  serviceWorker?: {
    register(url: string, opts?: { scope?: string }): Promise<unknown>;
  };
}

/** Registers the hand-written app-shell service worker on http/https origins. */
export async function registerServiceWorker(env?: SwEnv): Promise<void> {
  const protocol = env?.protocol ?? (typeof location !== 'undefined' ? location.protocol : '');
  if (protocol !== 'http:' && protocol !== 'https:') return;
  const sw =
    env?.serviceWorker ??
    (typeof navigator !== 'undefined' && 'serviceWorker' in navigator ? navigator.serviceWorker : undefined);
  if (!sw) return;
  try {
    await sw.register('/sw.js', { scope: '/' });
  } catch {
    // Non-fatal in private windows or restricted test contexts
  }
}
