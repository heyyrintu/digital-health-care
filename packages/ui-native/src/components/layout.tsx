import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View, type ViewProps } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { noticeColors, type NoticeTone } from '../theme';
import { useTheme } from '../theme-context';
import { Text } from './text';

/** A scrolling screen on the theme background that keeps fields clear of the keyboard. */
export function Screen({ children, maxWidth = 480 }: { children: ReactNode; maxWidth?: number }) {
  const theme = useTheme();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ flexGrow: 1, padding: theme.spacing[4], alignItems: 'center' }}
        >
          <View style={{ width: '100%', maxWidth, gap: theme.spacing[4] }}>{children}</View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

export function Card({ style, ...props }: ViewProps) {
  const theme = useTheme();
  return (
    <View
      style={[
        {
          backgroundColor: theme.colors.card,
          borderColor: theme.colors.border,
          borderWidth: 1,
          borderRadius: theme.radii.xl,
          padding: theme.spacing[4],
          gap: theme.spacing[3],
        },
        style,
      ]}
      {...props}
    />
  );
}

/** An inline message; errors are announced to screen readers as soon as they appear. */
export function Notice({ tone = 'info', children }: { tone?: NoticeTone; children: string }) {
  const theme = useTheme();
  const colors = noticeColors(theme, tone);
  return (
    <View
      accessibilityRole={tone === 'error' ? 'alert' : undefined}
      accessibilityLiveRegion={tone === 'error' ? 'assertive' : 'polite'}
      style={{
        backgroundColor: colors.background,
        borderLeftColor: colors.border,
        borderLeftWidth: 4,
        borderRadius: theme.radii.sm,
        padding: theme.spacing[3],
      }}
    >
      <Text style={{ color: colors.text }}>{children}</Text>
    </View>
  );
}
