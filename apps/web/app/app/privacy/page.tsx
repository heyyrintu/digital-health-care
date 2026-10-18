'use client';

import { ACCOUNT_CONSENT_KINDS, type ConsentStatus } from '@dhc/contracts';
import { istDateKey, shortDate } from '@dhc/domain';
import { Button } from '@dhc/ui-web';
import { useCallback, useEffect, useState } from 'react';
import { portalErrorMessage } from '../../../lib/patient';
import { LoadError, Loading, Notice, PortalPage } from '../parts';
import { usePatientSession } from '../session-provider';
import { PortalShell } from '../shell';

/**
 * PRD §4.1 (DPDP): what was accepted and when; the health-data consent can be withdrawn,
 * as in the Patient app's Privacy screen.
 */
export default function PrivacyPage() {
  return <PortalShell>{() => <Privacy />}</PortalShell>;
}

type Load =
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  | { status: 'ready'; data: ConsentStatus };

function Privacy() {
  const { api, account, locale, t } = usePatientSession();
  const [state, setState] = useState<Load>({ status: 'loading' });
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setState({ status: 'loading' });
    api
      .portalConsents()
      .then((data) => setState({ status: 'ready', data }))
      .catch((e: unknown) => setState({ status: 'error', error: e }));
  }, [api]);
  useEffect(load, [load]);

  async function withdraw() {
    setBusy(true);
    setError(null);
    try {
      await api.withdrawHealthDataConsent();
      // Health data is closed now: back to the consents screen.
      await account.reload();
    } catch (e) {
      setError(portalErrorMessage(e, t));
      setBusy(false);
    }
  }

  const on = (iso: string) => shortDate(istDateKey(iso), locale);

  return (
    <PortalPage title={t('patient.nav.privacy')}>
      {error && <Notice tone="error">{error}</Notice>}
      {state.status === 'loading' && <Loading />}
      {state.status === 'error' && <LoadError error={state.error} retry={load} />}
      {state.status === 'ready' && (
        <ul className="space-y-3">
          {ACCOUNT_CONSENT_KINDS.map((kind) => {
            const consent = state.data.consents.find((c) => c.kind === kind);
            return (
              <li key={kind} className="surface space-y-2 p-4 text-sm" data-testid="consent">
                <p className="font-display text-base font-bold">
                  {t(`patient.privacy.kind.${kind}`)}
                </p>
                {consent && (
                  <p className="text-muted-foreground">
                    {consent.withdrawnAt
                      ? t('patient.privacy.withdrawn', { date: on(consent.withdrawnAt) })
                      : t('patient.privacy.accepted', { date: on(consent.acceptedAt) })}
                  </p>
                )}
                {kind === 'health_data' &&
                  consent &&
                  !consent.withdrawnAt &&
                  (confirming ? (
                    <div
                      className="space-y-3 rounded-xl bg-warning-soft p-4 text-warning-foreground"
                      role="group"
                      aria-label={t('patient.privacy.withdraw')}
                    >
                      <p className="font-medium">{t('portal.privacy.withdrawConfirm')}</p>
                      <div className="flex flex-wrap gap-3">
                        <Button
                          type="button"
                          variant="destructive"
                          disabled={busy}
                          onClick={() => void withdraw()}
                        >
                          {t('patient.privacy.withdraw')}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          disabled={busy}
                          onClick={() => setConfirming(false)}
                        >
                          {t('common.cancel')}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button type="button" variant="outline" onClick={() => setConfirming(true)}>
                      {t('patient.privacy.withdraw')}
                    </Button>
                  ))}
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">{t('patient.privacy.closeAccount')}</p>
    </PortalPage>
  );
}
