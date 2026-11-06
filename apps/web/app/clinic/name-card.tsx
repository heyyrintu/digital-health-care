'use client';
import { ApiError } from '@dhc/api-client';
import { PracticeIdentity } from '@dhc/contracts';
import { Button, Field, Input, Surface } from '@dhc/ui-web';
import { useState, type FormEvent } from 'react';
import { useSession } from './session-provider';

export function NameCard({ organisation = false }: { organisation?: boolean }) {
  const { me, api, signOut, t, reloadMe } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get('name') ?? '').trim();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api.request('PUT', organisation ? '/organisation-identity' : '/staff/profile', {
        schema: PracticeIdentity,
        body: { name },
      });
      await reloadMe();
      setSaved(true);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) void signOut('expired');
      else setError(e instanceof ApiError ? e.message : t('error.network'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Surface className="space-y-4 p-5 sm:p-6">
      <h2 className="font-display text-lg font-bold">
        {t(organisation ? 'identity.clinic' : 'identity.staff')}
      </h2>
      <p className="text-sm text-muted-foreground">
        {t(organisation ? 'identity.clinicHint' : 'identity.staffHint')}
      </p>
      <form onSubmit={(e) => void save(e)} className="space-y-3">
        <Field label={t(organisation ? 'identity.clinic' : 'identity.name')}>
          <Input
            name="name"
            required
            maxLength={120}
            defaultValue={organisation ? me?.organisation.name : (me?.user.displayName ?? '')}
          />
        </Field>
        <Button type="submit" disabled={busy}>
          {t('common.save')}
        </Button>
        {saved && <p role="status">{t('profile.saved')}</p>}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
      </form>
    </Surface>
  );
}
