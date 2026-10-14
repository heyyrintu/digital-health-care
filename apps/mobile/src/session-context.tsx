import { useSyncExternalStore } from 'react';
import { session } from './api';
import type { SessionState } from './auth/session';

export function useSession(): SessionState {
  return useSyncExternalStore(session.subscribe, session.getState);
}
