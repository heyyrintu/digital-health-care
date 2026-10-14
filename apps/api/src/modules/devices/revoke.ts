import type { Tx } from '@dhc/db';

/**
 * Stops push notifications to every device registered under these sessions. Call it in
 * the same transaction (sign-in role, `withAuth`) that ends the sessions: logout, token
 * reuse, removed access, authenticator resets and staff sign-out.
 */
export async function revokePushDevicesForSessions(
  tx: Tx,
  sessionIds: string[],
  reason: string,
  at: Date,
): Promise<number> {
  if (sessionIds.length === 0) return 0;
  const { count } = await tx.pushDevice.updateMany({
    where: { sessionId: { in: sessionIds }, revokedAt: null },
    data: { revokedAt: at, revokedReason: reason },
  });
  return count;
}

/** Live sessions of a person that a bulk sign-out is about to end, for the helper above. */
export async function liveSessionIds(
  tx: Tx,
  where: { userId: string; staffOnly?: boolean },
): Promise<string[]> {
  const rows = await tx.session.findMany({
    where: {
      userId: where.userId,
      revokedAt: null,
      ...(where.staffOnly ? { role: { not: 'patient' } } : {}),
    },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/**
 * Where to send a push to these people in one clinic: devices that are not removed and
 * whose session is still signed in. For the notification sender.
 */
export async function pushTargets(
  tx: Tx,
  organisationId: string,
  userIds: string[],
  now: Date,
): Promise<{ userId: string; expoPushToken: string; appVariant: 'clinic' | 'patient' }[]> {
  if (userIds.length === 0) return [];
  return tx.pushDevice.findMany({
    where: {
      organisationId,
      userId: { in: userIds },
      revokedAt: null,
      session: { revokedAt: null, expiresAt: { gt: now } },
    },
    select: { userId: true, expoPushToken: true, appVariant: true },
  });
}
