import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  oklchToHex,
  themeColors,
  themeCssVariables,
  themeHex,
  themeStylesheet,
  type ThemeColor,
} from './theme';

const themeCss = readFileSync(new URL('./theme.css', import.meta.url), 'utf8');

describe('theme.css', () => {
  it('maps every theme colour to a Tailwind colour, and nothing else', () => {
    const mapped = [...themeCss.matchAll(/--color-([a-z0-9-]+): var\(--([a-z0-9-]+)\);/g)];
    for (const [, tailwindName, cssVar] of mapped) expect(tailwindName).toBe(cssVar);
    expect(mapped.map(([, name]) => name).sort()).toEqual(Object.keys(themeColors.light).sort());
  });

  it('only maps variables the stylesheet defines', () => {
    const defined = new Set(Object.keys(themeCssVariables('light')));
    const used = [...themeCss.matchAll(/var\((--[a-z0-9-]+)\)/g)].map(([, name]) => name);
    for (const name of used) expect(defined, name).toContain(name);
  });
});

describe('themeColors', () => {
  it('gives dark mode a value for every colour', () => {
    expect(Object.keys(themeColors.dark).sort()).toEqual(Object.keys(themeColors.light).sort());
  });

  it('keeps foreground text readable on its background', () => {
    const pairs: [ThemeColor, ThemeColor][] = [
      ['foreground', 'background'],
      ['card-foreground', 'card'],
      ['primary-foreground', 'primary'],
      ['muted-foreground', 'background'],
      ['muted-foreground', 'card'],
      ['destructive-foreground', 'destructive'],
      ['success-foreground', 'success'],
      ['info-foreground', 'info'],
      ['warning-foreground', 'warning-soft'],
      // Status chips: coloured text on the soft background.
      ['destructive', 'danger-soft'],
      ['success', 'success-soft'],
      ['info', 'info-soft'],
      ['primary', 'accent'],
      ['sidebar-foreground', 'sidebar'],
    ];
    for (const mode of ['light', 'dark'] as const) {
      const hex = themeHex(mode);
      for (const [fg, bg] of pairs) {
        // WCAG AA for normal text.
        expect(contrast(hex[fg], hex[bg]), `${mode} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe('oklchToHex', () => {
  it('converts white, black and a known colour', () => {
    expect(oklchToHex('oklch(1 0 0)')).toBe('#ffffff');
    expect(oklchToHex('oklch(0 0 0)')).toBe('#000000');
    // oklch(0.628 0.2577 29.23) is sRGB red.
    expect(oklchToHex('oklch(0.628 0.2577 29.23)')).toBe('#ff0000');
  });

  it('keeps alpha and rejects other formats', () => {
    expect(oklchToHex('oklch(1 0 0 / 0.5)')).toBe('#ffffff80');
    expect(() => oklchToHex('#fff')).toThrow();
  });

  it('gives mobile a hex value for every theme colour', () => {
    for (const value of Object.values(themeHex('light'))) {
      expect(value).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/);
    }
  });
});

describe('themeStylesheet', () => {
  it('puts light values and extras on :root and dark values on .dark', () => {
    const css = themeStylesheet({ '--space-4': '16px' });
    expect(css).toContain(':root{--space-4:16px;--background:oklch(0.975 0.005 130)');
    expect(css).toContain('--radius:16px');
    expect(css).toContain('--font-family-sans:"Figtree Variable", "Noto Sans Devanagari Variable"');
    expect(css).toMatch(/\.dark\{color-scheme:dark;--background:oklch\(0\.17 0\.02 205\)/);
  });
});

function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}
