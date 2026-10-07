/**
 * The design system's theme, from the approved demo (the Lovable prototype): semantic colours
 * in OKLCH for light and dark, font families, the base radius, shadows and gradients.
 *
 * Changes from the demo, for WCAG AA (4.5:1) text contrast: light destructive, success and
 * info are slightly darker, and dark mode puts dark text on those three instead of white.
 *
 * Names follow shadcn/ui (`--background`, `--primary`, `--card-foreground`, ...) so its
 * components work unchanged. `theme.css` maps each one to a Tailwind colour; a test keeps the
 * two lists in step. Mobile reads the same colours as hex through `themeHex`.
 */

export type ThemeMode = 'light' | 'dark';

const light = {
  background: 'oklch(0.975 0.005 130)',
  foreground: 'oklch(0.25 0.025 235)',
  card: 'oklch(1 0 0)',
  'card-foreground': 'oklch(0.25 0.025 235)',
  popover: 'oklch(1 0 0)',
  'popover-foreground': 'oklch(0.25 0.025 235)',
  primary: 'oklch(0.49 0.09 183)',
  'primary-foreground': 'oklch(0.99 0.003 180)',
  'teal-deep': 'oklch(0.4 0.075 184)',
  secondary: 'oklch(0.94 0.025 177)',
  'secondary-foreground': 'oklch(0.34 0.065 183)',
  muted: 'oklch(0.945 0.006 180)',
  'muted-foreground': 'oklch(0.5 0.025 235)',
  accent: 'oklch(0.925 0.035 177)',
  'accent-foreground': 'oklch(0.34 0.065 183)',
  /** Errors and blocking safety alerts (docs/safety: block = red). */
  destructive: 'oklch(0.55 0.19 18)',
  'destructive-foreground': 'oklch(0.99 0 0)',
  'danger-soft': 'oklch(0.95 0.025 15)',
  success: 'oklch(0.515 0.13 153)',
  'success-foreground': 'oklch(0.99 0 0)',
  'success-soft': 'oklch(0.94 0.035 154)',
  /** Warning safety alerts (warn = amber). */
  warning: 'oklch(0.72 0.14 72)',
  'warning-foreground': 'oklch(0.38 0.075 63)',
  'warning-soft': 'oklch(0.955 0.045 80)',
  /** Informational safety alerts (info = blue). */
  info: 'oklch(0.525 0.12 239)',
  'info-foreground': 'oklch(0.99 0 0)',
  'info-soft': 'oklch(0.945 0.03 238)',
  /** AI scribe and Ask AI. */
  ai: 'oklch(0.5 0.2 295)',
  'ai-soft': 'oklch(0.95 0.04 295)',
  /** WhatsApp messages. */
  wa: 'oklch(0.52 0.13 150)',
  'wa-soft': 'oklch(0.93 0.07 140)',
  border: 'oklch(0.895 0.008 180)',
  input: 'oklch(0.875 0.01 180)',
  ring: 'oklch(0.49 0.09 183)',
  'chart-1': 'oklch(0.49 0.09 183)',
  'chart-2': 'oklch(0.68 0.12 153)',
  'chart-3': 'oklch(0.56 0.12 239)',
  'chart-4': 'oklch(0.72 0.15 70)',
  'chart-5': 'oklch(0.57 0.2 25)',
  sidebar: 'oklch(0.25 0.035 190)',
  'sidebar-foreground': 'oklch(0.93 0.012 180)',
  'sidebar-primary': 'oklch(0.73 0.1 177)',
  'sidebar-primary-foreground': 'oklch(0.99 0 0)',
  'sidebar-accent': 'oklch(0.34 0.05 187)',
  'sidebar-accent-foreground': 'oklch(0.99 0 0)',
  'sidebar-border': 'oklch(0.38 0.035 190)',
  'sidebar-ring': 'oklch(0.73 0.1 177)',
  /** Dialog and sheet backdrops. */
  overlay: 'oklch(0.12 0.025 220 / 0.56)',
};

export type ThemeColor = keyof typeof light;

