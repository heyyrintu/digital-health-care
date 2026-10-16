import { Pressable, Text } from 'react-native';
import { useTheme } from '../theme-context';

export interface ChoiceProps {
  label: string;
  selected: boolean;
  onPress: () => void;
  disabled?: boolean;
  /** Read out after the label, e.g. "Booked" for a taken slot. */
  hint?: string;
}

/** A selectable pill (a patient, a day, a slot); one of a row behaves like a radio button. */
export function Choice({ label, selected, onPress, disabled = false, hint }: ChoiceProps) {
  const theme = useTheme();
  const { colors } = theme;
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ checked: selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: theme.minTouchTarget,
        minWidth: theme.minTouchTarget,
        paddingHorizontal: theme.spacing[3],
        borderRadius: theme.radii.full,
        borderWidth: 1,
        borderColor: selected ? colors.primary : colors.border,
        backgroundColor: selected ? colors.primary : colors.card,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.45 : pressed ? 0.85 : 1,
      })}
    >
      <Text
        style={{
          color: selected ? colors['primary-foreground'] : colors.foreground,
          fontSize: theme.fontSizes.sm,
          fontWeight: selected ? '600' : '400',
          textDecorationLine: disabled ? 'line-through' : 'none',
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
