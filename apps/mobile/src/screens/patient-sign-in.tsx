import { Button, Card, CodeField, Notice, Screen, Text, TextField } from '@dhc/ui-native';
import { useState } from 'react';
import { publicApi, session } from '../api';
import { FIXED_ORGANISATION } from '../config';
import { errorMessage, isSixDigitCode } from '../errors';
import { useLocale } from '../locale/provider';
import { LanguageSwitch } from './language-switch';

interface Props {
  /** From a clinic link or the last sign-in on this device. */
  initialOrganisation?: string;
  notice?: string;
}

/** Patient sign-in: mobile number, then the 6-digit code sent by SMS. */
export function PatientSignIn({ initialOrganisation, notice }: Props) {
  const { t } = useLocale();
  const [organisation, setOrganisation] = useState(FIXED_ORGANISATION ?? initialOrganisation ?? '');
  const [phone, setPhone] = useState('');
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sendCode = async () => {
    setBusy(true);
    setError(null);
    try {
      const { challengeId } = await publicApi.requestOtp(
        organisation.trim().toLowerCase(),
        phone.trim(),
      );
      setChallenge(challengeId);
      setCode('');
    } catch (e) {
      setError(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    if (!challenge) return;
    if (!isSixDigitCode(code)) return setError(t('mobile.codeInvalid'));
    setBusy(true);
    setError(null);
    try {
      const tokens = await publicApi.verifyOtp(challenge, code);
      await session.signIn(organisation.trim().toLowerCase(), tokens);
    } catch (e) {
      setError(errorMessage(e, t));
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Text variant="title">{t('mobile.patientSignIn.title')}</Text>
      {notice && !error && <Notice>{notice}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      <Card>
        {challenge === null ? (
          <>
            <Text variant="muted">{t('mobile.patientSignIn.intro')}</Text>
            {!FIXED_ORGANISATION && (
              <TextField
                label={t('login.clinic')}
                hint={t('login.clinicHint')}
                value={organisation}
                onChangeText={setOrganisation}
                autoCapitalize="none"
                autoCorrect={false}
              />
            )}
            <TextField
              label={t('mobile.patientSignIn.phone')}
              hint={t('mobile.patientSignIn.phoneHint')}
              value={phone}
              onChangeText={setPhone}
              keyboardType="phone-pad"
              textContentType="telephoneNumber"
              autoComplete="tel"
            />
            <Button
              label={t('mobile.patientSignIn.sendCode')}
              loading={busy}
              disabled={!organisation.trim() || phone.trim().length < 10}
              onPress={sendCode}
            />
          </>
        ) : (
          <>
            <Text variant="muted">
              {t('mobile.patientSignIn.codeSent', { phone: phone.trim() })}
            </Text>
            <CodeField
              label={t('mobile.patientSignIn.codeLabel')}
              value={code}
              onChangeText={setCode}
              autoFocus
            />
            <Button label={t('login.verify')} loading={busy} onPress={verify} />
            <Button
              variant="secondary"
              label={t('mobile.patientSignIn.resend')}
              disabled={busy}
              onPress={sendCode}
            />
            <Button
              variant="ghost"
              label={t('mobile.patientSignIn.changeNumber')}
              disabled={busy}
              onPress={() => {
                setChallenge(null);
                setError(null);
              }}
            />
          </>
        )}
      </Card>
      <LanguageSwitch />
    </Screen>
  );
}
