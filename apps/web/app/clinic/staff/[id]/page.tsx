'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { MessageKey } from '@dhc/i18n';
import { ApiError } from '@dhc/api-client';
import {
  NoContent,
  PeopleDetail,
  StaffContactChanges,
  StaffContactChange,
  CreatedStaffInvite,
  STAFF_ROLES,
  type StaffRole,
} from '@dhc/contracts';
import { Button, Field, Input, NativeSelect, Surface, PageHeader } from '@dhc/ui-web';
import { formatIstDateTime } from '@dhc/domain';
import { ClinicShell, NotAllowed } from '../../shell';
import { useSession } from '../../session-provider';
import { StaffDevices } from '../../staff-devices';
const auditLabels: Record<string, MessageKey> = {
  'staff.people.updated': 'people.profileEvent',
  'staff.contact.requested': 'people.contactRequested',
  'staff.contact.confirmed': 'people.contactConfirmed',
  'staff.contact.cancelled': 'people.contactCancelled',
  'staff.contact.reauth_failed': 'people.verificationFailed',
  'staff.contact.code_failed': 'people.verificationFailed',
  'staff.contact.delivery_failed': 'people.verificationFailed',
};
type Tab = 'profile' | 'roles' | 'access' | 'security' | 'activity';
export default function Page() {
  return (
    <ClinicShell>
      {(me) =>
        me.role === 'clinic_admin' ? <Person currentUserId={me.user.id} /> : <NotAllowed />
      }
    </ClinicShell>
  );
}
function Person({ currentUserId }: { currentUserId: string }) {
  const { id } = useParams<{ id: string }>();
  const { api, t, signOut, reloadMe, locale } = useSession();
  const [detail, setDetail] = useState<PeopleDetail | null>(null),
    [tab, setTab] = useState<Tab>('profile'),
    [name, setName] = useState(''),
    [roles, setRoles] = useState<StaffRole[]>([]),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [confirmDisable, setConfirmDisable] = useState(false),
    [confirmReset, setConfirmReset] = useState(false),
    [resetLink, setResetLink] = useState('');
  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) void signOut('expired');
      else setError(e instanceof Error ? e.message : t('error.network'));
    },
    [signOut, t],
  );
  const adopt = useCallback((person: PeopleDetail) => {
    setDetail(person);
    setName(person.displayName ?? '');
    setRoles(person.roles);
  }, []);
  const load = useCallback(async () => {
    try {
      adopt(await api.request('GET', `/staff/people/${id}`, { schema: PeopleDetail }));
      setError('');
    } catch (e) {
      fail(e);
    }
  }, [api, id, adopt, fail]);
  useEffect(() => {
    void load();
  }, [load]);
  async function save(enabled: boolean) {
    if (!detail) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      adopt(
        await api.request('PATCH', `/staff/people/${id}`, {
          schema: PeopleDetail,
          body: { version: detail.version, displayName: name.trim() || null, roles, enabled },
        }),
      );
      setConfirmDisable(false);
      setNotice(t('people.saved'));
      if (currentUserId === id) await reloadMe();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  async function reset() {
    setBusy(true);
    setError('');
    try {
      const created = await api.request('POST', `/staff/members/${id}/reset-authenticator`, {
        schema: CreatedStaffInvite,
        body: {},
      });
      setResetLink(created.inviteUrl);
      setConfirmReset(false);
      await load();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  if (!detail)
    return (
      <>
        <p>{t('common.loading')}</p>
        {error && <p role="alert">{error}</p>}
      </>
    );
  const own = id === currentUserId;
  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <Link className="text-primary underline" href="/clinic/staff">
        {t('identity.team')}
      </Link>
      <PageHeader
        title={detail.displayName ?? detail.email ?? detail.phone ?? t('people.person')}
        sub={t(`people.status.${detail.status}`)}
      />
      {error && (
        <div role="alert" className="space-y-2 rounded-xl bg-danger-soft p-4 text-destructive">
          <p>{error}</p>
          <Button variant="outline" onClick={() => void load()}>
            {t('people.reload')}
          </Button>
        </div>
      )}
      {notice && (
        <p role="status" className="rounded-xl bg-success-soft p-4">
          {notice}
        </p>
      )}
      <div role="tablist" aria-label={t('people.person')} className="flex flex-wrap gap-2">
        {(['profile', 'roles', 'access', 'security', 'activity'] as const).map((key) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            aria-controls="person-panel"
            id={`tab-${key}`}
            className={`rounded-full px-4 py-3 font-semibold ${tab === key ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}
            onClick={() => {
              setTab(key);
              setNotice('');
            }}
          >
            {t(`people.tab.${key}`)}
          </button>
        ))}
      </div>
      <Surface
        role="tabpanel"
        id="person-panel"
        aria-labelledby={`tab-${tab}`}
        className="space-y-5 p-5 sm:p-6"
      >
        {tab === 'profile' && (
          <>
            {!detail.identityEditable && (
              <p className="rounded-xl bg-info-soft p-4">{t('people.shared')}</p>
            )}
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                void save(detail.status === 'active');
              }}
            >
              <Field label={t('people.displayName')}>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={120}
                  disabled={!detail.identityEditable || busy}
                />
              </Field>
              <p>
                <strong>{t('people.email')}:</strong> {detail.email ?? '—'}
              </p>
              <p>
                <strong>{t('people.phone')}:</strong> {detail.phone ?? '—'}
              </p>
              <Button disabled={busy || !detail.identityEditable} type="submit">
                {t('people.saveProfile')}
              </Button>
            </form>
            {detail.identityEditable && detail.status === 'active' && (
              <ContactRequests detail={detail} onError={fail} />
            )}
          </>
        )}
        {tab === 'roles' && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void save(detail.status === 'active');
            }}
          >
            <p>{t('people.roleHint')}</p>
            {own && <p>{t('people.selfAccess')}</p>}
            {STAFF_ROLES.map((role) => (
              <label key={role} className="flex min-h-11 items-center gap-3">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={roles.includes(role)}
                  disabled={own || busy}
                  onChange={(e) =>
                    setRoles((current) =>
                      e.target.checked ? [...current, role] : current.filter((r) => r !== role),
                    )
                  }
                />
                {t(`role.${role}`)}
              </label>
            ))}
            <Button
              disabled={busy || own || !roles.length || detail.status !== 'active'}
              type="submit"
            >
              {t('people.saveRoles')}
            </Button>
          </form>
        )}
        {tab === 'access' && (
          <>
            <p>{t('people.accessHint')}</p>
            {own && <p>{t('people.selfAccess')}</p>}
            {detail.status === 'invited' ? (
              <p>{t('people.finishInvite')}</p>
            ) : detail.status === 'disabled' ? (
              <Button disabled={own || busy || !detail.signInReady} onClick={() => void save(true)}>
                {t('people.enable')}
              </Button>
            ) : (
              <>
                {!confirmDisable ? (
                  <Button
                    variant="outline"
                    disabled={own || busy}
                    onClick={() => setConfirmDisable(true)}
                  >
                    {t('people.disable')}
                  </Button>
                ) : (
                  <div className="space-y-3 rounded-xl border border-border p-4">
                    <p>{t('people.disableConfirm')}</p>
                    <Button disabled={busy} onClick={() => void save(false)}>
                      {t('people.confirmDisable')}
                    </Button>{' '}
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => setConfirmDisable(false)}
                    >
                      {t('common.cancel')}
                    </Button>
                  </div>
                )}
              </>
            )}
          </>
        )}
        {tab === 'security' && (
          <>
            <p>
              {t('people.loginPolicy')}: {t(`people.policy.${detail.secondFactorMode}`)}
            </p>
            <p>
              {t('people.authenticator')}:{' '}
              {t(detail.authenticatorEnrolled ? 'people.enrolled' : 'people.notEnrolled')}
            </p>
            <p>
              {t('people.lastLogin')}:{' '}
              {detail.lastLoginAt ? formatIstDateTime(detail.lastLoginAt, locale) : '—'}
            </p>
            {detail.lockedUntil && (
              <p>
                {t('people.lockedUntil')}: {formatIstDateTime(detail.lockedUntil, locale)}
              </p>
            )}
            <StaffDevices
              userId={id}
              name={detail.displayName ?? detail.email ?? detail.phone ?? ''}
            />
            {!confirmReset ? (
              <Button
                variant="outline"
                disabled={own || busy || detail.status !== 'active'}
                onClick={() => setConfirmReset(true)}
              >
                {t('people.reset')}
              </Button>
            ) : (
              <div className="space-y-3">
                <p>{t('people.resetHint')}</p>
                <Button disabled={busy} onClick={() => void reset()}>
                  {t('people.confirmReset')}
                </Button>{' '}
                <Button variant="outline" onClick={() => setConfirmReset(false)}>
                  {t('common.cancel')}
                </Button>
              </div>
            )}
            {resetLink && (
              <div className="space-y-2 rounded-xl bg-info-soft p-4">
                <p>{t('people.privateLink')}</p>
                <a className="break-all underline" href={resetLink}>
                  {resetLink}
                </a>
              </div>
            )}
          </>
        )}
        {tab === 'activity' && (
          <ul className="divide-y divide-border">
            {detail.audit.length ? (
              detail.audit.map((event) => (
                <li key={event.id} className="py-3">
                  <strong>{t(auditLabels[event.action] ?? 'people.securityEvent')}</strong>
                  <p>
                    {event.actorName ?? t('people.systemActor')} ·{' '}
                    {formatIstDateTime(event.at, locale)}
                  </p>
                </li>
              ))
            ) : (
              <li>{t('people.noActivity')}</li>
            )}
          </ul>
        )}
      </Surface>
    </div>
  );
}
function ContactRequests({
  detail,
  onError,
}: {
  detail: PeopleDetail;
  onError: (e: unknown) => void;
}) {
  const { api, t } = useSession();
  const [field, setField] = useState<'email' | 'phone'>('email'),
    [changes, setChanges] = useState<StaffContactChange[]>([]),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const load = useCallback(async () => {
    try {
      setChanges(
        (
          await api.request('GET', `/staff/people/${detail.userId}/contact-changes`, {
            schema: StaffContactChanges,
          })
        ).data,
      );
    } catch (e) {
      onError(e);
    }
  }, [api, detail.userId, onError]);
  useEffect(() => {
    void load();
  }, [load]);
  async function request(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setNotice('');
    try {
      await api.request('POST', `/staff/people/${detail.userId}/contact-changes`, {
        schema: StaffContactChange,
        body: {
          version: detail.version,
          field,
          value: String(data.get('value') ?? ''),
          password: String(data.get('password') ?? ''),
        },
      });
      form.reset();
      setNotice(t('people.sent'));
      await load();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }
  async function cancel(id: string) {
    setBusy(true);
    try {
      await api.request('POST', `/staff/people/${detail.userId}/contact-changes/${id}/cancel`, {
        schema: NoContent,
        body: {},
      });
      await load();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }
  const available =
    field === 'email' ? detail.emailVerificationAvailable : detail.phoneVerificationAvailable;
  return (
    <section className="space-y-4 border-t pt-5">
      <h2 className="font-display text-lg font-bold">{t('people.changeContact')}</h2>
      <p className="text-sm text-muted-foreground">{t('people.contactHint')}</p>
      <form className="space-y-3" onSubmit={(e) => void request(e)}>
        <Field label={t('people.contactType')}>
          <NativeSelect
            value={field}
            onChange={(e) => setField(e.target.value as 'email' | 'phone')}
          >
            <option value="email">{t('people.email')}</option>
            <option value="phone">{t('people.phone')}</option>
          </NativeSelect>
        </Field>
        {!available && <p>{t('people.deliveryUnavailable')}</p>}
        <Field label={t(field === 'email' ? 'people.newEmail' : 'people.newPhone')}>
          <Input
            name="value"
            type={field === 'email' ? 'email' : 'tel'}
            required
            maxLength={254}
            disabled={busy || !available}
          />
        </Field>
        <Field label={t('people.adminPassword')}>
          <Input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            disabled={busy || !available}
          />
        </Field>
        <Button disabled={busy || !available} type="submit">
          {t('people.send')}
        </Button>
      </form>
      {notice && <p role="status">{notice}</p>}
      <ul className="divide-y divide-border">
        {changes.map((change) => (
          <li key={change.id} className="space-y-2 py-3">
            <p>
              {change.destination} · {t(`people.change.${change.state}`)}
            </p>
            {change.state === 'pending' && (
              <Button variant="outline" disabled={busy} onClick={() => void cancel(change.id)}>
                {t('common.cancel')}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
