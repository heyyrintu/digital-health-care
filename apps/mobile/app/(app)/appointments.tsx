import { PatientRoute } from '../../src/patient/route';
import { AppointmentsScreen } from '../../src/patient/screens/appointments';

export default function AppointmentsRoute() {
  return <PatientRoute>{() => <AppointmentsScreen />}</PatientRoute>;
}
