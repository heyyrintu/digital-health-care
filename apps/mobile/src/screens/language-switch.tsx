import { Button } from '@dhc/ui-native';
import { useLocale } from '../locale/provider';

/** Switches between English and Hindi; the label is in the language it switches to. */
export function LanguageSwitch() {
  const { locale, setLocale, t } = useLocale();
  return (
    <Button
      variant="ghost"
      label={t('mobile.switchLanguage')}
      onPress={() => setLocale(locale === 'hi' ? 'en' : 'hi')}
    />
  );
}
