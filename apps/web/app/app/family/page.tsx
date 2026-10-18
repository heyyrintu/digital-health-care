'use client';

import { istDateKey } from '@dhc/domain';
import { Surface } from '@dhc/ui-web';
import { useState } from 'react';
import { guardianChoices } from '../../../lib/patient';
import { Notice, PortalPage } from '../parts';
import { PatientForm } from '../patient-form';
import { usePatientSession } from '../session-provider';
import { PortalShell, type ReadyAccount } from '../shell';

/** PRD §4.1: everyone on the number, the children they look after, and adding someone. */
export default function FamilyPage() {
  return <PortalShell>{(account) => <Family account={account} />}</PortalShell>;
}

function Family({ account }: { account: ReadyAccount }) {
  const { account: store, t } = usePatientSession();
  const [added, setAdded] = useState<string | null>(null);
  // A new form after each addition, so the next one starts empty.
  const [formKey, setFormKey] = useState(0);
  const guardians = guardianChoices(account.patients, istDateKey(new Date()));
  const nameOf = (id: string | null) => account.patients.find((p) => p.id === id)?.name ?? '';

  return (
    <PortalPage title={t('patient.nav.family')} intro={t('patient.family.intro')}>
      <ul className="space-y-3" aria-label={t('patient.nav.family')}>
        {account.patients.map((p) => (
          <li key={p.id} className="surface space-y-1 p-4 text-sm" data-testid="family-member">
            <p className="font-display text-base font-bold">{p.name}</p>
            <p className="text-muted-foreground">
              {t('patient.uhid')} <span className="tabular">{p.uhid}</span>
            </p>
            <p className="text-xs text-muted-foreground">
              {p.relation === 'account'
                ? t('patient.family.sharesNumber')
                : t('patient.family.lookedAfterBy', { name: nameOf(p.guardianPatientId) })}
            </p>
          </li>
        ))}
      </ul>

      <h2 className="font-display text-lg font-bold">{t('patient.family.add')}</h2>
      {added && <Notice tone="success">{added}</Notice>}
      <Surface className="p-5 sm:p-6">
        <PatientForm
          key={formKey}
          guardians={guardians}
          submitLabel={t('patient.family.add')}
          onSaved={async (patient) => {
            setAdded(t('patient.family.added', { name: patient.name }));
            setFormKey((k) => k + 1);
            await store.reload();
          }}
        />
      </Surface>
    </PortalPage>
  );
}
