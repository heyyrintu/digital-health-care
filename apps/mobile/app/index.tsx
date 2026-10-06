import { t } from '@dhc/i18n';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { theme, TWO_PANE_MIN_WIDTH } from '../src/theme';
import { variant } from '../src/variant';

export default function Home() {
  const { width } = useWindowDimensions();
  const twoPane = variant === 'clinic' && width >= TWO_PANE_MIN_WIDTH;
  const appName = t('en', variant === 'clinic' ? 'app.clinic.name' : 'app.patient.name');

  return (
    <SafeAreaView style={styles.screen}>
      <View style={[styles.body, twoPane && styles.row]}>
        <View style={[styles.pane, twoPane && styles.listPane]}>
          <Text style={styles.eyebrow}>{appName}</Text>
          <Text style={styles.title}>
            {variant === 'clinic' ? t('en', 'queue.nowServing') : t('en', 'booking.book')}
          </Text>
        </View>
        {twoPane && (
          <View style={styles.pane}>
            <Text style={styles.muted}>Consultation pane</Text>
          </View>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.neutral[50] },
  body: { flex: 1, padding: theme.spacing[4], gap: theme.spacing[4] },
  row: { flexDirection: 'row' },
  pane: { flex: 1 },
  listPane: { maxWidth: 360 },
  eyebrow: { color: theme.colors.brand[600], fontSize: theme.fontSizes.sm, fontWeight: '600' },
  title: { color: theme.colors.neutral[900], fontSize: theme.fontSizes['2xl'], fontWeight: '700' },
  muted: { color: theme.colors.neutral[500], fontSize: theme.fontSizes.md },
});
