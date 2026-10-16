import { PatientRoute } from '../../src/patient/route';
import { PrescriptionsScreen } from '../../src/patient/screens/prescriptions';

export default function PrescriptionsRoute() {
  return <PatientRoute>{() => <PrescriptionsScreen />}</PatientRoute>;
}
