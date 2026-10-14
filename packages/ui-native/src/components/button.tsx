import { ActivityIndicator, Pressable, type PressableProps, Text, View } from 'react-native';
import { buttonColors, type ButtonVariant } from '../theme';
import { useTheme } from '../theme-context';

export interface ButtonProps extends Omit<PressableProps, 'children' | 'style'> {
  label: string;
  variant?: ButtonVariant;
  /** Shows a spinner and ignores presses while an action is running. */
  loading?: boolean;
}

export function Button({
  label,
  variant = 'primary',
  loading = false,
  disabled,
  accessibilityState,
  ...props
}: ButtonProps) {
  const theme = useTheme();
  const colors = buttonColors(theme, variant);
  const inactive = Boolean(disabled) || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={inactive}
      {...props}
      // The caller's state first; disabled and busy are this component's to report.
      accessibilityState={{ ...accessibilityState, disabled: inactive, busy: loading }}
      style={({ pressed }) => ({
        minHeight: theme.minTouchTarget,
        paddingHorizontal: theme.spacing[4],
        borderRadius: theme.radii.md,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.background,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: inactive ? 0.6 : pressed ? 0.85 : 1,
      })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2] }}>
        {loading && <ActivityIndicator size="small" color={colors.text} />}
        <Text style={{ color: colors.text, fontSize: theme.fontSizes.md, fontWeight: '600' }}>
          {label}
        </Text>
      </View>
    </Pressable>
  );
}
