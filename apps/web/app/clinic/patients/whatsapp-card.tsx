'use client';
import { useCallback } from 'react';
import { WhatsAppPreferenceCard } from '../../../components/whatsapp-preference-card';
import { useSession } from '../session-provider';

export function PatientWhatsAppCard({ patientId }: { patientId: string }) {
  const { api, t, signOut } = useSession();
  const expired = useCallback(() => {
    void signOut('expired');
  }, [signOut]);
  return (
    <>
      <WhatsAppPreferenceCard
        category="payments"
        api={api}
        t={t}
        path={`/patients/${patientId}/whatsapp-payment-preference`}
        onExpired={expired}
        staff
      />
      <WhatsAppPreferenceCard
        api={api}
        t={t}
        path={`/patients/${patientId}/whatsapp-preference`}
        staff
        onExpired={expired}
      />
      <WhatsAppPreferenceCard
        category="records"
        api={api}
        t={t}
        path={`/patients/${patientId}/whatsapp-record-preference`}
        staff
        onExpired={expired}
      />
    </>
  );
}
