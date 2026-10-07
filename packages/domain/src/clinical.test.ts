import { describe, expect, it } from 'vitest';
import { ICD10_STARTER, bmiOf, searchIcd10 } from './index';

describe('bmiOf', () => {
  it('rounds to one decimal and needs both readings', () => {
    expect(bmiOf(70, 175)).toBe(22.9);
    expect(bmiOf(70, null)).toBeNull();
    expect(bmiOf(null, 175)).toBeNull();
  });
});

describe('searchIcd10', () => {
  it('finds by code prefix first', () => {
    expect(searchIcd10('m17')[0]?.code).toBe('M17.1');
    expect(searchIcd10('S83').map((e) => e.code)).toEqual(['S83.5', 'S83.2']);
  });

  it('finds by every word of the label or everyday terms', () => {
    expect(searchIcd10('frozen shoulder').map((e) => e.code)).toEqual(['M75.0']);
    expect(searchIcd10('knee oste').map((e) => e.code)).toEqual(['M17.1']);
    expect(searchIcd10('tennis')[0]?.code).toBe('M77.1');
  });

  it('returns nothing for blank or unknown queries, and caps results', () => {
    expect(searchIcd10('  ')).toEqual([]);
    expect(searchIcd10('zzz')).toEqual([]);
    expect(searchIcd10('f', 3)).toHaveLength(3);
  });

  it('holds valid, unique codes', () => {
    const codes = ICD10_STARTER.map((e) => e.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of codes) expect(c).toMatch(/^[A-Z][0-9]{2}(\.[0-9A-Z]{1,4})?$/);
  });
});
