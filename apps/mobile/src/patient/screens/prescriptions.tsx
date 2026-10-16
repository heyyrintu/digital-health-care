import type { PortalPrescription } from '@dhc/contracts';
import type { Locale } from '@dhc/i18n';
import { Button, Card, Notice, Text, useTheme } from '@dhc/ui-native';
import { useState } from 'react';
import { View } from 'react-native';
import { api } from '../../api';
import { errorMessage } from '../../errors';
import { useLocale } from '../../locale/provider';
import { useLoad } from '../../use-load';
import { istToday, shortDate } from '../logic';
import { LoadError, Loading, PatientScreen } from '../parts';
import { blobBytes, prescriptionPdfs } from '../pdf-native';
import { prescriptionPdfName } from '../pdf-name';

/** The IST day a version was signed: an amendment can be signed days after the visit. */
const signedOn = (at: string, locale: Locale) => shortDate(istToday(new Date(at)), locale);

/** PRD §4.4: every signed version; revised and cancelled ones are labelled and still open. */
export function PrescriptionsScreen() {
  const { t, locale } = useLocale();
  const theme = useTheme();
  const { state, reload } = useLoad(() => api.portalPrescriptions(), []);
  /** The one PDF being downloaded or shown; the other buttons wait for it. */
  const [opening, setOpening] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ id: string; text: string } | null>(null);

  async function open(rx: PortalPrescription) {
    setOpening(rx.id);
    setFailure(null);
    try {
      const result = await prescriptionPdfs.open(
        prescriptionPdfName(rx.number, rx.version),
        async () => blobBytes(await api.portalPrescriptionPdf(rx.id)),
        t('patient.rx.pdfTitle', { number: rx.number }),
      );
      if (result === 'cannot-share') setFailure({ id: rx.id, text: t('patient.rx.cannotOpen') });
    } catch (e) {
      setFailure({ id: rx.id, text: errorMessage(e, t) });
    } finally {
      setOpening(null);
    }
  }

  return (
    <PatientScreen title={t('patient.nav.prescriptions')}>
      {state.status === 'loading' && <Loading />}
      {state.status === 'error' && <LoadError error={state.error} retry={reload} />}
      {state.status === 'ready' &&
        (state.data.data.length === 0 ? (
          <Text variant="muted">{t('patient.rx.none')}</Text>
        ) : (
          <View style={{ gap: theme.spacing[3] }}>
            {state.data.data.map((rx) => (
              <Card key={rx.id}>
                <Text variant="label">{rx.patient.name}</Text>
                <Text>
                  {rx.number} · {t('patient.rx.version', { version: rx.version })}
                </Text>
                <Text variant="muted">
                  {rx.doctorName ? `${rx.doctorName} · ` : ''}
                  {shortDate(rx.date, locale)}
                </Text>
                {rx.signedAt && (
                  <Text variant="caption">
                    {t('patient.rx.signed', { date: signedOn(rx.signedAt, locale) })}
                  </Text>
                )}
                {rx.status === 'superseded' && (
                  <Text variant="caption">{t('patient.rx.superseded')}</Text>
                )}
                {rx.status === 'void' && (
                  <Text variant="caption" style={{ color: theme.colors.destructive }}>
                    {t('patient.rx.void')}
                  </Text>
                )}
                {rx.signedAt && (
                  <View style={{ alignSelf: 'flex-start', marginTop: theme.spacing[2] }}>
                    <Button
                      variant="secondary"
                      label={t('patient.rx.openPdf')}
                      loading={opening === rx.id}
                      disabled={opening !== null && opening !== rx.id}
                      onPress={() => void open(rx)}
                    />
                  </View>
                )}
                {failure?.id === rx.id && <Notice tone="error">{failure.text}</Notice>}
              </Card>
            ))}
          </View>
        ))}
    </PatientScreen>
  );
}
