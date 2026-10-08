'use client';

import { ApiError } from '@dhc/api-client';
import { DoctorProfile, type PaperSize } from '@dhc/contracts';
import { formatIstDateTime } from '@dhc/domain';
import { Button, Chip, Field, Input, NativeSelect, PageHeader, Surface } from '@dhc/ui-web';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useSession } from '../session-provider';
import { ClinicShell } from '../shell';

/** The doctor's prescription pad and signing PIN (PRD §9.1). Doctors only. */
export default function ProfilePage() {
  return <ClinicShell>{(me) => (me.role === 'doctor' ? <Pad /> : <NotAllowed />)}</ClinicShell>;
}

function NotAllowed() {
  const { t } = useSession();
  return (
    <p className="rounded-xl bg-danger-soft px-4 py-3 text-sm text-destructive">
      {t('common.notAllowed')}
    </p>
  );
}

function Pad() {
  const { api, locale, signOut, t } = useSession();
  const [profile, setProfile] = useState<DoctorProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
  const [pinSaved, setPinSaved] = useState(false);

  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) return void signOut('expired');
      setError(e instanceof ApiError ? e.message : t('error.network'));
    },
    [signOut, t],
  );

  useEffect(() => {
    api.request('GET', '/doctor-profile', { schema: DoctorProfile }).then(setProfile).catch(fail);
  }, [api, fail]);

  const save = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const text = (name: string) => String(form.get(name) ?? '').trim();
    setBusy(true);
    setSaved(false);
    setFields({});
    setError(null);
    try {
      const next = await api.request('PUT', '/doctor-profile', {
        schema: DoctorProfile,
        body: {
          registrationNumber: text('registrationNumber'),
          council: text('council'),
          qualifications: text('qualifications'),
          specialty: text('specialty') || null,
          rxPrefix: text('rxPrefix'),
          paperSize: text('paperSize') as PaperSize,
        },
      });
      setProfile(next);
      setSaved(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 400 && Object.keys(err.fields).length) {
        setFields(err.fields);
      } else if (err instanceof ApiError && err.fields.rxPrefix === 'taken') {
        setFields({ rxPrefix: err.message });
      } else {
        fail(err);
      }
    } finally {
      setBusy(false);
    }
  };

  const savePin = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formEl = e.currentTarget;
    const form = new FormData(formEl);
    const pin = String(form.get('pin') ?? '');
    setPinSaved(false);
    setPinError(null);
    if (pin !== String(form.get('confirmPin') ?? '')) return setPinError(t('profile.pinMismatch'));
    setBusy(true);
    try {
      await api.setSigningPin(String(form.get('password') ?? ''), pin);
      formEl.reset();
      setPinSaved(true);
      setProfile(await api.request('GET', '/doctor-profile', { schema: DoctorProfile }));
    } catch (err) {
      if (err instanceof ApiError && err.status !== 401) setPinError(err.message);
      else fail(err);
    } finally {
      setBusy(false);
    }
  };

  if (!profile) {
    return error ? (
      <p role="alert" className="rounded-xl bg-danger-soft px-4 py-3 text-sm text-destructive">
        {error}
      </p>
    ) : (
      <p aria-live="polite" className="text-sm text-muted-foreground">
        {t('common.loading')}
      </p>
    );
  }

  const fieldError = (name: string) =>
    fields[name] ? (fields[name] === 'invalid' ? t('error.generic') : fields[name]) : undefined;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader title={t('profile.title')} sub={t('profile.sub')} />
      {error && (
        <p role="alert" className="rounded-xl bg-danger-soft px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      )}

      <Surface className="p-5 sm:p-6">
        <form className="space-y-4" onSubmit={(e) => void save(e)} data-testid="profile-form">
          <p aria-live="polite">
            {profile.verification === 'verified' ? (
              <Chip className="bg-success-soft text-success">
                {t('profile.verified', {
                  date: formatIstDateTime(profile.verifiedAt!, locale),
                })}
              </Chip>
            ) : (
              <Chip className="bg-warning-soft text-warning-foreground">
                {t('profile.pending')}
              </Chip>
            )}
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label={t('profile.registrationNumber')}
              error={fieldError('registrationNumber')}
              hint={profile.verification === 'verified' ? t('profile.reverifyHint') : undefined}
            >
              <Input
                name="registrationNumber"
                required
                maxLength={40}
                defaultValue={profile.registrationNumber ?? ''}
              />
            </Field>
            <Field label={t('profile.council')} error={fieldError('council')}>
              <Input name="council" required maxLength={120} defaultValue={profile.council ?? ''} />
            </Field>
            <Field label={t('profile.qualifications')} error={fieldError('qualifications')}>
              <Input
                name="qualifications"
                required
                maxLength={200}
                defaultValue={profile.qualifications ?? ''}
              />
            </Field>
            <Field label={t('profile.specialty')} error={fieldError('specialty')}>
              <Input name="specialty" maxLength={120} defaultValue={profile.specialty ?? ''} />
            </Field>
            <Field
              label={t('profile.rxPrefix')}
              hint={t('profile.rxPrefixHint')}
              error={fieldError('rxPrefix')}
            >
              <Input
                name="rxPrefix"
                required
                maxLength={8}
                pattern="[A-Za-z0-9]{1,8}"
                className="uppercase"
                defaultValue={profile.rxPrefix ?? ''}
              />
            </Field>
            <Field label={t('profile.paperSize')}>
              <NativeSelect name="paperSize" defaultValue={profile.paperSize}>
                <option value="a5">A5</option>
                <option value="a4">A4</option>
              </NativeSelect>
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={busy}>
              {t('common.save')}
            </Button>
            {saved && (
              <p role="status" className="text-sm font-medium text-success">
                {t('profile.saved')}
              </p>
            )}
          </div>
        </form>
      </Surface>

      <Surface className="p-5 sm:p-6">
        <form className="space-y-4" onSubmit={(e) => void savePin(e)} data-testid="pin-form">
          <h2 className="font-display text-lg font-bold">{t('profile.pinTitle')}</h2>
          <p className="text-sm text-muted-foreground">
            {profile.pinSet ? t('profile.pinSet') : t('profile.pinUnset')}
          </p>
          {profile.pinLockedUntil && (
            <p className="text-sm font-medium text-destructive">
              {t('profile.pinLocked', { time: formatIstDateTime(profile.pinLockedUntil, locale) })}
            </p>
          )}
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label={t('profile.password')}>
              <Input name="password" type="password" required autoComplete="current-password" />
            </Field>
            <Field label={t('profile.newPin')}>
              <Input
                name="pin"
                type="password"
                required
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                autoComplete="new-password"
              />
            </Field>
            <Field label={t('profile.confirmPin')} error={pinError ?? undefined}>
              <Input
                name="confirmPin"
                type="password"
                required
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                autoComplete="new-password"
              />
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={busy}>
              {t('profile.savePin')}
            </Button>
            {pinSaved && (
              <p role="status" className="text-sm font-medium text-success">
                {t('profile.pinSaved')}
              </p>
            )}
          </div>
        </form>
      </Surface>
    </div>
  );
}
