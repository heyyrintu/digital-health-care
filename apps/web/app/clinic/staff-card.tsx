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
import { Button, Input, NativeSelect } from '@dhc/ui-web';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useSession } from './session-provider';

const H3 = 'mb-3 mt-7 text-xs font-bold uppercase tracking-wide text-muted-foreground';

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
    <section aria-labelledby="staff-title" className="surface p-4 sm:p-6">
      <h2 id="staff-title" className="font-display text-lg font-bold">
        {t('staff.title')}
      </h2>
      {error && (
        <p
          role="alert"
          className="mt-3 rounded-xl bg-danger-soft px-4 py-3 text-sm font-medium text-destructive"
        >
          {error}
        </p>
      )}

      {members && (
        <ul className="mt-2 divide-y divide-border/70">
          {members.map((m) => (
            <li key={m.userId} data-testid={`staff-${m.identifier}`} className="py-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0 space-y-0.5">
                  <strong>{nameOf(m)}</strong>
                  {m.userId === currentUserId && (
                    <span className="ml-2 rounded-full bg-accent px-2.5 py-0.5 text-xs font-semibold text-accent-foreground">
                      {t('staff.you')}
                    </span>
                  )}
                  <p className="text-sm text-muted-foreground">
                    {m.identifier} · {m.roles.map((r) => t(`role.${r}`)).join(', ')}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {m.signInReady ? t('staff.signInReady') : t('staff.signInNotReady')}
                    {' · '}
                    {m.lastLoginAt
                      ? t('staff.lastLogin', { date: formatIstDateTime(m.lastLoginAt, locale) })
                      : t('staff.neverSignedIn')}
                  </p>
                </div>
                {m.userId !== currentUserId && confirming !== m.userId && (
                  <Button type="button" variant="outline" onClick={() => setConfirming(m.userId)}>
                    {t('staff.reset')}
                  </Button>
                )}
              </div>

              {confirming === m.userId && (
                <div
                  className="confirm mt-3 space-y-3 rounded-xl bg-warning-soft p-4 text-sm text-warning-foreground"
                  role="group"
                  aria-label={t('staff.reset')}
                >
                  <p>{t('staff.resetConfirm', { name: nameOf(m) })}</p>
                  <div className="flex flex-wrap gap-3">
                    <Button
                      type="button"
                      variant="destructive"
                      disabled={busy}
                      onClick={() => void reset(m)}
                    >
                      {t('staff.resetDo')}
                    </Button>
                    <Button type="button" variant="outline" onClick={() => setConfirming(null)}>
                      {t('common.cancel')}
                    </Button>
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

      <h3 id="invite-title" className={H3}>
        {t('staff.inviteTitle')}
      </h3>
      <form
        className="mt-4 grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-3"
        aria-labelledby="invite-title"
        onSubmit={(e) => void invite(e)}
        noValidate
      >
        <div className="space-y-1.5">
          <label className="block text-sm font-medium" htmlFor="invite-identifier">
            {t('login.identifier')}
          </label>
          <Input
            id="invite-identifier"
            name="identifier"
            required
            autoComplete="off"
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={fieldError ? 'invite-error' : undefined}
          />
        </div>
        <div className="space-y-1.5">
          <label className="block text-sm font-medium" htmlFor="invite-name">
            {t('staff.inviteName')}
          </label>
          <Input id="invite-name" name="displayName" autoComplete="off" />
        </div>
        <div className="space-y-1.5">
          <label className="block text-sm font-medium" htmlFor="invite-role">
            {t('staff.inviteRole')}
          </label>
          <NativeSelect id="invite-role" name="role" defaultValue="doctor">
            {STAFF_ROLES.map((role) => (
              <option key={role} value={role}>
                {t(`role.${role}`)}
              </option>
            ))}
          </NativeSelect>
        </div>
        <Button
          type="submit"
          disabled={busy}
          className="sm:col-span-2 sm:justify-self-start lg:col-span-3"
        >
          {t('staff.inviteSend')}
        </Button>
      </form>
      {fieldError && (
        <p
          id="invite-error"
          role="alert"
          className="mt-3 rounded-xl bg-danger-soft px-4 py-3 text-sm font-medium text-destructive"
        >
          {fieldError}
        </p>
      )}
      {link?.key === 'invite' && <LinkNotice link={link} testId="invite-link" t={t} />}

      <h3 className={H3}>{t('staff.pendingTitle')}</h3>
      {pending && pending.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('staff.noPending')}</p>
      )}
      {pending && pending.length > 0 && (
        <ul className="mt-2 divide-y divide-border/70">
          {pending.map((i) => (
            <li key={i.id} data-testid={`pending-${i.identifier}`} className="py-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0 space-y-0.5">
                  <strong>{nameOf(i)}</strong>
                  <p className="text-sm text-muted-foreground">
                    {i.identifier} · {t(`role.${i.role}`)} ·{' '}
                    {t('staff.expires', { date: formatIstDateTime(i.expiresAt, locale) })}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void revoke(i)}
                >
                  {t('staff.revoke')}
                </Button>
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
    <div className="mt-3 space-y-3 rounded-xl bg-info-soft p-4 text-sm" role="status">
      <p>{t('staff.shareLink', { name: link.name })}</p>
      <p className="break-all rounded-lg bg-card px-3 py-2 font-mono text-xs" data-testid={testId}>
        {link.url}
      </p>
      <Button
        type="button"
        variant="outline"
        onClick={() =>
          void navigator.clipboard
            .writeText(link.url)
            .then(() => setCopied(true))
            // Clipboard blocked: the link is still shown for manual copying.
            .catch(() => undefined)
        }
      >
        {copied ? t('staff.copied') : t('staff.copy')}
      </Button>
    </div>
  );
}
