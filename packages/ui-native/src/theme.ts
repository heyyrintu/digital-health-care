import {
  baseRadius,
  fontSizes,
  MIN_TOUCH_TARGET,
  spacing,
  themeHex,
  type ThemeColor,
  type ThemeMode,
} from '@dhc/tokens';

/**
 * The web theme in the shape React Native styles want: the same semantic colours as hex,
 * the same radius scale (web derives sm to 3xl from `--radius`), spacing and type sizes.
 */
export interface NativeTheme {
  mode: ThemeMode;
  colors: Record<ThemeColor, string>;
  radii: { sm: number; md: number; lg: number; xl: number; '2xl': number; full: number };
  spacing: typeof spacing;
  fontSizes: typeof fontSizes;
  minTouchTarget: number;
}

const cache = new Map<ThemeMode, NativeTheme>();

export function nativeTheme(mode: ThemeMode): NativeTheme {
  let theme = cache.get(mode);
  if (!theme) {
    theme = {
      mode,
      colors: themeHex(mode),
      radii: {
        sm: baseRadius - 4,
        md: baseRadius - 2,
        lg: baseRadius,
        xl: baseRadius + 4,
        '2xl': baseRadius + 8,
        full: 9999,
      },
      spacing,
      fontSizes,
      minTouchTarget: MIN_TOUCH_TARGET,
    };
    cache.set(mode, theme);
  }
  return theme;
}

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive';

/** Background, text and border colours for a button; disabled buttons keep their colours but fade. */
export function buttonColors(
  theme: NativeTheme,
  variant: ButtonVariant,
): { background: string; text: string; border: string } {
  const c = theme.colors;
  switch (variant) {
    case 'primary':
      return { background: c.primary, text: c['primary-foreground'], border: c.primary };
    case 'secondary':
      return { background: c.secondary, text: c['secondary-foreground'], border: c.border };
    case 'ghost':
      return { background: 'transparent', text: c.primary, border: 'transparent' };
    case 'destructive':
      return {
        background: c.destructive,
        text: c['destructive-foreground'],
        border: c.destructive,
      };
  }
}

export type NoticeTone = 'error' | 'warning' | 'info' | 'success';

/**
 * Colours for an inline notice: the soft background with readable text. Amber `warning` is
 * for the border only, never a text background (tokens/theme.ts).
 */
export function noticeColors(
  theme: NativeTheme,
  tone: NoticeTone,
): { background: string; text: string; border: string } {
  const c = theme.colors;
  switch (tone) {
    case 'error':
      return { background: c['danger-soft'], text: c.destructive, border: c.destructive };
    case 'warning':
      return { background: c['warning-soft'], text: c['warning-foreground'], border: c.warning };
    case 'info':
      return { background: c['info-soft'], text: c.foreground, border: c.info };
    case 'success':
      return { background: c['success-soft'], text: c.foreground, border: c.success };
  }
}
