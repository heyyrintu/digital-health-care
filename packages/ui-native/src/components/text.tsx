import { Text as RNText, type TextProps as RNTextProps } from 'react-native';
import { useTheme } from '../theme-context';

export type TextVariant = 'title' | 'heading' | 'body' | 'label' | 'muted' | 'caption';

export interface TextProps extends RNTextProps {
  variant?: TextVariant;
}

/** Text in the theme's colours and sizes; headings are marked as headers for screen readers. */
export function Text({ variant = 'body', style, ...props }: TextProps) {
  const theme = useTheme();
  const { colors, fontSizes } = theme;
  const variants = {
    title: { fontSize: fontSizes['2xl'], fontWeight: '700', color: colors.foreground },
    heading: { fontSize: fontSizes.lg, fontWeight: '600', color: colors.foreground },
    body: { fontSize: fontSizes.md, color: colors.foreground },
    label: { fontSize: fontSizes.sm, fontWeight: '600', color: colors.foreground },
    muted: { fontSize: fontSizes.sm, color: colors['muted-foreground'] },
    caption: { fontSize: fontSizes.xs, color: colors['muted-foreground'] },
  } as const;
  const isHeader = variant === 'title' || variant === 'heading';
  return (
    <RNText
      accessibilityRole={isHeader ? 'header' : undefined}
      style={[variants[variant], style]}
      {...props}
    />
  );
}
