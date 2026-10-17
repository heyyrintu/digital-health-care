'use client';

import { ApiError } from '@dhc/api-client';
import {
  OrganisationSlug,
  type CreatePlatformOrganisationBody,
  type CreatedPlatformOrganisation,
} from '@dhc/contracts';
import { formatIstDateTime } from '@dhc/domain';
import { Button, Input } from '@dhc/ui-web';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { platformErrorKey, slugTaken } from '../../lib/platform';
import { usePlatformSession, type Handover } from './session-provider';

const LABEL = 'block text-sm font-medium';
const HINT = 'text-xs text-muted-foreground';

/**
 * Onboarding steps 1–2 (PRD §9.1): the organisation, its first clinic and the first clinic
 * admin's invite. The invite link is shown once, here, and never stored: not in the page
 * address, browser storage or anywhere the operator could reopen it. It is held by the
 * session provider, so it survives moving between console pages until dismissed.
 */
export function OnboardCard({
  onCreated,
}: {
  /** Reloads the organisation list; throws on failure. */
  onCreated: () => Promise<void>;
}) {
  const { api, signOut, handover, reserveHandover, dismissHandover, t } = usePlatformSession();
  const slugInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [slugError, setSlugError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [listError, setListError] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // One link at a time: a second onboarding must not replace one not yet handed over.
    if (handover) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const field = (name: string) => String(data.get(name) ?? '').trim();
    setError(null);
    setSlugError(null);

    const slug = field('slug').toLowerCase();
    if (!field('name') || !slug || !field('clinicName') || !field('adminIdentifier')) {
      return setError(t('platform.onboard.required'));
    }
    if (!OrganisationSlug.safeParse(slug).success) {
      setSlugError(t('platform.onboard.slugInvalid'));
      return slugInput.current?.focus();
    }
    const optional = (name: string) => (field(name) ? field(name) : undefined);
    const body: CreatePlatformOrganisationBody = {
      name: field('name'),
      slug,
      clinic: {
        name: field('clinicName'),
        address: optional('clinicAddress'),
        phone: optional('clinicPhone'),
      },
      admin: { identifier: field('adminIdentifier'), displayName: optional('adminName') },
    };

    setBusy(true);
    const showHandover = reserveHandover();
    let created: CreatedPlatformOrganisation;
    try {
      created = await api.platform.createOrganisation(body);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return void signOut('expired');
      if (slugTaken(e)) {
        setSlugError(t('platform.onboard.slugTaken'));
        slugInput.current?.focus();
        return;
      }
      const key = platformErrorKey(e, 'page');
      setError(key ? t(key) : (e as Error).message);
      return;
    } finally {
      setBusy(false);
    }

    showHandover({
      organisation: created.organisation.name,
      admin: body.admin.displayName ?? created.invite.identifier,
      inviteUrl: created.invite.inviteUrl,
      expiresAt: created.invite.expiresAt,
    });
    setListError(false);
    form.reset();
    // The link is on screen now: nothing here may sign the operator out or replace it,
    // so a failed list reload (even a 401) is only a notice next to it.
    await onCreated().catch(() => setListError(true));
  }

  return (
    <section aria-labelledby="onboard-title" className="surface p-4 sm:p-6">
      <h2 id="onboard-title" className="font-display text-lg font-bold">
        {t('platform.onboard.title')}
      </h2>
      <p className={`mt-1 ${HINT}`}>{t('platform.onboard.hint')}</p>

      {handover && (
        <InviteHandover key={handover.inviteUrl} handover={handover} onDone={dismissHandover} />
      )}
      {handover && listError && (
        <p className="mt-3 rounded-xl bg-warning-soft px-4 py-3 text-sm text-warning-foreground">
          {t('platform.onboard.listFailed')}
        </p>
      )}

      <form
        className="mt-4 grid items-start gap-3 sm:grid-cols-2"
        aria-labelledby="onboard-title"
        onSubmit={(e) => void submit(e)}
        noValidate
      >
        <div className="space-y-1.5">
          <label className={LABEL} htmlFor="onboard-name">
            {t('platform.onboard.name')}
          </label>
          <Input id="onboard-name" name="name" required autoComplete="off" />
        </div>
        <div className="space-y-1.5">
          <label className={LABEL} htmlFor="onboard-slug">
            {t('platform.onboard.slug')}
          </label>
          <Input
            ref={slugInput}
            id="onboard-slug"
            name="slug"
            required
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            aria-invalid={slugError ? true : undefined}
            aria-describedby={
              slugError ? 'onboard-slug-error onboard-slug-hint' : 'onboard-slug-hint'
            }
          />
          <p id="onboard-slug-hint" className={HINT}>
            {t('platform.onboard.slugHint')}
          </p>
          {slugError && (
            <p
              id="onboard-slug-error"
              role="alert"
              className="text-sm font-medium text-destructive"
            >
              {slugError}
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <label className={LABEL} htmlFor="onboard-clinic">
            {t('platform.onboard.clinicName')}
          </label>
          <Input id="onboard-clinic" name="clinicName" required autoComplete="off" />
        </div>
        <div className="space-y-1.5">
          <label className={LABEL} htmlFor="onboard-clinic-phone">
            {t('platform.onboard.clinicPhone')}
          </label>
          <Input
            id="onboard-clinic-phone"
            name="clinicPhone"
            type="tel"
            inputMode="tel"
            autoComplete="off"
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <label className={LABEL} htmlFor="onboard-clinic-address">
            {t('platform.onboard.clinicAddress')}
          </label>
          <Input id="onboard-clinic-address" name="clinicAddress" autoComplete="off" />
        </div>
        <div className="space-y-1.5">
          <label className={LABEL} htmlFor="onboard-admin">
            {t('platform.onboard.adminIdentifier')}
          </label>
          <Input
            id="onboard-admin"
            name="adminIdentifier"
            required
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
          />
        </div>
        <div className="space-y-1.5">
          <label className={LABEL} htmlFor="onboard-admin-name">
            {t('platform.onboard.adminName')}
          </label>
          <Input id="onboard-admin-name" name="adminName" autoComplete="off" />
        </div>
        {error && (
          <p
            role="alert"
            className="rounded-xl bg-danger-soft px-4 py-3 text-sm font-medium text-destructive sm:col-span-2"
          >
            {error}
          </p>
        )}
        <Button
          type="submit"
          disabled={busy || handover !== null}
          aria-describedby={handover ? 'onboard-wait' : undefined}
          className="sm:col-span-2 sm:justify-self-start"
        >
          {t('platform.onboard.submit')}
        </Button>
        {handover && (
          <p id="onboard-wait" className={`${HINT} sm:col-span-2`}>
            {t('platform.onboard.handOverFirst')}
          </p>
        )}
      </form>
    </section>
  );
}

/** The invite link, once, with a copy button and the warning that it will not be shown again. */
function InviteHandover({ handover, onDone }: { handover: Handover; onDone: () => void }) {
  const { locale, t } = usePlatformSession();
  const [copied, setCopied] = useState(false);
  const heading = useRef<HTMLParagraphElement>(null);
  // Move focus to the notice so keyboard and screen-reader users land on it.
  useEffect(() => {
    heading.current?.focus();
  }, []);
  // Only the heading and the warning are live regions: the link itself is never read out.
  return (
    <div
      className="mt-4 space-y-3 rounded-xl bg-info-soft p-4 text-sm"
      data-testid="onboard-handover"
    >
      <p ref={heading} tabIndex={-1} role="status" className="font-semibold outline-none">
        {t('platform.onboard.done', { name: handover.organisation, admin: handover.admin })}
      </p>
      <p
        className="break-all rounded-lg bg-card px-3 py-2 font-mono text-xs"
        data-testid="invite-link"
      >
        {handover.inviteUrl}
      </p>
      <p role="status" className="rounded-lg bg-warning-soft px-3 py-2 text-warning-foreground">
        {t('platform.onboard.once', { date: formatIstDateTime(handover.expiresAt, locale) })}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() =>
            void navigator.clipboard
              .writeText(handover.inviteUrl)
              .then(() => setCopied(true))
              // Clipboard blocked: the link is still shown for manual copying.
              .catch(() => undefined)
          }
        >
          {copied ? t('staff.copied') : t('staff.copy')}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          {t('platform.onboard.dismiss')}
        </Button>
      </div>
    </div>
  );
}
