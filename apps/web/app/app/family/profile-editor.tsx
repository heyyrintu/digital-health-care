'use client';
import {
  BLOOD_GROUPS,
  PortalProfile,
  UpdatePortalProfile,
  PhoneChangeView,
  type PatientReportedEntry,
} from '@dhc/contracts';
import { istDateKey } from '@dhc/domain';
import { Button, Field, Input, Surface, Textarea } from '@dhc/ui-web';
import Image from 'next/image';
import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { keepAttemptKey, newAttemptKey, portalErrorMessage } from '../../../lib/patient';
import { LoadError, Loading, Notice, PortalPage } from '../parts';
import { usePatientSession } from '../session-provider';

type Outcome = { ok: boolean; uncertain: boolean };
type Load =
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  | { status: 'ready'; data: PortalProfile };
export function ProfileEditor({ id }: { id: string }) {
  const { api, t } = usePatientSession();
  const [state, setState] = useState<Load>({ status: 'loading' });
  const load = useCallback(() => {
    setState({ status: 'loading' });
    api
      .request('GET', `/portal/patients/${id}/profile`, { schema: PortalProfile })
      .then((data) => setState({ status: 'ready', data }))
      .catch((error: unknown) => setState({ status: 'error', error }));
  }, [api, id]);
  useEffect(load, [load]);
  return (
    <PortalPage title={t('patientProfile.edit')}>
      {state.status === 'loading' && <Loading />}
      {state.status === 'error' && <LoadError error={state.error} retry={load} />}
      {state.status === 'ready' && (
        <ProfileForms
          profile={state.data}
          saved={(data) => setState({ status: 'ready', data })}
          reload={load}
        />
      )}
      <Link className="underline" href="/app/family">
        {t('patient.nav.family')}
      </Link>
    </PortalPage>
  );
}

function ProfileForms({
  profile,
  saved,
  reload,
}: {
  profile: PortalProfile;
  saved: (p: PortalProfile) => void;
  reload: () => void;
}) {
  const { api, t, account } = usePatientSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [photo, setPhoto] = useState<string | null>(null);
  const path = `/portal/patients/${profile.id}`;
  useEffect(() => {
    let url: string | null = null;
    let active = true;
    setPhoto(null);
    if (profile.hasPhoto)
      api
        .requestFile('GET', `${path}/photo`, { accept: 'image/png,image/jpeg,image/webp' })
        .then((blob) => {
          if (active) {
            url = URL.createObjectURL(blob);
            setPhoto(url);
          }
        })
        .catch(() => {
          if (active) setError(t('patientProfile.photoFailed'));
        });
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [api, path, profile.hasPhoto, profile.updatedAt, t]);
  const run = async (fn: () => Promise<PortalProfile>) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      saved(await fn());
      setMessage(t('patientProfile.saved'));
      return { ok: true, uncertain: false };
    } catch (e) {
      setError(portalErrorMessage(e, t));
      return { ok: false, uncertain: keepAttemptKey(e) };
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-5">
      <p className="font-medium">
        {profile.name} · {profile.uhid}
      </p>
      {error && <Notice tone="error">{error}</Notice>}
      {message && <Notice tone="success">{message}</Notice>}
      <Surface className="space-y-3 p-5">
        <h2 className="font-display text-lg font-bold">{t('patientProfile.photo')}</h2>
        {photo && (
          <Image
            src={photo}
            unoptimized
            alt={t('patientProfile.photo')}
            width={112}
            height={112}
            className="size-28 rounded-2xl object-cover"
          />
        )}
        <Field label={t('patientProfile.photoFile')}>
          <Input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              if (
                !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ||
                file.size > 512 * 1024 ||
                !file.size
              )
                return setError(t('patientProfile.photoHint'));
              void run(() => api.uploadFile(`${path}/photo`, file, { schema: PortalProfile }));
            }}
          />
        </Field>
        <p className="text-xs text-muted-foreground">{t('patientProfile.photoHint')}</p>
        {profile.hasPhoto && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              void run(() => api.request('DELETE', `${path}/photo`, { schema: PortalProfile }))
            }
          >
            {t('patientProfile.removePhoto')}
          </Button>
        )}
      </Surface>
      <Demographics
        key={profile.updatedAt}
        profile={profile}
        busy={busy}
        save={(body) =>
          run(async () => {
            const updated = await api.request('PUT', `${path}/profile`, {
              schema: PortalProfile,
              body,
            });
            await account.reload();
            return updated;
          })
        }
        reload={reload}
      />
      <Surface className="space-y-4 p-5">
        <h2 className="font-display text-lg font-bold">{t('patientProfile.basics')}</h2>
        <p className="text-sm text-muted-foreground">{t('patientProfile.pendingHelp')}</p>
        <p>
          {t('patientProfile.verifiedBlood')}:{' '}
          {profile.bloodGroup ?? t('patientProfile.notRecorded')}
        </p>
        {profile.reportedBloodGroup && (
          <p>
            {t('patientProfile.reportedBlood')}: {profile.reportedBloodGroup} ·{' '}
            {t(profile.bloodGroupPending ? 'patientProfile.pending' : 'patientProfile.confirmed')}
          </p>
        )}
        {(['allergies', 'conditions', 'medications'] as const).map((kind) => (
          <div key={kind} className="space-y-2 border-t pt-3">
            <h3 className="font-semibold">{t(`chart.${kind}`)}</h3>
            <ul className="space-y-2">
              {profile[kind].map((e) => (
                <li key={e.id} className="text-sm">
                  {'substance' in e ? e.substance : e.name} ·{' '}
                  {t(
                    e.source === 'patient' ? 'patientProfile.pending' : 'patientProfile.confirmed',
                  )}
                </li>
              ))}
            </ul>
            <ReportForm
              kind={kind}
              busy={busy}
              send={(body, key) =>
                run(() =>
                  api.request('POST', `${path}/medical-basics`, {
                    schema: PortalProfile,
                    body,
                    idempotencyKey: key,
                  }),
                )
              }
            />
          </div>
        ))}
      </Surface>
      <PhoneForm profile={profile} disabled={busy} />
    </div>
  );
}

