/**
 * How an ordered test reads on the prescription and on screen (PRD §7.1): the test, the
 * body region in lower case, the side and the X-ray views, e.g. "MRI knee, right" or
 * "X-ray knee, both sides (AP, Lateral)". Test and region names stay as the clinic wrote them in
 * both languages, like medicine names; only the side is translated.
 */
export type TestLabelLanguage = 'en' | 'hi';

export interface TestLabelInput {
  name: string;
  region: string | null;
  side: 'left' | 'right' | 'both' | 'na';
  views: readonly string[];
}

const SIDES: Record<TestLabelLanguage, Record<'left' | 'right' | 'both', string>> = {
  en: { left: 'left', right: 'right', both: 'both sides' },
  hi: { left: 'बायाँ', right: 'दायाँ', both: 'दोनों तरफ़' },
};

/** Lower-cases a region unless it starts with an abbreviation (PNS, HRCT). */
function regionText(region: string): string {
  const first = region.split(/\s+/)[0] ?? '';
  return first.length > 1 && first === first.toUpperCase() ? region : region.toLowerCase();
}

export function testOrderLabel(order: TestLabelInput, language: TestLabelLanguage): string {
  let text = order.name.trim();
  if (order.region) text += ` ${regionText(order.region.trim())}`;
  if (order.side !== 'na') text += `, ${SIDES[language][order.side]}`;
  if (order.views.length) text += ` (${order.views.join(', ')})`;
  return text;
}
