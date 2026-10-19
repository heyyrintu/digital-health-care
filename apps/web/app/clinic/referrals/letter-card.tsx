'use client';

import { ApiError } from '@dhc/api-client';
import type { Language, Referral } from '@dhc/contracts';
import { formatIstDateTime } from '@dhc/domain';
import { Button, Field, NativeSelect, Surface, cn } from '@dhc/ui-web';
import { FileDown, FileText, PenLine } from 'lucide-react';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { useSession } from '../session-provider';
import { openPdf, SigningPinField } from '../signing';

/**
 * The referral letter (PRD §7.2): for the referring doctor, Preview and Sign (with the
 * signing PIN) while the referral is open and has no letter; for both doctors, Download
 * once signed. The server checks everything again; this card only hides what it refuses.
 */
export function LetterCard({
  referral: r,
  onChanged,
  onError,
}: {
  referral: Referral;
  /** The referral as it now stands: signed here, or found closed or signed elsewhere. */
  onChanged(r: Referral): void;
  onError(e: unknown): void;
}) {
  const { api, locale, t } = useSession();
  // Empty: the patient's language, which the server reads from the record.
  const [language, setLanguage] = useState<Language | ''>('');
  const [signing, setSigning] = useState(false);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ message: string; pad: boolean } | null>(null);
  const [done, setDone] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const signed = await api.signReferralLetter(r.id, {
        pin,
        ...(language ? { language } : {}),
      });
      setSigning(false);
      setPin('');
      setDone(true);
      onChanged(signed);
    } catch (e) {
      // Closed, or signed in another tab, since this page loaded: show the referral as it
      // is now (the Sign form goes away) and say why.
      if (e instanceof ApiError && e.status === 409) {
        setSigning(false);
        setPin('');
        try {
          onChanged(await api.referral(r.id));
        } catch (reload) {
          onError(reload);
          return;
        }
        onError(e);
        return;
      }
      if (e instanceof ApiError && e.status !== 401) {
        if (e.fields.pin) setPin('');
        setProblem({
          message: e.message,
          // The pad, its verification or the PIN is what is missing: link to the pad.
          pad:
            e.code === 'DOCTOR_NOT_VERIFIED' ||
            e.fields.profile !== undefined ||
            e.fields.pin === 'unset',
        });
      } else {
        onError(e);
      }
    } finally {
      setBusy(false);
    }
  };

  const letter = r.letter;
  return (
    <Surface className="space-y-3 p-5 sm:p-6" data-testid="referral-letter">
      <h2 className="font-display text-lg font-bold">{t('referrals.letter.title')}</h2>
      {done && (
        <p role="status" className="rounded-xl bg-success-soft px-4 py-3 text-sm text-success">
          {t('referrals.letter.signed')}
        </p>
      )}
      {letter ? (
        <>
          <p className="text-sm" data-testid="referral-letter-signed">
            {t('referrals.letter.signedOn', {
              date: formatIstDateTime(letter.signedAt, locale),
              language: t(`language.${letter.language}`),
            })}
          </p>
          {letter.signatureMethod === 'test_key' && (
            <p className="text-xs text-muted-foreground">{t('sign.testKey')}</p>
          )}
          {r.status === 'closed' && (
            <p className="text-sm text-muted-foreground">{t('referrals.letter.stillValid')}</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => void openPdf(() => api.referralLetter(r.id), onError)}
            >
              <FileDown aria-hidden />
              {t('referrals.letter.download')}
            </Button>
            <a
              href={letter.verificationUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-11 items-center px-2 text-sm font-medium text-primary underline-offset-4 hover:underline"
            >
              {t('sign.verifyPage')}
            </a>
          </div>
        </>
      ) : r.canSignLetter ? (
        <>
          <p className="text-sm text-muted-foreground">{t('referrals.letter.none')}</p>
          <div className="max-w-xs">
            <Field label={t('referrals.letter.language')}>
              <NativeSelect
                value={language}
                disabled={busy}
                onChange={(e) => setLanguage(e.target.value as Language | '')}
              >
                <option value="">{t('referrals.letter.patientLanguage')}</option>
                <option value="en">{t('language.en')}</option>
                <option value="hi">{t('language.hi')}</option>
              </NativeSelect>
            </Field>
          </div>
          {signing ? (
            <form
              className={cn('space-y-3 rounded-xl border border-border p-4')}
              onSubmit={(e) => void submit(e)}
            >
              <p className="text-sm text-muted-foreground">{t('referrals.letter.signHint')}</p>
              <SigningPinField id="referral-letter-pin" value={pin} onChange={setPin} />
              {problem && (
                <p role="alert" className="text-sm font-medium text-destructive">
                  {problem.message}{' '}
                  {problem.pad && (
                    <Link href="/clinic/profile" className="font-semibold underline">
                      {t('sign.openPad')}
                    </Link>
                  )}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={busy}>
                  {busy ? t('sign.working') : t('sign.confirm')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setSigning(false);
                    setPin('');
                    setProblem(null);
                  }}
                >
                  {t('common.cancel')}
                </Button>
              </div>
            </form>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  void openPdf(
                    () => api.referralLetterPreview(r.id, language || undefined),
                    onError,
                  )
                }
              >
                <FileText aria-hidden />
                {t('referrals.letter.preview')}
              </Button>
              <Button type="button" onClick={() => setSigning(true)}>
                <PenLine aria-hidden />
                {t('referrals.letter.sign')}
              </Button>
            </div>
          )}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          {r.role === 'receiving'
            ? t('referrals.letter.noneReceiving')
            : t('referrals.letter.noneClosed')}
        </p>
      )}
    </Surface>
  );
}
