import { Redirect } from 'expo-router';
import { QueueScreen } from '../../src/clinic/queue-screen';
import { Home } from '../../src/screens/home';
import { useSession } from '../../src/session-context';
import { variant } from '../../src/variant';

export default function HomeRoute() {
  const state = useSession();
  if (state.status !== 'signed_in') return <Redirect href="/sign-in" />;
  return variant === 'clinic' ? <QueueScreen me={state.me} /> : <Home me={state.me} />;
}