function Demographics({
  profile: p,
  busy,
  save,
  reload,
}: {
  profile: PortalProfile;
  busy: boolean;
  save: (body: UpdatePortalProfile) => Promise<Outcome>;
  reload: () => void;
}) {
  const { t } = usePatientSession();
  const [problem, setProblem] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const value = (name: string) => String(data.get(name) ?? '').trim();
    const body = UpdatePortalProfile.safeParse({
      updatedAt: p.updatedAt,
      name: value('name'),
      dob: value('dob'),
      gender: value('gender'),
      language: value('language'),
      email: value('email') || null,
      address: value('address') || null,
      emergencyContactName: value('emergencyContactName') || null,
      emergencyContactPhone: value('emergencyContactPhone') || null,
      reportedBloodGroup: value('reportedBloodGroup') || null,
    });
    if (!body.success) return setProblem(true);
    setProblem(false);
    await save(body.data);
  }
  return (
    <Surface className="p-5">
      <form className="space-y-4" onSubmit={(e) => void submit(e)}>
        <fieldset disabled={busy} className="space-y-4">
          <legend className="mb-4 font-display text-lg font-bold">
            {t('patientProfile.details')}
          </legend>
          {problem && <Notice tone="error">{t('patientProfile.invalid')}</Notice>}
          <Field label={t('patient.profile.name')}>
            <Input name="name" defaultValue={p.name} required maxLength={120} />
          </Field>
          <Field label={t('patient.profile.dob')}>
            <Input
              name="dob"
              type="date"
              defaultValue={p.dob ?? ''}
              max={istDateKey(new Date())}
              required
            />
          </Field>
          <Field label={t('patient.gender')}>
            <select
              name="gender"
              defaultValue={p.gender ?? ''}
              required
              className="min-h-11 w-full rounded-xl border bg-card px-3"
            >
              <option value="">{t('patientProfile.choose')}</option>
              {(['female', 'male', 'other'] as const).map((g) => (
                <option key={g} value={g}>
                  {t(`gender.${g}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('patientProfile.language')}>
            <select
              name="language"
              defaultValue={p.language}
              className="min-h-11 w-full rounded-xl border bg-card px-3"
            >
              <option value="en">English</option>
              <option value="hi">हिंदी</option>
            </select>
          </Field>
          <Field label={t('patientProfile.email')}>
            <Input name="email" type="email" defaultValue={p.email ?? ''} maxLength={254} />
          </Field>
          <Field label={t('patientProfile.address')}>
            <Textarea name="address" defaultValue={p.address ?? ''} maxLength={300} />
          </Field>
          <Field label={t('patientProfile.emergencyName')}>
            <Input
              name="emergencyContactName"
              defaultValue={p.emergencyContactName ?? ''}
              maxLength={120}
            />
          </Field>
          <Field label={t('patientProfile.emergencyPhone')}>
            <Input
              name="emergencyContactPhone"
              type="tel"
              defaultValue={p.emergencyContactPhone ?? ''}
              maxLength={20}
            />
          </Field>
          <Field label={t('patientProfile.reportedBlood')}>
            <select
              name="reportedBloodGroup"
              defaultValue={p.reportedBloodGroup ?? ''}
              className="min-h-11 w-full rounded-xl border bg-card px-3"
            >
              <option value="">{t('patientProfile.notRecorded')}</option>
              {BLOOD_GROUPS.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </Field>
          <Button type="submit">{t('patientProfile.save')}</Button>
        </fieldset>
        <Button type="button" variant="link" disabled={busy} onClick={reload}>
          {t('patientProfile.reload')}
        </Button>
      </form>
    </Surface>
  );
}

function ReportForm({
  kind,
  busy,
  send,
}: {
  kind: PatientReportedEntry['kind'];
  busy: boolean;
  send: (body: PatientReportedEntry, key: string) => Promise<Outcome>;
}) {
  const { t } = usePatientSession();
  const [pending, setPending] = useState<{ body: PatientReportedEntry; key: string } | null>(null);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget,
      data = new FormData(form),
      name = String(data.get('name') ?? '').trim(),
      detail = String(data.get('detail') ?? '').trim() || null;
    if (!pending && !name) return;
    const attempt = pending ?? {
      key: newAttemptKey(),
      body:
        kind === 'allergies'
          ? { kind, substance: name, reaction: detail }
          : kind === 'conditions'
            ? { kind, name }
            : { kind, name, dose: detail },
    };
    const result = await send(attempt.body, attempt.key);
    if (result.ok) {
      form.reset();
      setPending(null);
    } else setPending(result.uncertain ? attempt : null);
  }
  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-2">
      {pending && <Notice tone="info">{t('patientProfile.reportRecover')}</Notice>}
      <fieldset disabled={busy || !!pending} className="space-y-2">
        <Field label={t('patientProfile.reportName')}>
          <Input name="name" required maxLength={kind === 'allergies' ? 120 : 200} />
        </Field>
        {kind !== 'conditions' && (
          <Field label={t(kind === 'allergies' ? 'chart.reaction' : 'chart.dose')}>
            <Input name="detail" maxLength={kind === 'allergies' ? 200 : 120} />
          </Field>
        )}
      </fieldset>
      <Button type="submit" variant="outline" disabled={busy}>
        {t(pending ? 'patientProfile.checkRequest' : 'patientProfile.report')}
      </Button>
    </form>
  );
}

function PhoneForm({ profile, disabled }: { profile: PortalProfile; disabled: boolean }) {
  const { api, t, signOut } = usePatientSession();
  const [phone, setPhone] = useState(''),
    [id, setId] = useState(() => crypto.randomUUID()),
    [view, setView] = useState<PhoneChangeView | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [done, setDone] = useState(false),
    [uncertain, setUncertain] = useState(false);
  async function start() {
    setBusy(true);
    setError(null);
    try {
      setView(
        await api.request('POST', `/portal/patients/${profile.id}/phone-change`, {
          schema: PhoneChangeView,
          body: { id, newPhone: phone },
        }),
      );
    } catch (e) {
      setError(portalErrorMessage(e, t));
      setUncertain(keepAttemptKey(e));
    } finally {
      setBusy(false);
    }
  }
  async function verify(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!view) return;
    const data = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await api.request('POST', `/portal/phone-changes/${view.id}/verify`, {
        schema: PhoneChangeView,
        body: {
          oldCode: String(data.get('oldCode') ?? ''),
          newCode: String(data.get('newCode') ?? ''),
        },
      });
      setDone(true);
    } catch (e) {
      setError(portalErrorMessage(e, t));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Surface className="space-y-4 p-5">
      <h2 className="font-display text-lg font-bold">{t('patientProfile.changePhone')}</h2>
      <p className="text-sm">{t('patientProfile.phoneScope')}</p>
      <p className="text-sm text-muted-foreground">{t('patientProfile.lostPhone')}</p>
      {error && <Notice tone="error">{error}</Notice>}
      {!profile.canChangePhone ? (
        <p>{t('patientProfile.phoneClinic')}</p>
      ) : done ? (
        <>
          <Notice tone="success">{t('patientProfile.phoneDone')}</Notice>
          <Button onClick={() => void signOut('user')}>{t('patientProfile.newSignIn')}</Button>
        </>
      ) : (
        <>
          <Field label={t('patientProfile.newPhone')}>
            <Input
              type="tel"
              value={phone}
              disabled={busy || disabled || !!view || uncertain}
              onChange={(e) => {
                setPhone(e.target.value);
                setId(crypto.randomUUID());
              }}
              maxLength={20}
            />
          </Field>
          {!view && (
            <Button disabled={busy || disabled || !phone} onClick={() => void start()}>
              {t(uncertain ? 'patientProfile.checkRequest' : 'patientProfile.sendCodes')}
            </Button>
          )}
          {view && !view.ready && (
            <>
              <Notice tone="info">{t('patientProfile.preparing')}</Notice>
              <Button disabled={busy} onClick={() => void start()}>
                {t('patientProfile.checkRequest')}
              </Button>
            </>
          )}
          {view?.ready && (
            <form onSubmit={(e) => void verify(e)} className="space-y-3">
              <p className="text-sm text-muted-foreground">{t('patientProfile.codesHint')}</p>
              <Field label={t('patientProfile.oldCode')}>
                <Input
                  name="oldCode"
                  inputMode="numeric"
                  autoComplete="off"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  required
                  disabled={busy}
                />
              </Field>
              <Field label={t('patientProfile.newCode')}>
                <Input
                  name="newCode"
                  inputMode="numeric"
                  autoComplete="off"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  required
                  disabled={busy}
                />
              </Field>
              <Button type="submit" disabled={busy || disabled}>
                {t('patientProfile.confirmPhone')}
              </Button>
            </form>
          )}
          {(view || uncertain) && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setView(null);
                setUncertain(false);
                setId(crypto.randomUUID());
                setError(null);
              }}
            >
              {t('patientProfile.startAgain')}
            </Button>
          )}
        </>
      )}
    </Surface>
  );
}
