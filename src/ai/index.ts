import { createCloudAuditor } from './cloud';
import { DEMO_FAKE_AI, firebaseConfigured } from './firebase';
import { fakeCloud } from './fakeCloud';
import { fakeOnDevice } from './fakeOnDevice';
import { createOnDevice } from './onDevice';
import type { CloudAuditor, OnDevice } from './types';

export type AiMode = 'demo' | 'firebase' | 'none';

export function getAi(): { mode: AiMode; onDevice: OnDevice | null; cloud: CloudAuditor | null } {
  if (DEMO_FAKE_AI) return { mode: 'demo', onDevice: fakeOnDevice, cloud: fakeCloud };
  if (!firebaseConfigured) return { mode: 'none', onDevice: null, cloud: null };
  return { mode: 'firebase', onDevice: createOnDevice(), cloud: createCloudAuditor() };
}
