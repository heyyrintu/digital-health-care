'use client';
import { SecuritySettings } from '../../../components/account-security/settings';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError } from '@dhc/api-client';
import {
  StaffContactChanges,
  StaffContactConfirmed,
  type StaffContactChange,
} from '@dhc/contracts';
import { Button, Field, Input, PageHeader, Surface } from '@dhc/ui-web';
import { formatIstDateTime } from '@dhc/domain';
import { ClinicShell, NotAllowed } from '../shell';
import { useSession } from '../session-provider';
import { NameCard } from '../name-card';
export default function Page() {
  return (
    <ClinicShell>{(me) => (me.role === 'patient' ? <NotAllowed /> : <Account />)}</ClinicShell>
  );
}
function Account() {
  const { api, me, t, signOut, locale } = useSession();
  const router = useRouter();
  const [rows, setRows] = useState<StaffContactChange[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      setRows(
        (
          await api.request('GET', '/staff/profile/contact-changes', {
            schema: StaffContactChanges,
          })
        ).data,
      );
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) void signOut('expired');
      else setError(e instanceof Error ? e.message : t('error.network'));
    }
  }, [api, signOut, t]);
  useEffect(() => {
    void load();
  }, [load]);
  async function confirm(event: FormEvent<HTMLFormElement>, id: string) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      await api.request('POST', `/staff/profile/contact-changes/${id}/confirm`, {
        schema: StaffContactConfirmed,
        body: {
          code: String(data.get('code') ?? ''),
          password: String(data.get('password') ?? ''),
        },
      });
      await signOut('user');
      router.replace('/clinic/login?account=updated');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) void signOut('expired');
      else setError(e instanceof Error ? e.message : t('error.network'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <PageHeader title={t('people.yourAccount')} />
      <NameCard />
      <SecuritySettings api={api} t={t} onChanged={() => signOut('user')} />
      <Surface className="space-y-3 p-5">
        <p>
          <strong>{t('people.email')}:</strong> {me?.user.email ?? '—'}
        </p>
        <p>
          <strong>{t('people.phone')}:</strong> {me?.user.phone ?? '—'}
        </p>
        <p>{t('people.ownContactHint')}</p>
      </Surface>
      {error && (
        <p role="alert" className="rounded-xl bg-danger-soft p-4 text-destructive">
          {error}
        </p>
      )}
      <h2 className="font-display text-xl font-bold">{t('people.pendingChanges')}</h2>
      {!rows.length && <p>{t('people.noChanges')}</p>}
      {rows.map((change) => (
        <Surface key={change.id} className="space-y-3 p-5">
          <h3 className="font-semibold">
            {t(change.field === 'email' ? 'people.newEmail' : 'people.newPhone')}:{' '}
            {change.destination}
          </h3>
          <p>{t(`people.change.${change.state}`)}</p>
          {change.state === 'pending' && (
            <>
              <p>{t('people.verifyHint')}</p>
              <p>
                {t('people.expires')}: {formatIstDateTime(change.expiresAt, locale)}
              </p>
              <form className="space-y-3" onSubmit={(e) => void confirm(e, change.id)}>
                <Field label={t('people.verificationCode')}>
                  <Input
                    name="code"
                    autoComplete="one-time-code"
                    inputMode="numeric"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    required
                    disabled={busy}
                  />
                </Field>
                <Field label={t('people.currentPassword')}>
                  <Input
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    required
                    disabled={busy}
                  />
                </Field>
                <Button disabled={busy} type="submit">
                  {t('people.verify')}
                </Button>
              </form>
            </>
          )}
        </Surface>
      ))}
    </div>
  );
}
