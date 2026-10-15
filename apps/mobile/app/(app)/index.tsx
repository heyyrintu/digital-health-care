import { Redirect } from 'expo-router';
import { Home } from '../../src/screens/home';
import { useSession } from '../../src/session-context';

export default function HomeRoute() {
  const state = useSession();
  if (state.status !== 'signed_in') return <Redirect href="/sign-in" />;
  return <Home me={state.me} />;
}
