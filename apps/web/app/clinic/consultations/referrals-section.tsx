'use client';

import { ApiError } from '@dhc/api-client';
import {
  DoctorList,
  REFERRAL_LIMITS,
  REFERRAL_PHONE_PATTERN,
  ReferralUrgency,
  type CreateReferralBody,
  type Doctor,
  type Referral,
} from '@dhc/contracts';
import { formatIstDateTime } from '@dhc/domain';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  NativeSelect,
  Textarea,
} from '@dhc/ui-web';
import { Send } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ReferralStatusChip, UrgencyChip, useRecipient } from '../referrals/referral-bits';
import { useSession } from '../session-provider';

const CHOICE = 'flex min-h-11 items-start gap-2 text-sm';
const BOX = 'mt-1 size-4 shrink-0 accent-primary';
const ALERT = 'rounded-xl bg-danger-soft px-4 py-3 text-sm font-medium text-destructive';

/**
 * The visit's referrals on the consultation screen (PRD §7.2) and, for the visit's doctor
 * once the patient has checked in, **Refer**: to a doctor of this clinic or to someone
 * outside it, with a reason, urgency and notes.
 */
export function ReferralsSection({
  appointmentId,
  patientName,
  canRefer,
}: {
  appointmentId: string;
  patientName: string;
  canRefer: boolean;
}) {
  const { api, locale, signOut, t } = useSession();
  const recipient = useRecipient();
  const [list, setList] = useState<Referral[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setList((await api.visitReferrals(appointmentId)).data);
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return void signOut('expired');
      setError(e instanceof ApiError ? e.message : t('error.network'));
    }
  }, [api, appointmentId, signOut, t]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section aria-labelledby="visit-referrals-title" data-testid="visit-referrals">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 id="visit-referrals-title" className="font-display text-lg font-bold">
          {t('referrals.sectionTitle')}
        </h2>
        {canRefer && (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setNotice(null);
              setOpen(true);
            }}
          >
            <Send aria-hidden />
            {t('referrals.refer')}
          </Button>
        )}
      </div>
      {notice && (
        <p role="status" className="mb-3 rounded-xl bg-success-soft px-4 py-3 text-sm text-success">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className={ALERT}>
          {error}
        </p>
      )}
      {list?.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('referrals.noneAtVisit')}</p>
      )}
      {list && list.length > 0 && (
        <ul className="m-0 grid list-none gap-2 p-0">
          {list.map((r) => (
            <li
              key={r.id}
              className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-xl border border-border px-3 py-2"
            >
              <span className="min-w-0">
                <Link
                  href={`/clinic/referrals/${r.id}`}
                  className="font-semibold text-primary hover:underline"
                >
                  {t('referrals.to', { name: recipient(r) })}
                </Link>{' '}
                <span className="text-xs text-muted-foreground">
                  · {t('referrals.sentOn', { time: formatIstDateTime(r.sentAt, locale) })}
                </span>
              </span>
              <span className="flex flex-wrap items-center gap-1.5">
                <UrgencyChip urgency={r.urgency} />
                <ReferralStatusChip status={r.status} />
              </span>
            </li>
          ))}
        </ul>
      )}
      {canRefer && (
        <ReferDialog
          open={open}
          onOpenChange={setOpen}
          appointmentId={appointmentId}
          patientName={patientName}
          onSent={() => {
            setOpen(false);
            setNotice(t('referrals.sent'));
            void load();
          }}
        />
      )}
    </section>
  );
}

interface Draft {
  kind: 'internal' | 'external';
  receivingDoctorUserId: string;
  name: string;
  specialty: string;
  hospital: string;
  phone: string;
  reason: string;
  urgency: ReferralUrgency;
  notes: string;
}

const EMPTY: Draft = {
  kind: 'internal',
  receivingDoctorUserId: '',
  name: '',
  specialty: '',
  hospital: '',
  phone: '',
  reason: '',
  urgency: 'routine',
  notes: '',
};

type Errors = Partial<Record<'doctor' | 'name' | 'phone' | 'reason', string>>;

