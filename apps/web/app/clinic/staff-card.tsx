'use client';

import { ApiError } from '@dhc/api-client';
import { CreatedStaffInvite, StaffMemberList, type StaffMember } from '@dhc/contracts';
import { formatIstDateTime } from '@dhc/domain';
import { useCallback, useEffect, useState } from 'react';
import { useSession } from './session-provider';

/** Clinic admin: the team, with a confirm-then-reset for anyone who lost their authenticator. */
export function StaffCard({ currentUserId }: { currentUserId: string }) {
  const { api, locale, signOut, t } = useSession();
  const [members, setMembers] = useState<StaffMember[] | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [link, setLink] = useState<{ userId: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handle = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) return void signOut('expired');
      setError(e instanceof ApiError ? e.message : t('error.network'));
    },
    [signOut, t],
  );

  const load = useCallback(async () => {
    try {
      setMembers((await api.request('GET', '/staff/members', { schema: StaffMemberList })).data);
    } catch (e) {
      handle(e);
    }
  }, [api, handle]);

  useEffect(() => {
    void load();
  }, [load]);

  async function reset(member: StaffMember) {
    setBusy(true);
    setError(null);
    try {
      const created = await api.request(
        'POST',
        `/staff/members/${member.userId}/reset-authenticator`,
        {
          schema: CreatedStaffInvite,
          body: {},
        },
      );
      setLink({ userId: member.userId, url: created.inviteUrl });
      setCopied(false);
      setConfirming(null);
      await load();
    } catch (e) {
      handle(e);
    } finally {
      setBusy(false);
    }
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // Clipboard blocked: the link is still shown for manual copying.
    }
  }

  const nameOf = (m: StaffMember) => m.displayName ?? m.identifier;

  return (
    <section aria-labelledby="staff-title" className="card">
      <h2 id="staff-title">{t('staff.title')}</h2>
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
      {members && (
        <ul className="staff-list">
          {members.map((m) => (
            <li key={m.userId} data-testid={`staff-${m.identifier}`}>
              <div className="staff-row">
                <div>
                  <strong>{nameOf(m)}</strong>
                  {m.userId === currentUserId && <span className="pill">{t('staff.you')}</span>}
                  <p className="hint">
                    {m.identifier} · {m.roles.map((r) => t(`role.${r}`)).join(', ')}
                  </p>
                  <p className="hint">
                    {m.status === 'invited'
                      ? t('staff.invitePending')
                      : m.signInReady
                        ? t('staff.signInReady')
                        : t('staff.signInNotReady')}
                    {' · '}
                    {m.lastLoginAt
                      ? t('staff.lastLogin', { date: formatIstDateTime(m.lastLoginAt, locale) })
                      : t('staff.neverSignedIn')}
                  </p>
                </div>
                {m.userId !== currentUserId && m.status === 'active' && confirming !== m.userId && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setConfirming(m.userId)}
                  >
                    {t('staff.reset')}
                  </button>
                )}
              </div>

              {confirming === m.userId && (
                <div className="confirm" role="group" aria-label={t('staff.reset')}>
                  <p>{t('staff.resetConfirm', { name: nameOf(m) })}</p>
                  <div className="confirm-actions">
                    <button
                      type="button"
                      className="danger"
                      disabled={busy}
                      onClick={() => void reset(m)}
                    >
                      {t('staff.resetDo')}
                    </button>
                    <button type="button" className="secondary" onClick={() => setConfirming(null)}>
                      {t('common.cancel')}
                    </button>
                  </div>
                </div>
              )}

              {link?.userId === m.userId && (
                <div className="notice" role="status">
                  <p>{t('staff.resetLink', { name: nameOf(m) })}</p>
                  <p className="key link" data-testid="reset-link">
                    {link.url}
                  </p>
                  <button type="button" className="secondary" onClick={() => void copy(link.url)}>
                    {copied ? t('staff.copied') : t('staff.copy')}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
