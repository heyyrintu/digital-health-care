'use client';

import { ApiError } from '@dhc/api-client';
import { Prescription, type PrescriptionView } from '@dhc/contracts';
import { formatIstDateTime } from '@dhc/domain';
import { Button, Chip, Input, Label, cn } from '@dhc/ui-web';
import { FileText, PenLine } from 'lucide-react';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { useSession } from '../session-provider';

type Mode = null | 'sign' | 'amend' | 'void';

/**
 * Preview, sign, and afterwards amend or void (PRD §6.6). The server checks everything
 * again; what this panel disables is only a hint of what it will refuse.
 */
export function SignPanel({
  appointmentId,
  view,
  prescription,
  revision,
  blocked,
  onChanged,
  onError,
}: {
  appointmentId: string;
  view: PrescriptionView;
  /** The latest version as last loaded, or null before the first line is saved. */
  prescription: Prescription | null;
  /** The saved revision of the draft on screen. */
  revision: number;
  /** Why signing must wait (unsaved changes, open alerts, no lines), or null. */
  blocked: string | null;
  /** After signing, amending or voiding: reload the card (and the visit record). */
  onChanged(): void;
  onError(e: unknown): void;
}) {
  const { api, locale, t } = useSession();
  const [mode, setMode] = useState<Mode>(null);
  const [pin, setPin] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const draft = !prescription || prescription.status === 'draft';
  const gaps = view.signingMissing;

  const reset = (next: Mode = null) => {
    setMode(next);
    setPin('');
    setReason('');
    setProblem(null);
  };

  /** Opens a PDF in a new tab. The tab opens first, so the browser does not block it. */
  const openPdf = async (path: string) => {
    const tab = window.open('', '_blank');
    try {
      const blob = await api.requestFile('GET', path);
      const url = URL.createObjectURL(blob);
      if (tab) tab.location.href = url;
      else window.location.href = url;
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      tab?.close();
      onError(e);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!mode || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const path = `/appointments/${appointmentId}/prescription/${mode}`;
      const body =
        mode === 'sign'
          ? { revision, pin }
          : mode === 'void'
            ? { reason: reason.trim(), pin }
            : { reason: reason.trim() };
      await api.request('POST', path, { schema: Prescription, body });
      reset();
      onChanged();
    } catch (err) {
      if (err instanceof ApiError && err.status !== 401) {
        setProblem(err.message);
        if (err.fields.pin) setPin('');
      } else {
        onError(err);
      }
    } finally {
      setBusy(false);
    }
  };

  const form = mode && (
    <form className={cn(panel, 'space-y-3')} onSubmit={(e) => void submit(e)}>
      {mode !== 'sign' && (
        <div className="space-y-1.5">
          <Label htmlFor="rx-action-reason" className={fieldLabel}>
            {t(mode === 'amend' ? 'sign.amendReason' : 'sign.voidReason')}
          </Label>
          <Input
            id="rx-action-reason"
            required
            maxLength={300}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
      )}
      {mode !== 'amend' && (
        <div className="max-w-56 space-y-1.5">
          <Label htmlFor="rx-sign-pin" className={fieldLabel}>
            {t('sign.pin')}
          </Label>
          <Input
            id="rx-sign-pin"
            required
            inputMode="numeric"
            autoComplete="off"
            pattern="\d{6}"
            maxLength={6}
            className="tabular tracking-[0.3em]"
            aria-describedby="rx-sign-pin-hint"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
          />
          <p id="rx-sign-pin-hint" className="text-xs text-muted-foreground">
            {t('sign.pinHint')}
          </p>
        </div>
      )}
      {problem && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {problem}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy} variant={mode === 'void' ? 'destructive' : 'default'}>
          {busy
            ? t('sign.working')
            : t(
                mode === 'sign'
                  ? 'sign.confirm'
                  : mode === 'amend'
                    ? 'sign.amendStart'
                    : 'sign.voidConfirm',
              )}
        </Button>
        <Button type="button" variant="outline" onClick={() => reset()}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );

  const versions =
    view.versions.length > 1 ? (
      <div className="space-y-1.5">
        <p className={fieldLabel}>{t('sign.versions')}</p>
        <ul className="m-0 list-none space-y-1 p-0 text-sm">
          {view.versions.map((v) => (
            <li key={v.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="tabular">
                {t('sign.number', { number: v.number ?? '—', version: v.version })}
              </span>
              <Chip className={statusLook[v.status]}>{t(`sign.status.${v.status}`)}</Chip>
              {v.status !== 'draft' && (
                <Button
                  type="button"
                  variant="link"
                  className="h-auto px-0 py-0"
                  onClick={() => void openPdf(`/prescriptions/${v.id}/pdf`)}
                >
                  {t('sign.openPdf')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      </div>
    ) : null;

  if (draft) {
    if (!view.canEdit) return versions;
    const reasonBlocked = blocked ?? (gaps.length ? '' : null);
    return (
      <div className="space-y-3 border-t border-border pt-4" data-testid="sign-panel">
        {prescription?.amendmentReason && (
          <p className={notice}>
            {t('sign.amending', {
              version: prescription.version - 1,
              reason: prescription.amendmentReason,
            })}
          </p>
        )}
        {gaps.length > 0 && (
          <div className={cn(notice, 'space-y-1')}>
            {gaps.map((g) => (
              <p key={g} className="m-0">
                {t(`sign.missing.${g}`)}
              </p>
            ))}
            {gaps.some((g) => g === 'profile' || g === 'pin') && (
              <Link href="/clinic/profile" className="font-semibold underline">
                {t('sign.openPad')}
              </Link>
            )}
          </div>
        )}
        {blocked && gaps.length === 0 && <p className="text-sm text-muted-foreground">{blocked}</p>}
        {mode === 'sign' ? (
          form
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={!prescription || blocked !== null}
              onClick={() => void openPdf(`/appointments/${appointmentId}/prescription/preview`)}
            >
              <FileText aria-hidden />
              {t('sign.preview')}
            </Button>
            <Button type="button" disabled={reasonBlocked !== null} onClick={() => reset('sign')}>
              <PenLine aria-hidden />
              {t('sign.start')}
            </Button>
          </div>
        )}
        {versions}
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="sign-panel">
      <div className={panel}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Chip className={statusLook[prescription.status]}>
            {t(`sign.status.${prescription.status}`)}
          </Chip>
          <span className="font-semibold tabular">
            {t('sign.number', {
              number: prescription.number ?? '—',
              version: prescription.version,
            })}
          </span>
          {prescription.signedAt && (
            <span className="text-sm text-muted-foreground">
              {t('sign.signedOn', { date: formatIstDateTime(prescription.signedAt, locale) })}
            </span>
          )}
        </div>
        {prescription.voidedAt && (
          <p className="mt-2 text-sm font-medium text-destructive">
            {t('sign.voided', {
              date: formatIstDateTime(prescription.voidedAt, locale),
              reason: prescription.voidReason ?? '',
            })}
          </p>
        )}
        {prescription.signatureMethod === 'test_key' && (
          <p className="mt-2 text-xs text-muted-foreground">{t('sign.testKey')}</p>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => void openPdf(`/prescriptions/${prescription.id}/pdf`)}
          >
            <FileText aria-hidden />
            {t('sign.openPdf')}
          </Button>
          {prescription.verificationUrl && (
            <a
              href={prescription.verificationUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-11 items-center px-2 text-sm font-medium text-primary underline-offset-4 hover:underline"
            >
              {t('sign.verifyPage')}
            </a>
          )}
          {view.canAmend && mode === null && (
            <>
              <Button type="button" variant="outline" onClick={() => reset('amend')}>
                {t('sign.amend')}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="text-destructive"
                onClick={() => reset('void')}
              >
                {t('sign.void')}
              </Button>
            </>
          )}
        </div>
      </div>
      {form}
      {versions}
    </div>
  );
}

const fieldLabel = 'block text-sm font-semibold';
const panel = 'rounded-xl border border-border p-4';
const notice = 'rounded-xl bg-info-soft px-4 py-3 text-sm text-info';
const statusLook: Record<Prescription['status'], string> = {
  draft: 'bg-muted text-foreground',
  signed: 'bg-success-soft text-success',
  superseded: 'bg-warning-soft text-warning-foreground',
  void: 'bg-danger-soft text-destructive',
};
