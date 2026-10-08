/**
 * Design tokens shared by web (CSS variables) and mobile (NativeWind theme).
 *
 * The design system's theme lives in `./theme` (semantic colours, fonts, radius). The scales
 * below are the earlier placeholders: the web screens' `globals.css` and the mobile shell still
 * read them, and they go once those move to the theme.
 */
export * from './theme';

export const colors = {
  brand: { 50: '#ecfdf9', 100: '#cff7ee', 500: '#0f9b8e', 600: '#0b7f75', 700: '#0a655e' },
  neutral: {
    0: '#ffffff',
    50: '#f8fafc',
    100: '#f1f5f9',
    300: '#cbd5e1',
    500: '#64748b',
    700: '#334155',
    900: '#0f172a',
  },
  /** Safety panel severities (docs/safety): block = red, warn = amber, info = blue. */
  severity: { block: '#dc2626', warn: '#d97706', info: '#2563eb' },
  status: { success: '#16a34a', danger: '#dc2626' },
} as const;

export const spacing = {
  0: 0,
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
} as const;

export const radii = { sm: 4, md: 8, lg: 12, full: 9999 } as const;

export const fontSizes = { xs: 12, sm: 14, md: 16, lg: 18, xl: 20, '2xl': 24, '3xl': 30 } as const;

/** Minimum touch target in px (Build Plan 6.8). */
export const MIN_TOUCH_TARGET = 44;

export const tokens = { colors, spacing, radii, fontSizes } as const;

/** Flattens tokens into CSS custom properties, e.g. `--color-brand-500`. */
export function toCssVariables(): Record<string, string> {
  const vars: Record<string, string> = {};
  const walk = (prefix: string, value: unknown, unit: string) => {
    if (value && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) walk(`${prefix}-${key}`, inner, unit);
    } else {
      vars[prefix] = typeof value === 'number' ? `${value}${unit}` : String(value);
    }
  };
  walk('--color', colors, '');
  walk('--space', spacing, 'px');
  walk('--radius', radii, 'px');
  walk('--font-size', fontSizes, 'px');
  return vars;
}