/** Dark mode overrides only what changes; the rest is the light value. */
const dark: Partial<Record<ThemeColor, string>> = {
  background: 'oklch(0.17 0.02 205)',
  foreground: 'oklch(0.94 0.008 180)',
  card: 'oklch(0.215 0.024 203)',
  'card-foreground': 'oklch(0.94 0.008 180)',
  popover: 'oklch(0.215 0.024 203)',
  'popover-foreground': 'oklch(0.94 0.008 180)',
  primary: 'oklch(0.7 0.105 177)',
  'primary-foreground': 'oklch(0.17 0.03 190)',
  'teal-deep': 'oklch(0.75 0.09 177)',
  secondary: 'oklch(0.27 0.04 190)',
  'secondary-foreground': 'oklch(0.9 0.02 180)',
  muted: 'oklch(0.245 0.02 205)',
  'muted-foreground': 'oklch(0.7 0.02 190)',
  accent: 'oklch(0.285 0.05 185)',
  'accent-foreground': 'oklch(0.92 0.02 180)',
  destructive: 'oklch(0.7 0.17 18)',
  'destructive-foreground': 'oklch(0.17 0.03 190)',
  'danger-soft': 'oklch(0.28 0.065 18)',
  success: 'oklch(0.72 0.12 153)',
  'success-foreground': 'oklch(0.17 0.03 190)',
  'success-soft': 'oklch(0.27 0.06 153)',
  warning: 'oklch(0.78 0.13 78)',
  'warning-foreground': 'oklch(0.88 0.09 80)',
  'warning-soft': 'oklch(0.29 0.055 70)',
  info: 'oklch(0.72 0.1 237)',
  'info-foreground': 'oklch(0.17 0.03 190)',
  'info-soft': 'oklch(0.27 0.05 237)',
  ai: 'oklch(0.76 0.13 295)',
  'ai-soft': 'oklch(0.29 0.07 295)',
  wa: 'oklch(0.74 0.14 150)',
  'wa-soft': 'oklch(0.3 0.06 150)',
  border: 'oklch(0.32 0.025 202)',
  input: 'oklch(0.35 0.025 202)',
  ring: 'oklch(0.7 0.105 177)',
  sidebar: 'oklch(0.135 0.025 205)',
  'sidebar-foreground': 'oklch(0.88 0.012 180)',
  'sidebar-primary': 'oklch(0.7 0.105 177)',
  'sidebar-accent': 'oklch(0.245 0.045 190)',
  'sidebar-border': 'oklch(0.27 0.025 205)',
  overlay: 'oklch(0.05 0.01 220 / 0.74)',
};

export const themeColors: Record<ThemeMode, Record<ThemeColor, string>> = {
  light,
  dark: { ...light, ...dark },
};

/** Shadows and gradients: web only (React Native draws shadows differently). */
export const themeEffects: Record<ThemeMode, Record<string, string>> = {
  light: {
    'shadow-soft':
      '0 1px 2px oklch(0.25 0.03 210 / 0.04), 0 10px 30px -14px oklch(0.25 0.03 210 / 0.15)',
    'shadow-button': '0 4px 12px -5px oklch(0.35 0.1 183 / 0.45)',
    'shadow-button-hover': '0 8px 18px -8px oklch(0.35 0.1 183 / 0.55)',
    'shadow-sheet': '0 -20px 50px -25px oklch(0.15 0.03 220 / 0.28)',
    'gradient-hero':
      'linear-gradient(145deg, oklch(0.965 0.02 172), oklch(0.99 0.002 180) 52%, oklch(0.955 0.018 145))',
    'gradient-primary': 'linear-gradient(140deg, oklch(0.49 0.09 183), oklch(0.39 0.08 188))',
  },
  dark: {
    'shadow-soft': '0 1px 2px oklch(0.05 0 0 / 0.18), 0 14px 35px -15px oklch(0.05 0 0 / 0.55)',
    'shadow-button': '0 4px 12px -5px oklch(0.35 0.1 183 / 0.45)',
    'shadow-button-hover': '0 8px 18px -8px oklch(0.35 0.1 183 / 0.55)',
    'shadow-sheet': '0 -20px 50px -25px oklch(0.15 0.03 220 / 0.28)',
    'gradient-hero':
      'linear-gradient(145deg, oklch(0.215 0.04 190), oklch(0.17 0.02 205) 55%, oklch(0.19 0.03 160))',
    'gradient-primary': 'linear-gradient(140deg, oklch(0.56 0.1 180), oklch(0.4 0.08 190))',
  },
};

