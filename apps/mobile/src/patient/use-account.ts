import type { PatientAccountState } from '@dhc/api-client';
import { useEffect, useSyncExternalStore } from 'react';
import { patientAccount } from '../api';

export function useAccount(): PatientAccountState {
  const state = useSyncExternalStore(patientAccount.subscribe, patientAccount.getState);
  useEffect(() => {
    void patientAccount.ensureLoaded();
  }, []);
  return state;
}
