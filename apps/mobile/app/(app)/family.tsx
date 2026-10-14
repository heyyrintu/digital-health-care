import { PatientRoute } from '../../src/patient/route';
import { FamilyScreen } from '../../src/patient/screens/family';

export default function FamilyRoute() {
  return <PatientRoute>{(account) => <FamilyScreen account={account} />}</PatientRoute>;
}
