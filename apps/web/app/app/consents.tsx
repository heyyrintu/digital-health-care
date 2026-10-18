'use client';

import type { AccountConsentKind, ConsentStatus } from '@dhc/contracts';
import { Button, Checkbox, Surface } from '@dhc/ui-web';
import { useState } from 'react';
import {
  acceptBody,
  consentsToAccept,
  isConsentUpdate,
  portalErrorMessage,
} from '../../lib/patient';
import { Notice, PortalPage } from './parts';
import { usePatientSession } from './session-provider';

/**
 * Onboarding (PRD §4.1): the privacy notice, terms and the separate health-data consent,
 * before anything else; again whenever a new version is in force.
 */
export function ConsentsStep({ status }: { status: ConsentStatus }) {
  const { api, account, documentUrls, documentsMissing, t } = usePatientSession();
  const [ticked, setTicked] = useState<Set<AccountConsentKind>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = consentsToAccept(status);
  const all = pending.every((k) => ticked.has(k));

  const toggle = (kind: AccountConsentKind, on: boolean) =>
    setTicked((current) => {
      const next = new Set(current);
      if (on) next.add(kind);
      else next.delete(kind);
      return next;
    });

  async function accept() {
    if (!all) return setError(t('patient.consents.all'));
    setBusy(true);
    setError(null);
    try {
      await api.acceptConsents(acceptBody(pending));
      await account.reload();
    } catch (e) {
      setError(portalErrorMessage(e, t));
      setBusy(false);
    }
  }

  // Production without the published documents: nothing can be accepted unread.
  if (documentsMissing) {
    return (
      <PortalPage title={t('patient.consents.title')}>
        <Notice tone="error">{t('portal.consents.unavailable')}</Notice>
      </PortalPage>
    );
  }

  return (
    <PortalPage
      title={t('patient.consents.title')}
      intro={isConsentUpdate(status) ? t('patient.consents.updated') : t('patient.consents.intro')}
    >
      {error && <Notice tone="error">{error}</Notice>}
      <Surface className="space-y-5 p-5 sm:p-6">
        <ul className="space-y-5">
          {pending.map((kind) => {
            const url = kind === 'health_data' ? undefined : documentUrls[kind];
            return (
              <li key={kind} className="space-y-1.5">
                <label className="flex cursor-pointer items-start gap-3">
                  <Checkbox
                    className="mt-0.5"
                    checked={ticked.has(kind)}
                    onCheckedChange={(on) => toggle(kind, on === true)}
                    aria-describedby={kind === 'health_data' ? 'health-data-hint' : undefined}
                  />
                  <span className="text-sm leading-6">{t(`patient.consents.${kind}`)}</span>
                </label>
                {kind === 'health_data' && (
                  <p id="health-data-hint" className="pl-8 text-xs text-muted-foreground">
                    {t('patient.consents.healthDataHint')}
                  </p>
                )}
                {/* Beside the checkbox, not inside it, so screen readers reach it on its own. */}
                {url && kind !== 'health_data' && (
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-8 inline-block text-sm font-medium text-primary underline-offset-4 hover:underline"
                  >
                    {t(`patient.consents.read.${kind}`)}
                  </a>
                )}
              </li>
            );
          })}
        </ul>
        <Button type="button" disabled={busy} onClick={() => void accept()} className="w-full">
          {t('patient.consents.accept')}
        </Button>
      </Surface>
    </PortalPage>
  );
}
