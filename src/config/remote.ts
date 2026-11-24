import { fetchAndActivate, getAll, getRemoteConfig } from 'firebase/remote-config';
import { getFirebase } from '../ai/firebase';

/** Raw Remote Config values as strings. Throws when Firebase is not configured or unreachable. */
export async function fetchRemoteValues(): Promise<Record<string, string>> {
  const rc = getRemoteConfig(getFirebase().app);
  rc.settings.fetchTimeoutMillis = 3000;
  rc.settings.minimumFetchIntervalMillis = import.meta.env.DEV ? 0 : 3_600_000;
  await fetchAndActivate(rc);
  return Object.fromEntries(Object.entries(getAll(rc)).map(([key, value]) => [key, value.asString()]));
}
