import type { Tx } from '@dhc/db';
import { AppError } from '../../errors';
/** Shared locks let portal work proceed concurrently; closure waits for in-flight work. */
export async function requirePatientAccountOpen(
  tx: Tx,
  actor: { userId: string; organisationId: string },
  exclusive = false,
) {
  if (exclusive)
    await tx.$queryRaw`SELECT user_id FROM patient_account_access WHERE user_id=${actor.userId}::uuid AND organisation_id=${actor.organisationId}::uuid FOR UPDATE`;
  else
    await tx.$queryRaw`SELECT user_id FROM patient_account_access WHERE user_id=${actor.userId}::uuid AND organisation_id=${actor.organisationId}::uuid FOR SHARE`;
  const row = await tx.patientAccountAccess.findUnique({
    where: {
      organisationId_userId: { organisationId: actor.organisationId, userId: actor.userId },
    },
  });
  if (!row || row.closedAt)
    throw new AppError(
      403,
      'FORBIDDEN',
      'Patient portal access for this clinic is closed. Please contact the clinic.',
      { account: 'closed' },
    );
}
