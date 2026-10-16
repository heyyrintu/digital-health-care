import { Redirect } from 'expo-router';
import type { ReactNode } from 'react';
import { variant } from '../variant';
import { PatientGate, type ReadyAccount } from './gate';

/** A Patient app route: behind onboarding, and not part of the Clinic app. */
export function PatientRoute({ children }: { children: (account: ReadyAccount) => ReactNode }) {
  if (variant !== 'patient') return <Redirect href="/" />;
  return <PatientGate>{children}</PatientGate>;
}
