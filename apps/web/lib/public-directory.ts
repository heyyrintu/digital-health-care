import type { PublicDoctorCard } from '@dhc/contracts';

/**
 * Pure helpers behind the home page's "Find a doctor" directory (Build Plan §5.1), kept out
 * of the components so they can be unit tested. The list comes from the API once (cached
 * five minutes) and is searched here, in the browser: typing never calls the API.
 */

/**
 * Text as the search compares it: lowercase, Latin accents dropped, and anything but
 * letters (with their combining marks, so Devanagari vowel signs stay) and digits turned
 * into single spaces. "Dr. Sharma" and "dr sharma" match.
 */
export function searchText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * What a card can be found by: the doctor's name, specialty, organisation, and each clinic's
 * name and first address line.
 */
function haystack(card: PublicDoctorCard): string {
  return searchText(
    [
      card.name,
      card.specialty,
      card.organisationName,
      ...card.clinics.flatMap((c) => [c.name, c.addressLine]),
    ]
      .filter(Boolean)
      .join(' '),
  );
}

/** The specialty filter's key: the same specialty however it was capitalised or spaced. */
const specialtyKey = (specialty: string) => searchText(specialty);

export interface DirectoryFilter {
  /** Free text: every word must appear somewhere on the card. */
  query: string;
  /** A key from `specialtyOptions`, or '' for all. */
  specialty: string;
}

/** The cards that match, in the API's order (by name). */
export function filterDirectory(
  cards: readonly PublicDoctorCard[],
  { query, specialty }: DirectoryFilter,
): PublicDoctorCard[] {
  const words = searchText(query).split(' ').filter(Boolean);
  return cards.filter((card) => {
    if (specialty && (!card.specialty || specialtyKey(card.specialty) !== specialty)) {
      return false;
    }
    if (words.length === 0) return true;
    const text = haystack(card);
    return words.every((word) => text.includes(word));
  });
}

/**
 * The specialties to filter by, once each whatever the case, alphabetically: the key the
 * filter compares and the label (the first spelling seen).
 */
export function specialtyOptions(
  cards: readonly PublicDoctorCard[],
): { key: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const card of cards) {
    const label = card.specialty?.trim();
    if (!label) continue;
    const key = specialtyKey(label);
    if (key && !seen.has(key)) seen.set(key, label);
  }
  return [...seen]
    .map(([key, label]) => ({ key, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** "Main clinic, 1 Test Road" for each clinic (the name alone when it has no address). */
export const cardPlaces = (card: PublicDoctorCard) =>
  card.clinics.map((c) => (c.addressLine ? `${c.name}, ${c.addressLine}` : c.name));

/** The doctor's name on the card, or the organisation's when the doctor has none. */
export const cardName = (card: PublicDoctorCard) => card.name ?? card.organisationName;

/**
 * schema.org `WebSite` markup for the home page (https://schema.org/WebSite): the site's
 * name and address only. No search action, since searching happens in the page.
 */
export function websiteJsonLd(name: string, url: string): Record<string, unknown> {
  return { '@context': 'https://schema.org', '@type': 'WebSite', name, url };
}
