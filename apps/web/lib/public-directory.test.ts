import type { PublicDoctorCard } from '@dhc/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonLdScript } from './public-doctor';
import { DIRECTORY_TIMEOUT_MS, loadDirectory } from './public-doctor-server';
import {
  cardName,
  cardPlaces,
  filterDirectory,
  searchText,
  specialtyOptions,
  websiteJsonLd,
} from './public-directory';

const card = (over: Partial<PublicDoctorCard>): PublicDoctorCard => ({
  slug: 'dr-synthetic',
  name: 'Dr. Synthetic',
  qualifications: 'MBBS',
  specialty: 'General medicine',
  organisationName: 'Demo Clinic',
  organisationDisplayName: null,
  clinics: [],
  languages: [],
  feeFromPaise: null,
  ...over,
});

const cards = [
  card({
    slug: 'dr-asha-test',
    name: 'Dr. Asha Test',
    specialty: 'Dermatology',
    organisationName: 'Skin Care Synthetic',
    clinics: [{ name: 'Main clinic', addressLine: '1 Test Road, Testpur' }],
  }),
  card({
    slug: 'dr-ravi-test',
    name: 'Dr Ravi Test',
    specialty: 'dermatology ',
    clinics: [{ name: 'Branch clinic', addressLine: null }],
  }),
  card({
    slug: 'dr-synthetic',
    specialty: 'Orthopaedics',
    organisationName: 'Bone Clinic',
    organisationDisplayName: 'Joint Care Synthetic',
  }),
  card({ slug: 'dr-no-specialty', name: null, specialty: null, organisationName: 'Nameless' }),
];
const slugs = (list: PublicDoctorCard[]) => list.map((c) => c.slug);
const all = { query: '', specialty: '' };

describe('searchText', () => {
  it('ignores case, punctuation, extra spaces and Latin accents', () => {
    expect(searchText('  Dr.  ÁSHA-Test ')).toBe('dr asha test');
  });

  it('keeps Devanagari vowel signs', () => {
    expect(searchText('डॉ. शर्मा')).toBe('डॉ शर्मा');
  });
});

describe('filterDirectory', () => {
  it('returns everything, in order, with no search', () => {
    expect(slugs(filterDirectory(cards, all))).toEqual(slugs(cards));
  });

  it.each([
    ['asha', ['dr-asha-test']],
    ['dr. ravi', ['dr-ravi-test']],
    ['DERMATOLOGY', ['dr-asha-test', 'dr-ravi-test']],
    ['testpur', ['dr-asha-test']],
    ['branch clinic', ['dr-ravi-test']],
    ['bone', ['dr-synthetic']],
    // The organisation's display name too.
    ['joint care', ['dr-synthetic']],
    ['nameless', ['dr-no-specialty']],
    // Every word must match, in any order.
    ['test asha', ['dr-asha-test']],
    ['asha orthopaedics', []],
    ['nobody', []],
  ])('finds %j', (query, expected) => {
    expect(slugs(filterDirectory(cards, { query, specialty: '' }))).toEqual(expected);
  });

  it('does not search the address path or the qualifications', () => {
    expect(filterDirectory(cards, { query: 'mbbs', specialty: '' })).toEqual([]);
    expect(filterDirectory(cards, { query: 'dr-no', specialty: '' })).toEqual([]);
  });

  it('filters by specialty, however it was typed, together with the search', () => {
    const [dermatology] = specialtyOptions(cards);
    expect(dermatology).toEqual({ key: 'dermatology', label: 'Dermatology' });
    expect(slugs(filterDirectory(cards, { query: '', specialty: 'dermatology' }))).toEqual([
      'dr-asha-test',
      'dr-ravi-test',
    ]);
    expect(slugs(filterDirectory(cards, { query: 'ravi', specialty: 'dermatology' }))).toEqual([
      'dr-ravi-test',
    ]);
    expect(filterDirectory(cards, { query: 'ravi', specialty: 'orthopaedics' })).toEqual([]);
  });
});

describe('specialtyOptions', () => {
  it('lists each specialty once, alphabetically, without empty ones', () => {
    expect(specialtyOptions(cards)).toEqual([
      { key: 'dermatology', label: 'Dermatology' },
      { key: 'orthopaedics', label: 'Orthopaedics' },
    ]);
    expect(specialtyOptions([])).toEqual([]);
  });
});

describe('cards', () => {
  it('names the clinic with the first line of its address, or alone', () => {
    expect(cardPlaces(cards[0]!)).toEqual(['Main clinic, 1 Test Road, Testpur']);
    expect(cardPlaces(cards[1]!)).toEqual(['Branch clinic']);
  });

  it('falls back to the organisation’s name', () => {
    expect(cardName(cards[3]!)).toBe('Nameless');
    expect(cardName(cards[0]!)).toBe('Dr. Asha Test');
  });
});

describe('websiteJsonLd', () => {
  it('describes the site only, and escapes like the doctor page', () => {
    const data = websiteJsonLd('Digital Healthcare Platform', 'https://site.test/');
    expect(data).toEqual({
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: 'Digital Healthcare Platform',
      url: 'https://site.test/',
    });
    expect(jsonLdScript(websiteJsonLd('</script>', 'https://site.test/'))).not.toContain('<');
  });
});

describe('loadDirectory', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  const answer = (status: number, body: unknown) =>
    vi.fn(async (_input: unknown, _init?: RequestInit) =>
      Response.json(body, { status, headers: { 'x-request-id': 'req-1' } }),
    );

  it('fetches the directory once, kept five minutes in the fetch cache', async () => {
    const fetch = answer(200, { data: [cards[0]] });
    vi.stubGlobal('fetch', fetch);
    expect(await loadDirectory()).toEqual([cards[0]]);
    expect(String(fetch.mock.calls[0]![0])).toMatch(/\/public\/doctor-directory$/);
    expect(fetch.mock.calls[0]![1]).toMatchObject({ next: { revalidate: 300 } });
  });

  it('gives up after three seconds, so a hanging API cannot hold the page', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation(() => AbortSignal.abort(new DOMException('slow', 'TimeoutError')));
    // An API that never answers: only the signal ends the wait.
    const hang = vi.fn(
      (_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          const signal = init!.signal!;
          if (signal.aborted) reject(signal.reason);
          signal.addEventListener('abort', () => reject(signal.reason));
        }),
    );
    vi.stubGlobal('fetch', hang);
    expect(await loadDirectory()).toBeNull();
    expect(timeout).toHaveBeenCalledWith(DIRECTORY_TIMEOUT_MS);
    expect(DIRECTORY_TIMEOUT_MS).toBe(3000);
  });

  it.each([
    ['busy (429)', () => answer(429, { error: { code: 'RATE_LIMITED', message: 'Slow down.' } })],
    ['down', () => vi.fn(() => Promise.reject(new TypeError('fetch failed')))],
    ['answering something else', () => answer(200, { data: 'nope' })],
  ])('is null when the API is %s, so the page still renders', async (_, make) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', make());
    expect(await loadDirectory()).toBeNull();
  });
});
