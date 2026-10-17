import { PatientRoute } from '../../src/patient/route';
import { TestsScreen } from '../../src/patient/screens/tests';

export default function TestsRoute() {
  return <PatientRoute>{() => <TestsScreen />}</PatientRoute>;
}
