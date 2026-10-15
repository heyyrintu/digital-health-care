import { withAuth, type Prisma, type Tx } from '@dhc/db';
import type { Services } from '../../services';
import { AppError } from '../../errors';

const NOT_FOUND = () => new AppError(404, 'NOT_FOUND', 'Not found.');

/**
 * The mobile number the signed-in patient verified by OTP. Read on the auth connection,
 * which is the only one allowed to see users.
 */
export async function accountPhone(s: Services, userId: string): Promise<string> {
  const user = await withAuth(s.db, (tx) =>
    tx.user.findUnique({ where: { id: userId }, select: { phone: true } }),
  );
  if (!user?.phone) throw new AppError(401, 'UNAUTHENTICATED', 'Please sign in again.');
  return user.phone;
}

/**
 * The account's patients (PRD §4): records on the verified number, and the dependants they
 * look after. Row-level security already limits this to the organisation; this is what
 * limits it to the family. Records merged into another are left out: the kept record
 * carries their history.
 */
export function accountPatientsWhere(phone: string): Prisma.PatientWhereInput {
  return { mergedIntoId: null, OR: [{ phone }, { guardian: { phone } }] };
}

/** One of the account's patients, or 404 so other people's records stay invisible. */
export async function ownPatient(tx: Tx, phone: string, patientId: string) {
  const patient = await tx.patient.findFirst({
    where: { AND: [{ id: patientId }, accountPatientsWhere(phone)] },
  });
  if (!patient) throw NOT_FOUND();
  return patient;
}
