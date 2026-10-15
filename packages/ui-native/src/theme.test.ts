import { describe, expect, it } from 'vitest';
import {
  buttonColors,
  nativeTheme,
  noticeColors,
  type ButtonVariant,
  type NoticeTone,
} from './theme';

/** WCAG 2.x contrast ratio of two `#rrggbb` colours. */
function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('nativeTheme', () => {
  it('gives hex colours for both modes, and different ones in dark mode', () => {
    const light = nativeTheme('light');
    const dark = nativeTheme('dark');
    expect(light.colors.background).toMatch(/^#[0-9a-f]{6}$/);
    expect(dark.colors.background).not.toBe(light.colors.background);
  });

  it('derives the radius scale as web does', () => {
    const { radii } = nativeTheme('light');
    expect(radii.lg).toBe(16);
    expect(radii.sm).toBe(12);
    expect(radii['2xl']).toBe(24);
  });

  it('keeps one theme object per mode, so context consumers do not re-render needlessly', () => {
    expect(nativeTheme('dark')).toBe(nativeTheme('dark'));
  });
});

describe('text contrast (WCAG AA, 4.5:1)', () => {
  for (const mode of ['light', 'dark'] as const) {
    const theme = nativeTheme(mode);
    for (const variant of ['primary', 'secondary', 'destructive'] as ButtonVariant[]) {
      it(`${mode} ${variant} button`, () => {
        const { background, text } = buttonColors(theme, variant);
        expect(contrast(background, text)).toBeGreaterThanOrEqual(4.5);
      });
    }
    it(`${mode} ghost button on the background`, () => {
      expect(
        contrast(theme.colors.background, buttonColors(theme, 'ghost').text),
      ).toBeGreaterThanOrEqual(4.5);
    });
    for (const tone of ['error', 'warning', 'info', 'success'] as NoticeTone[]) {
      it(`${mode} ${tone} notice`, () => {
        const { background, text } = noticeColors(theme, tone);
        expect(contrast(background, text)).toBeGreaterThanOrEqual(4.5);
      });
    }
    it(`${mode} muted text on cards`, () => {
      expect(contrast(theme.colors.card, theme.colors['muted-foreground'])).toBeGreaterThanOrEqual(
        4.5,
      );
    });
  }
});