const systemSans = ['ui-sans-serif', 'system-ui', 'sans-serif'];

/**
 * Figtree for text and Manrope for headings and numbers, as in the demo. Neither has
 * Devanagari, so Noto Sans Devanagari follows for Hindi. Web loads the variable fonts from
 * @fontsource-variable; the names below are theirs.
 */
export const fontFamilies = {
  sans: ['Figtree Variable', 'Noto Sans Devanagari Variable', ...systemSans],
  display: ['Manrope Variable', 'Noto Sans Devanagari Variable', ...systemSans],
} as const;

/** Base corner radius in px; the theme derives sm to 3xl from it. */
export const baseRadius = 16;

/** CSS custom properties for one mode, e.g. `--primary`, `--shadow-soft`, `--font-family-sans`. */
export function themeCssVariables(mode: ThemeMode): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [name, value] of Object.entries(themeColors[mode])) vars[`--${name}`] = value;
  for (const [name, value] of Object.entries(themeEffects[mode])) vars[`--${name}`] = value;
  if (mode === 'light') {
    for (const [name, stack] of Object.entries(fontFamilies)) {
      vars[`--font-family-${name}`] = stack.map((f) => (f.includes(' ') ? `"${f}"` : f)).join(', ');
    }
    vars['--radius'] = `${baseRadius}px`;
  }
  return vars;
}

const OKLCH = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+)\s*)?\)$/;

/** Converts `oklch(L C H [/ A])` to `#rrggbb` (or `#rrggbbaa`), clipping to the sRGB gamut. */
export function oklchToHex(value: string): string {
  const match = OKLCH.exec(value.trim());
  if (!match) throw new Error(`Not an oklch() colour: ${value}`);
  const [L, C, H] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const hue = (H * Math.PI) / 180;
  const a = C * Math.cos(hue);
  const b = C * Math.sin(hue);
  // OKLab -> LMS -> linear sRGB (Björn Ottosson's matrices).
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  const channel = (x: number) => {
    const clipped = Math.min(1, Math.max(0, x));
    const encoded = clipped <= 0.0031308 ? 12.92 * clipped : 1.055 * clipped ** (1 / 2.4) - 0.055;
    return Math.round(encoded * 255)
      .toString(16)
      .padStart(2, '0');
  };
  const alpha =
    match[4] === undefined
      ? ''
      : Math.round(Number(match[4]) * 255)
          .toString(16)
          .padStart(2, '0');
  return `#${linear.map(channel).join('')}${alpha}`;
}

/** The theme colours as hex, for React Native (which has no oklch()). */
export function themeHex(mode: ThemeMode): Record<ThemeColor, string> {
  const out = {} as Record<ThemeColor, string>;
  for (const [name, value] of Object.entries(themeColors[mode])) {
    out[name as ThemeColor] = oklchToHex(value);
  }
  return out;
}

/**
 * The stylesheet the web app puts in <head>: light values on `:root`, dark ones on `.dark`.
 * `extra` adds variables to `:root` (the legacy tokens, until every screen uses the theme).
 */
export function themeStylesheet(extra: Record<string, string> = {}): string {
  const block = (vars: Record<string, string>) =>
    Object.entries(vars)
      .map(([name, value]) => `${name}:${value}`)
      .join(';');
  return (
    `:root{${block({ ...extra, ...themeCssVariables('light') })}}` +
    `.dark{color-scheme:dark;${block(themeCssVariables('dark'))}}`
  );
}
