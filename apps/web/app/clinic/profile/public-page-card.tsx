'use client';

import { ApiError } from '@dhc/api-client';
import { ABOUT_MAX, PUBLIC_SLUG_MAX, type DoctorProfile } from '@dhc/contracts';
import type { MessageKey } from '@dhc/i18n';
import { Button, Checkbox, Chip, Field, Input, Surface, Textarea } from '@dhc/ui-web';
import { ExternalLink } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { doctorPath, parseLanguages, publicProfileErrors } from '../../../lib/public-doctor';
import { useSession } from '../session-provider';

/**
 * The doctor's public page at `/doctor/<slug>` (Build Plan §5.1, ADR 0017): the address,
 * whether it is listed, the about text and languages, with a link to the page. It shows
 * only while listed and once the registration is verified.
 */
export function PublicPageCard({
  profile,
  onSaved,
  onError,
}: {
  profile: DoctorProfile;
  onSaved: (profile: DoctorProfile) => void;
  /** Anything the form cannot show under a field (session ended, network). */
  onError: (e: unknown) => void;
}) {
  const { api, t } = useSession();
  const current = profile.publicProfile;
  const [slug, setSlug] = useState(current.slug ?? '');
  const [listed, setListed] = useState(current.listed);
  const [about, setAbout] = useState(current.about ?? '');
  const [languages, setLanguages] = useState(current.languages.join(', '));
  const [errors, setErrors] = useState<Partial<Record<'slug' | 'about' | 'languages', MessageKey>>>(
    {},
  );
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const save = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setSaved(false);
    setErrors({});
    try {
      const next = await api.saveDoctorPublicProfile({
        slug: slug.trim() ? slug.trim().toLowerCase() : null,
        listed,
        about: about.trim() || null,
        languages: parseLanguages(languages),
      });
      setSlug(next.publicProfile.slug ?? '');
      setLanguages(next.publicProfile.languages.join(', '));
      setSaved(true);
      onSaved(next);
    } catch (err) {
      const fieldErrors =
        err instanceof ApiError && (err.status === 400 || err.status === 409)
          ? publicProfileErrors(err.fields)
          : {};
      if (Object.keys(fieldErrors).length) setErrors(fieldErrors);
      else onError(err);
    } finally {
      setBusy(false);
    }
  };

  const status = current.live
    ? { text: t('profile.publicLive'), className: 'bg-success-soft text-success' }
    : current.listed
      ? { text: t('profile.publicWaiting'), className: 'bg-warning-soft text-warning-foreground' }
      : { text: t('profile.publicHidden'), className: 'bg-muted text-muted-foreground' };

  return (
    <Surface className="p-5 sm:p-6">
      <form className="space-y-4" onSubmit={(e) => void save(e)} data-testid="public-page-form">
        <div className="space-y-1">
          <h2 className="font-display text-lg font-bold">{t('profile.publicTitle')}</h2>
          <p className="text-sm text-muted-foreground">{t('profile.publicSub')}</p>
        </div>
        <p aria-live="polite" data-testid="public-page-status">
          <Chip className={status.className}>{status.text}</Chip>
        </p>
        <Field
          label={t('profile.publicSlug')}
          hint={t('profile.publicSlugHint')}
          error={errors.slug ? t(errors.slug) : undefined}
        >
          <Input
            name="publicSlug"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            maxLength={PUBLIC_SLUG_MAX}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="lowercase"
          />
        </Field>
        {current.slug && (
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">{t('profile.publicPreview')}:</span>
            <a
              href={doctorPath(current.slug)}
              target="_blank"
              rel="noopener"
              className="inline-flex items-center gap-1 font-medium text-primary underline-offset-2 hover:underline [overflow-wrap:anywhere]"
              data-testid="public-page-link"
            >
              {doctorPath(current.slug)}
              <ExternalLink aria-hidden className="size-3.5" />
            </a>
          </p>
        )}
        <label className="flex items-center gap-2 text-sm font-medium">
          <Checkbox checked={listed} onCheckedChange={(v) => setListed(v === true)} />
          {t('profile.publicListed')}
        </label>
        <Field
          label={t('profile.publicAbout')}
          hint={t('profile.publicAboutHint')}
          error={errors.about ? t(errors.about) : undefined}
        >
          <Textarea
            name="about"
            rows={4}
            value={about}
            onChange={(e) => setAbout(e.target.value)}
            maxLength={ABOUT_MAX}
          />
        </Field>
        <Field
          label={t('profile.publicLanguages')}
          hint={t('profile.publicLanguagesHint')}
          error={errors.languages ? t(errors.languages) : undefined}
        >
          <Input
            name="languages"
            value={languages}
            onChange={(e) => setLanguages(e.target.value)}
          />
        </Field>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={busy}>
            {t('profile.publicSave')}
          </Button>
          {saved && (
            <p role="status" className="text-sm font-medium text-success">
              {t('profile.publicSaved')}
            </p>
          )}
        </div>
      </form>
    </Surface>
  );
}
