import { useEffect, useSyncExternalStore } from 'react';
import { patientAccount } from '../api';
import type { AccountState } from './account';

export function useAccount(): AccountState {
  const state = useSyncExternalStore(patientAccount.subscribe, patientAccount.getState);
  useEffect(() => {
    void patientAccount.ensureLoaded();
  }, []);
  return state;
}
