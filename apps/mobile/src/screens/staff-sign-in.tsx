import { ApiError } from '@dhc/api-client';
import { STAFF_ROLES, type StaffRole } from '@dhc/contracts';
import { Button, Card, CodeField, Notice, Screen, Text, TextField } from '@dhc/ui-native';
import { useState } from 'react';
import { publicApi, session } from '../api';
import { errorMessage, isSixDigitCode } from '../errors';
import { useLocale } from '../locale/provider';
import { LanguageSwitch } from './language-switch';

/** Roles offered when a person holds several (`fields.role` is a comma-separated list). */
export function rolesFromField(field: string | undefined): StaffRole[] {
  return (field ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter((r): r is StaffRole => (STAFF_ROLES as readonly string[]).includes(r));
}

interface Props {
  initialOrganisation?: string;
  notice?: string;
}

/** Staff sign-in: password, then the code from the authenticator app set up at invite. */
export function StaffSignIn({ initialOrganisation, notice }: Props) {
  const { t } = useLocale();
  const [organisation, setOrganisation] = useState(initialOrganisation ?? '');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [roles, setRoles] = useState<StaffRole[]>([]);
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signIn = async (role?: StaffRole) => {
    setBusy(true);
    setError(null);
    try {
      const result = await publicApi.login({
        organisation: organisation.trim(),
        identifier: identifier.trim(),
        password,
        role,
      });
      setMfaToken(result.mfaToken);
      setRoles([]);
      setCode('');
    } catch (e) {
      const offered = e instanceof ApiError ? rolesFromField(e.fields.role) : [];
      if (offered.length > 0) setRoles(offered);
      else setError(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    if (!mfaToken) return;
    if (!isSixDigitCode(code)) return setError(t('invite.codeInvalid'));
    setBusy(true);
    setError(null);
    try {
      const tokens = await publicApi.verifyMfa(mfaToken, code);
      setPassword('');
      await session.signIn(organisation.trim(), tokens);
    } catch (e) {
      setError(errorMessage(e, t));
      setBusy(false);
    }
  };

  const startOver = () => {
    setMfaToken(null);
    setRoles([]);
    setPassword('');
    setError(null);
  };

  return (
    <Screen>
      <Text variant="title">{t('login.title')}</Text>
      {notice && !error && <Notice>{notice}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      <Card>
        {mfaToken ? (
          <>
            <Text variant="heading">{t('login.codeTitle')}</Text>
            <CodeField
              label={t('invite.codeLabel')}
              value={code}
              onChangeText={setCode}
              autoFocus
            />
            <Button label={t('login.verify')} loading={busy} onPress={verify} />
            <Button variant="ghost" label={t('login.startOver')} onPress={startOver} />
          </>
        ) : roles.length > 0 ? (
          <>
            <Text variant="heading">{t('login.chooseRole')}</Text>
            {roles.map((role) => (
              <Button
                key={role}
                variant="secondary"
                label={t(`role.${role}`)}
                disabled={busy}
                onPress={() => signIn(role)}
              />
            ))}
            <Button variant="ghost" label={t('login.startOver')} onPress={startOver} />
          </>
        ) : (
          <>
            <TextField
              label={t('login.clinic')}
              hint={t('login.clinicHint')}
              value={organisation}
              onChangeText={setOrganisation}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <TextField
              label={t('login.identifier')}
              value={identifier}
              onChangeText={setIdentifier}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              textContentType="username"
              autoComplete="username"
            />
            <TextField
              label={t('login.password')}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              textContentType="password"
              autoComplete="current-password"
            />
            <Button
              label={t('login.signIn')}
              loading={busy}
              disabled={!organisation.trim() || !identifier.trim() || !password}
              onPress={() => signIn()}
            />
          </>
        )}
      </Card>
      <LanguageSwitch />
    </Screen>
  );
}
