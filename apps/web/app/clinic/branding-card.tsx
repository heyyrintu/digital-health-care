'use client';

import { ApiError } from '@dhc/api-client';
import type { OrganisationBranding } from '@dhc/contracts';
import type { MessageKey } from '@dhc/i18n';
import { Button, buttonVariants, Field, Input } from '@dhc/ui-web';
import { CalendarPlus, ImageUp, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  accentStyle,
  brandingErrors,
  checkAccent,
  checkLogoFile,
  formatRatio,
  logoErrorKey,
  logoUploadErrorKey,
  logoSrc,
} from '../../lib/branding';
import { BrandLogo } from '../brand';
import { useSession } from './session-provider';

const H3 = 'mb-3 mt-7 text-xs font-bold uppercase tracking-wide text-muted-foreground';
const HINT = 'text-sm text-muted-foreground';
const ALERT = 'mt-3 rounded-xl bg-danger-soft px-4 py-3 text-sm font-medium text-destructive';
/** What the colour picker shows while no accent is set (the platform's own teal, readable). */
const PICKER_DEFAULT = '#1a6b5c';

type Fields = Partial<Record<'displayName' | 'accentColour' | 'tagline', MessageKey>>;

/**
 * Clinic admin: the organisation's branding (Build Plan §5.1) — display name, tagline,
 * accent colour and logo — with a live preview of a doctor page's header and Book button.
 * The colour is refused below 4.5:1 with white text, here before saving and by the API.
 */
