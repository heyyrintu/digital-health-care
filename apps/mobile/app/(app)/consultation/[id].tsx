import { Redirect, useLocalSearchParams } from 'expo-router';
import { ConsultationScreen } from '../../../src/clinic/consult/consultation-screen';
import { useSession } from '../../../src/session-context';

export default function ConsultationRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const state = useSession();
  if (state.status !== 'signed_in') return <Redirect href="/sign-in" />;
  if (state.me.role !== 'doctor') return <Redirect href="/" />;
  return <ConsultationScreen appointmentId={id} />;
}
