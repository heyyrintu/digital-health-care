import { PatientRoute } from '../../src/patient/route';
import { BookScreen } from '../../src/patient/screens/book';

export default function BookRoute() {
  return <PatientRoute>{(account) => <BookScreen account={account} />}</PatientRoute>;
}
