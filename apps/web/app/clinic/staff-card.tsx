'use client';

import { ApiError } from '@dhc/api-client';
import {
  CreatedStaffInvite,
  STAFF_ROLES,
  StaffInviteList,
  StaffMemberList,
  type StaffInvite,
  type StaffMember,
} from '@dhc/contracts';
import { formatIstDateTime } from '@dhc/domain';
import type { MessageKey } from '@dhc/i18n';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useSession } from './session-provider';

/**
 * Clinic admin: the active team (with confirm-then-reset), inviting new staff, and the
 * invites still waiting to be accepted.
 */
export function StaffCard({ currentUserId }: { currentUserId: string }) {
  const { api, locale, signOut, t } = useSession();
  const [members, setMembers] = useState<StaffMember[] | null>(null);
  const [pending, setPending] = useState<StaffInvite[] | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  /** The one link currently on screen: after a reset (keyed by user) or a new invite. */
  const [link, setLink] = useState<{ key: string; name: string; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
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
      const [team, invites] = await Promise.all([
        api.request('GET', '/staff/members', { schema: StaffMemberList }),
        api.request('GET', '/staff/invites', { schema: StaffInviteList }),
      ]);
      setMembers(team.data.filter((m) => m.status === 'active'));
      setPending(invites.data.filter((i) => i.status === 'pending'));
    } catch (e) {
      handle(e);
    }
  }, [api, handle]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setFieldError(null);
    try {
      await action();
    } catch (e) {
      handle(e);
    } finally {
      setBusy(false);
    }
  }

  const reset = (member: StaffMember) =>
    run(async () => {
      const created = await api.request(
        'POST',
        `/staff/members/${member.userId}/reset-authenticator`,
        { schema: CreatedStaffInvite, body: {} },
      );
      setLink({ key: `user:${member.userId}`, name: nameOf(member), url: created.inviteUrl });
      setConfirming(null);
      await load();
    });

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const identifier = String(data.get('identifier') ?? '').trim();
    const displayName = String(data.get('displayName') ?? '').trim();
    await run(async () => {
      try {
        const created = await api.request('POST', '/staff/invites', {
          schema: CreatedStaffInvite,
          body: {
            identifier,
            role: String(data.get('role')),
            ...(displayName ? { displayName } : {}),
          },
        });
        setLink({ key: 'invite', name: displayName || identifier, url: created.inviteUrl });
        form.reset();
        await load();
      } catch (e) {
        // Field problems (bad identifier, already has the role) belong next to the form.
        if (e instanceof ApiError && (e.fields.identifier || e.status === 409)) {
          setFieldError(e.message);
          return;
        }
        throw e;
      }
    });
  }

  const revoke = (invite: StaffInvite) =>
    run(async () => {
      await api.revokeStaffInvite(invite.id);
      if (link?.key === 'invite') setLink(null);
      await load();
    });

  const nameOf = (m: { displayName: string | null; identifier: string }) =>
    m.displayName ?? m.identifier;

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
                    {m.signInReady ? t('staff.signInReady') : t('staff.signInNotReady')}
                    {' · '}
                    {m.lastLoginAt
                      ? t('staff.lastLogin', { date: formatIstDateTime(m.lastLoginAt, locale) })
                      : t('staff.neverSignedIn')}
                  </p>
                </div>
                {m.userId !== currentUserId && confirming !== m.userId && (
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

              {link?.key === `user:${m.userId}` && (
                <LinkNotice link={link} testId="reset-link" t={t} />
              )}
            </li>
          ))}
        </ul>
      )}

      <h3 id="invite-title">{t('staff.inviteTitle')}</h3>
      <form
        className="invite-form"
        aria-labelledby="invite-title"
        onSubmit={(e) => void invite(e)}
        noValidate
      >
        <div>
          <label htmlFor="invite-identifier">{t('login.identifier')}</label>
          <input
            id="invite-identifier"
            name="identifier"
            required
            autoComplete="off"
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={fieldError ? 'invite-error' : undefined}
          />
        </div>
        <div>
          <label htmlFor="invite-name">{t('staff.inviteName')}</label>
          <input id="invite-name" name="displayName" autoComplete="off" />
        </div>
        <div>
          <label htmlFor="invite-role">{t('staff.inviteRole')}</label>
          <select id="invite-role" name="role" defaultValue="doctor">
            {STAFF_ROLES.map((role) => (
              <option key={role} value={role}>
                {t(`role.${role}`)}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" disabled={busy}>
          {t('staff.inviteSend')}
        </button>
      </form>
      {fieldError && (
        <p id="invite-error" role="alert" className="alert">
          {fieldError}
        </p>
      )}
      {link?.key === 'invite' && <LinkNotice link={link} testId="invite-link" t={t} />}

      <h3>{t('staff.pendingTitle')}</h3>
      {pending && pending.length === 0 && <p className="hint">{t('staff.noPending')}</p>}
      {pending && pending.length > 0 && (
        <ul className="staff-list">
          {pending.map((i) => (
            <li key={i.id} data-testid={`pending-${i.identifier}`}>
              <div className="staff-row">
                <div>
                  <strong>{nameOf(i)}</strong>
                  <p className="hint">
                    {i.identifier} · {t(`role.${i.role}`)} ·{' '}
                    {t('staff.expires', { date: formatIstDateTime(i.expiresAt, locale) })}
                  </p>
                </div>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => void revoke(i)}
                >
                  {t('staff.revoke')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** A link to hand over in person, with a copy button. */
function LinkNotice({
  link,
  testId,
  t,
}: {
  link: { name: string; url: string };
  testId: string;
  t: (key: MessageKey, params?: Record<string, string | number>) => string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="notice" role="status">
      <p>{t('staff.shareLink', { name: link.name })}</p>
      <p className="key link" data-testid={testId}>
        {link.url}
      </p>
      <button
        type="button"
        className="secondary"
        onClick={() =>
          void navigator.clipboard
            .writeText(link.url)
            .then(() => setCopied(true))
            // Clipboard blocked: the link is still shown for manual copying.
            .catch(() => undefined)
        }
      >
        {copied ? t('staff.copied') : t('staff.copy')}
      </button>
    </div>
  );
}