function ReferDialog({
  open,
  onOpenChange,
  appointmentId,
  patientName,
  onSent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appointmentId: string;
  patientName: string;
  onSent: () => void;
}) {
  const { api, me, signOut, t } = useSession();
  const [doctors, setDoctors] = useState<Doctor[] | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [errors, setErrors] = useState<Errors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // One key per attempt: a retry after a lost answer makes one referral, not two.
  const [key, setKey] = useState(() => crypto.randomUUID());

  useEffect(() => {
    if (!open) return;
    setDraft(EMPTY);
    setErrors({});
    setFailure(null);
    setKey(crypto.randomUUID());
    let current = true;
    api
      .request('GET', '/doctors', { schema: DoctorList })
      .then((list) => current && setDoctors(list.data.filter((d) => d.userId !== me?.user.id)))
      .catch((e: unknown) => {
        if (!current) return;
        if (e instanceof ApiError && e.status === 401) return void signOut('expired');
        // A failed load is not "no other doctor": the select stays disabled and the error shows.
        setDoctors(null);
        setFailure(e instanceof ApiError ? e.message : t('error.network'));
      });
    return () => {
      current = false;
    };
  }, [open, api, me?.user.id, signOut, t]);

  const set = <K extends keyof Draft>(field: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [field]: value }));

  function check(): Errors {
    const found: Errors = {};
    if (draft.kind === 'internal' && !draft.receivingDoctorUserId) {
      found.doctor = t('referrals.errorDoctor');
    }
    if (draft.kind === 'external' && !draft.name.trim()) found.name = t('referrals.errorName');
    if (
      draft.kind === 'external' &&
      draft.phone.trim() &&
      !REFERRAL_PHONE_PATTERN.test(draft.phone.trim())
    ) {
      found.phone = t('referrals.errorPhone');
    }
    if (!draft.reason.trim()) found.reason = t('referrals.errorReason');
    return found;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const found = check();
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const common = {
      reason: draft.reason.trim(),
      urgency: draft.urgency,
      notes: draft.notes.trim() || null,
    };
    const body: CreateReferralBody =
      draft.kind === 'internal'
        ? { kind: 'internal', receivingDoctorUserId: draft.receivingDoctorUserId, ...common }
        : {
            kind: 'external',
            external: {
              name: draft.name.trim(),
              specialty: draft.specialty.trim() || null,
              hospital: draft.hospital.trim() || null,
              phone: draft.phone.trim() || null,
            },
            ...common,
          };
    setBusy(true);
    setFailure(null);
    try {
      await api.createReferral(appointmentId, body, key);
      onSent();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return void signOut('expired');
      setFailure(e instanceof ApiError ? e.message : t('error.network'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('referrals.referTitle', { name: patientName })}</DialogTitle>
          <DialogDescription>{t('referrals.referHint')}</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={(e) => void submit(e)} noValidate>
          <fieldset>
            <legend className="mb-1 text-sm font-medium">{t('referrals.where')}</legend>
            {(['internal', 'external'] as const).map((kind) => (
              <label key={kind} className={CHOICE}>
                <input
                  type="radio"
                  name="referral-kind"
                  value={kind}
                  checked={draft.kind === kind}
                  onChange={() => set('kind', kind)}
                  className={BOX}
                />
                <span>{t(kind === 'internal' ? 'referrals.inside' : 'referrals.outside')}</span>
              </label>
            ))}
          </fieldset>

          {draft.kind === 'internal' ? (
            doctors?.length === 0 ? (
              <p className="rounded-xl bg-info-soft px-4 py-3 text-sm text-info">
                {t('referrals.noDoctors')}
              </p>
            ) : (
              <Field label={t('referrals.doctor')} error={errors.doctor}>
                <NativeSelect
                  value={draft.receivingDoctorUserId}
                  onChange={(e) => set('receivingDoctorUserId', e.target.value)}
                  disabled={!doctors}
                >
                  <option value="">{t('referrals.chooseDoctor')}</option>
                  {doctors?.map((d) => (
                    <option key={d.userId} value={d.userId}>
                      {d.displayName ?? t('referrals.unknownDoctor')}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            )
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('referrals.externalName')} error={errors.name}>
                <Input
                  value={draft.name}
                  maxLength={REFERRAL_LIMITS.externalName}
                  onChange={(e) => set('name', e.target.value)}
                />
              </Field>
              <Field label={t('referrals.externalSpecialty')}>
                <Input
                  value={draft.specialty}
                  maxLength={REFERRAL_LIMITS.externalSpecialty}
                  onChange={(e) => set('specialty', e.target.value)}
                />
              </Field>
              <Field label={t('referrals.externalHospital')}>
                <Input
                  value={draft.hospital}
                  maxLength={REFERRAL_LIMITS.externalHospital}
                  onChange={(e) => set('hospital', e.target.value)}
                />
              </Field>
              <Field label={t('referrals.externalPhone')} error={errors.phone}>
                <Input
                  type="tel"
                  inputMode="tel"
                  value={draft.phone}
                  maxLength={21}
                  onChange={(e) => set('phone', e.target.value)}
                />
              </Field>
            </div>
          )}

          <Field label={t('referrals.reasonLabel')} error={errors.reason}>
            <Textarea
              rows={3}
              value={draft.reason}
              maxLength={REFERRAL_LIMITS.reason}
              onChange={(e) => set('reason', e.target.value)}
            />
          </Field>
          <Field label={t('referrals.urgency')}>
            <NativeSelect
              value={draft.urgency}
              onChange={(e) => set('urgency', ReferralUrgency.parse(e.target.value))}
            >
              {ReferralUrgency.options.map((u) => (
                <option key={u} value={u}>
                  {t(`referrals.urgency.${u}`)}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label={t('referrals.notesLabel')}>
            <Textarea
              rows={3}
              value={draft.notes}
              maxLength={REFERRAL_LIMITS.notes}
              onChange={(e) => set('notes', e.target.value)}
            />
          </Field>

          {failure && (
            <p role="alert" className={ALERT}>
              {failure}
            </p>
          )}
          <DialogFooter className="gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={busy}>
              {t('referrals.send')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
