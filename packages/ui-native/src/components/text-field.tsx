import { useState } from 'react';
import { TextInput, type TextInputProps, View } from 'react-native';
import { useTheme } from '../theme-context';
import { Text } from './text';

export interface TextFieldProps extends Omit<TextInputProps, 'style'> {
  label: string;
  hint?: string;
  /** Shown under the field in the error colour, and read out with the label. */
  error?: string;
}

export function TextField({ label, hint, error, onFocus, onBlur, ...props }: TextFieldProps) {
  const theme = useTheme();
  const [focused, setFocused] = useState(false);
  const { colors } = theme;
  const borderColor = error ? colors.destructive : focused ? colors.ring : colors.input;
  return (
    <View style={{ gap: theme.spacing[1] }}>
      <Text variant="label">{label}</Text>
      <TextInput
        accessibilityLabel={label}
        accessibilityHint={error ?? hint}
        placeholderTextColor={colors['muted-foreground']}
        onFocus={(event) => {
          setFocused(true);
          onFocus?.(event);
        }}
        onBlur={(event) => {
          setFocused(false);
          onBlur?.(event);
        }}
        style={{
          minHeight: theme.minTouchTarget,
          paddingHorizontal: theme.spacing[3],
          borderRadius: theme.radii.md,
          borderWidth: focused ? 2 : 1,
          borderColor,
          backgroundColor: colors.card,
          color: colors.foreground,
          fontSize: theme.fontSizes.md,
        }}
        {...props}
      />
      {error ? (
        <Text variant="caption" style={{ color: colors.destructive }}>
          {error}
        </Text>
      ) : hint ? (
        <Text variant="caption">{hint}</Text>
      ) : null}
    </View>
  );
}

/** A 6-digit code field that lets iOS and Android offer the code from the SMS. */
export function CodeField(props: Omit<TextFieldProps, 'keyboardType' | 'maxLength'>) {
  return (
    <TextField
      keyboardType="number-pad"
      maxLength={6}
      textContentType="oneTimeCode"
      autoComplete="one-time-code"
      {...props}
    />
  );
}
