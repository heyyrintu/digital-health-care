import { Redirect } from 'expo-router';
import { PatientGate } from '../../src/patient/gate';
import { PatientHome } from '../../src/patient/screens/home';
import { Home } from '../../src/screens/home';
import { useSession } from '../../src/session-context';
import { variant } from '../../src/variant';

export default function HomeRoute() {
  const state = useSession();
  if (state.status !== 'signed_in') return <Redirect href="/sign-in" />;
  if (variant === 'patient') {
    return (
      <PatientGate>{(account) => <PatientHome me={state.me} account={account} />}</PatientGate>
    );
  }
  return <Home me={state.me} />;
}
