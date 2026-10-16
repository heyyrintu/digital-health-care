import { PatientRoute } from '../../src/patient/route';
import { PrivacyScreen } from '../../src/patient/screens/privacy';

export default function PrivacyRoute() {
  return <PatientRoute>{() => <PrivacyScreen />}</PatientRoute>;
}