export function BrandingCard() {
  const { api, apiBaseUrl, signOut, t } = useSession();
  const [branding, setBranding] = useState<OrganisationBranding | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [tagline, setTagline] = useState('');
  const [accent, setAccent] = useState('');
  const [fields, setFields] = useState<Fields>({});
  const [error, setError] = useState<string | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [status, setStatus] = useState<MessageKey | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const show = useCallback((next: OrganisationBranding) => {
    setBranding(next);
    setDisplayName(next.displayName ?? '');
    setTagline(next.tagline ?? '');
    setAccent(next.accentColour ?? '');
  }, []);

  const handle = useCallback(
    (e: unknown, onFields?: (fields: Record<string, string>) => boolean) => {
      if (e instanceof ApiError && e.status === 401) return void signOut('expired');
      if (e instanceof ApiError && onFields?.(e.fields)) return;
      setError(e instanceof ApiError ? e.message : t('error.network'));
    },
    [signOut, t],
  );

  useEffect(() => {
    api.organisationBranding().then(show, (e: unknown) => handle(e));
  }, [api, handle, show]);

  const accentCheck = checkAccent(accent);
  const previewAccent = accentCheck.status === 'ok' ? accentCheck.colour : null;
  const accentBlocked = accentCheck.status === 'invalid' || accentCheck.status === 'low_contrast';

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (accentBlocked) {
      setFields({
        accentColour:
          accentCheck.status === 'low_contrast'
            ? 'branding.accentLowContrast'
            : 'branding.accentInvalid',
      });
      return;
    }
    setBusy(true);
    setError(null);
    setFields({});
    setStatus(null);
    api
      .saveOrganisationBranding({
        displayName: displayName.trim() || null,
        accentColour: accentCheck.status === 'ok' ? accentCheck.colour : null,
        tagline: tagline.trim() || null,
      })
      .then(
        (next) => {
          show(next);
          setStatus('branding.saved');
        },
        (e: unknown) =>
          handle(e, (refused) => {
            const mapped = brandingErrors(refused, accent);
            setFields(mapped);
            return Object.keys(mapped).length > 0;
          }),
      )
      .finally(() => setBusy(false));
  }

  function upload(file: File | undefined) {
    if (fileInput.current) fileInput.current.value = '';
    if (!file) return;
    setLogoError(null);
    setStatus(null);
    const check = checkLogoFile(file);
    if (check !== 'ok') return setLogoError(t(logoErrorKey(check)));
    setBusy(true);
    api
      .uploadOrganisationLogo(file)
      .then(
        (next) => {
          setBranding(next);
          setStatus('branding.logoSaved');
        },
        (e: unknown) => {
          const key =
            e instanceof ApiError && e.status !== 401
              ? logoUploadErrorKey(e.status, e.fields)
              : null;
          if (key) setLogoError(t(key));
          else handle(e);
        },
      )
      .finally(() => setBusy(false));
  }

  function removeLogo() {
    setBusy(true);
    setLogoError(null);
    setStatus(null);
    api
      .deleteOrganisationLogo()
      .then(
        (next) => {
          setBranding(next);
          setStatus('branding.logoRemoved');
        },
        (e: unknown) => handle(e),
      )
      .finally(() => setBusy(false));
  }

  const logo = branding?.logo ? logoSrc(apiBaseUrl, branding.logo.url) : null;
  const previewName = displayName.trim() || branding?.organisation.name || '';

  return (
    <section aria-labelledby="branding-title" className="surface p-4 sm:p-6">
      <h2 id="branding-title" className="font-display text-lg font-bold">
        {t('branding.title')}
      </h2>
      <p className={`mt-1 ${HINT}`}>{t('branding.intro')}</p>
      {branding && (
        <>
          <form
            className="mt-4 space-y-4"
            onSubmit={save}
            onChange={() => setStatus(null)}
            noValidate
            data-testid="branding-form"
          >
            <Field
              label={t('branding.displayName')}
              hint={t('branding.displayNameHint', { name: branding.organisation.name })}
              error={fields.displayName && t(fields.displayName)}
            >
              <Input
                name="displayName"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                maxLength={80}
                placeholder={branding.organisation.name}
              />
            </Field>
            <Field
              label={t('branding.tagline')}
              hint={t('branding.taglineHint')}
              error={fields.tagline && t(fields.tagline)}
            >
              <Input
                name="tagline"
                value={tagline}
                onChange={(e) => setTagline(e.target.value)}
                maxLength={120}
              />
            </Field>
            <div className="space-y-1.5">
              <Field
                label={t('branding.accent')}
                hint={t('branding.accentHint')}
                error={fields.accentColour && t(fields.accentColour)}
              >
                <Input
                  name="accentColour"
                  value={accent}
                  onChange={(e) => {
                    setAccent(e.target.value);
                    setFields((f) => ({ ...f, accentColour: undefined }));
                  }}
                  placeholder="#1a6b5c"
                  maxLength={7}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  className="max-w-40 font-mono"
                />
              </Field>
              <div className="flex flex-wrap items-center gap-3">
                <input
                  type="color"
                  aria-label={t('branding.accentPick')}
                  value={'colour' in accentCheck ? accentCheck.colour : PICKER_DEFAULT}
                  onChange={(e) => {
                    setAccent(e.target.value);
                    setFields((f) => ({ ...f, accentColour: undefined }));
                  }}
                  className="h-11 w-16 cursor-pointer rounded-lg border border-border bg-card p-1"
                />
                {'ratio' in accentCheck && (
                  <span
                    data-testid="accent-contrast"
                    className={
                      accentCheck.status === 'ok'
                        ? 'text-sm font-medium text-success'
                        : 'text-sm font-medium text-destructive'
                    }
                  >
                    {t('branding.contrast', { ratio: formatRatio(accentCheck.ratio) })}
                  </span>
                )}
              </div>
              {accentCheck.status === 'low_contrast' && !fields.accentColour && (
                <p role="alert" className="text-sm font-medium text-destructive">
                  {t('branding.accentLowContrast')}
                </p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={busy || accentBlocked}>
                {t('branding.save')}
              </Button>
            </div>
          </form>

          <h3 className={H3}>{t('branding.logo')}</h3>
          <div className="flex flex-wrap items-center gap-3">
            {logo ? (
              <BrandLogo src={logo} className="h-12 max-w-48 rounded-lg border border-border p-1" />
            ) : (
              <span className={HINT}>{t('branding.logoNone')}</span>
            )}
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="sr-only"
              tabIndex={-1}
              aria-hidden
              data-testid="branding-logo-input"
              onChange={(e) => upload(e.target.files?.[0])}
            />
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
            >
              <ImageUp aria-hidden />
              {t('branding.logoChoose')}
            </Button>
            {branding.logo && (
              <Button type="button" variant="outline" disabled={busy} onClick={removeLogo}>
                <Trash2 aria-hidden />
                {t('branding.logoRemove')}
              </Button>
            )}
          </div>
          <p className={`mt-2 ${HINT}`}>{t('branding.logoHint')}</p>
          {logoError && (
            <p role="alert" className={ALERT}>
              {logoError}
            </p>
          )}

          <h3 className={H3}>{t('branding.preview')}</h3>
          <p className={`mb-3 ${HINT}`}>{t('branding.previewHint')}</p>
          {/* The same CSS variables the doctor page sets, from the colour as typed. */}
          <div
            className="space-y-3 rounded-2xl border border-border bg-card p-4"
            style={accentStyle(previewAccent)}
            data-testid="branding-preview"
            aria-hidden
          >
            <div className="flex min-w-0 items-center gap-3">
              {logo && <BrandLogo src={logo} className="h-10 max-w-40" />}
              <span className="truncate font-display font-bold">{previewName}</span>
            </div>
            {tagline.trim() && <p className={`m-0 ${HINT}`}>{tagline.trim()}</p>}
            <span className={buttonVariants({ size: 'lg' })}>
              <CalendarPlus aria-hidden />
              {t('doctorPage.book')}
            </span>
          </div>
        </>
      )}
      {status && (
        <p role="status" className={`mt-3 ${HINT}`}>
          {t(status)}
        </p>
      )}
      {error && (
        <p role="alert" className={ALERT}>
          {error}
        </p>
      )}
    </section>
  );
}
