/**
 * Dosage remarks (PRD §6.4): the sentence printed under each medicine, written from the
 * dose, frequency, timing and duration in English or Hindi — e.g. "Take 5 ml three
 * times a day, after breakfast, lunch and dinner, for 5 days." Supports slot patterns
 * (1-0-1), the usual codes (OD, BD, TDS, QID, HS, SOS, STAT), weekly, monthly and
 * alternate-day schedules, and tapering as several steps. The doctor can always edit
 * the result; anything not understood is passed through as written.
 */

export const DOSE_TIMINGS = [
  'after_food',
  'before_food',
  'with_food',
  'empty_stomach',
  'bedtime',
] as const;
export type DoseTiming = (typeof DOSE_TIMINGS)[number];

export const DURATION_UNITS = ['days', 'weeks', 'months'] as const;
export type DurationUnit = (typeof DURATION_UNITS)[number];

export const ROUTES = [
  'oral',
  'topical',
  'inhaled',
  'eye',
  'ear',
  'nasal',
  'injection',
  'other',
] as const;
export type Route = (typeof ROUTES)[number];

/** One step of a schedule; a tapering course has several, followed in order. */
export interface DoseStep {
  dose: string;
  frequency: string;
  durationValue: number | null;
  durationUnit: DurationUnit | null;
}

export interface RemarkInput {
  steps: DoseStep[];
  timing: DoseTiming | null;
  route: Route | null;
}

export type RemarkLanguage = 'en' | 'hi';

/**
 * The longest remark a line can carry (the `remarks` limit in @dhc/contracts). It fits the
 * generated text for the longest valid line: six steps with 60-character doses and
 * frequencies.
 */
export const REMARKS_MAX = 1200;

type Slot = 'morning' | 'afternoon' | 'night' | 'bedtime';
const SLOTS: Slot[] = ['morning', 'afternoon', 'night', 'bedtime'];

type Frequency =
  | { kind: 'slots'; values: string[] }
  | { kind: 'perDay'; times: number }
  | { kind: 'hs' | 'sos' | 'stat' | 'weekly' | 'monthly' | 'alternate' }
  | { kind: 'text'; text: string };

const CODES: Record<string, Frequency> = {
  od: { kind: 'perDay', times: 1 },
  qd: { kind: 'perDay', times: 1 },
  'once a day': { kind: 'perDay', times: 1 },
  'once daily': { kind: 'perDay', times: 1 },
  bd: { kind: 'perDay', times: 2 },
  bid: { kind: 'perDay', times: 2 },
  'twice a day': { kind: 'perDay', times: 2 },
  'twice daily': { kind: 'perDay', times: 2 },
  tds: { kind: 'perDay', times: 3 },
  tid: { kind: 'perDay', times: 3 },
  qid: { kind: 'perDay', times: 4 },
  hs: { kind: 'hs' },
  sos: { kind: 'sos' },
  prn: { kind: 'sos' },
  stat: { kind: 'stat' },
  weekly: { kind: 'weekly' },
  'once a week': { kind: 'weekly' },
  monthly: { kind: 'monthly' },
  'once a month': { kind: 'monthly' },
  'alternate days': { kind: 'alternate' },
  'alternate day': { kind: 'alternate' },
  ad: { kind: 'alternate' },
};

/** A slot value: 0, 1, 2, ½, 1/2 or 0.5. */
const SLOT_VALUE = /^(\d+|½|1\/2|0?\.5)$/;

export function parseFrequency(raw: string): Frequency {
  const text = raw.trim();
  const code = CODES[text.toLowerCase().replace(/\s+/g, ' ')];
  if (code) return code;
  const parts = text.split(/\s*-\s*/);
  if ((parts.length === 3 || parts.length === 4) && parts.every((p) => SLOT_VALUE.test(p))) {
    const values = parts.map((p) => (p === '1/2' || p === '.5' || p === '0.5' ? '½' : p));
    if (values.some((v) => v !== '0')) return { kind: 'slots', values };
  }
  return { kind: 'text', text };
}

// ---- Language tables ------------------------------------------------------------------

const MEAL = {
  en: { morning: 'breakfast', afternoon: 'lunch', night: 'dinner' },
  hi: { morning: 'नाश्ते', afternoon: 'दोपहर के खाने', night: 'रात के खाने' },
} as const;

const TIME = {
  en: {
    morning: 'in the morning',
    afternoon: 'in the afternoon',
    night: 'at night',
    bedtime: 'at bedtime',
  },
  hi: { morning: 'सुबह', afternoon: 'दोपहर', night: 'रात को', bedtime: 'सोते समय' },
} as const;

const TIMES_A_DAY = {
  en: ['', 'once a day', 'twice a day', 'three times a day', 'four times a day'],
  hi: ['', 'दिन में एक बार', 'दिन में दो बार', 'दिन में तीन बार', 'दिन में चार बार'],
} as const;

const FIXED = {
  en: {
    hs: 'at bedtime',
    sos: 'when needed',
    stat: 'immediately, once',
    weekly: 'once a week',
    monthly: 'once a month',
    alternate: 'on alternate days',
  },
  hi: {
    hs: 'सोते समय',
    sos: 'ज़रूरत पड़ने पर',
    stat: 'तुरंत, एक बार',
    weekly: 'हफ़्ते में एक बार',
    monthly: 'महीने में एक बार',
    alternate: 'एक दिन छोड़कर',
  },
} as const;

const GENERAL_TIMING = {
  en: {
    after_food: 'after food',
    before_food: 'before food',
    with_food: 'with food',
    empty_stomach: 'on an empty stomach',
    bedtime: 'at bedtime',
  },
  hi: {
    after_food: 'खाने के बाद',
    before_food: 'खाने से पहले',
    with_food: 'खाने के साथ',
    empty_stomach: 'खाली पेट',
    bedtime: 'सोते समय',
  },
} as const;

const MEAL_TIMING = {
  en: { after_food: 'after', before_food: 'before', with_food: 'with' },
  hi: { after_food: 'के बाद', before_food: 'से पहले', with_food: 'के साथ' },
} as const;

const VERB = {
  en: {
    oral: 'Take',
    topical: 'Apply',
    inhaled: 'Inhale',
    eye: 'Put',
    ear: 'Put',
    nasal: 'Put',
    injection: 'Inject',
    other: 'Use',
  },
  hi: {
    oral: 'लें',
    topical: 'लगाएँ',
    inhaled: 'इनहेल करें',
    eye: 'डालें',
    ear: 'डालें',
    nasal: 'डालें',
    injection: 'लगवाएँ',
    other: 'इस्तेमाल करें',
  },
} as const;

const UNIT = {
  en: { days: ['day', 'days'], weeks: ['week', 'weeks'], months: ['month', 'months'] },
  hi: { days: ['दिन', 'दिन'], weeks: ['हफ़्ते', 'हफ़्ते'], months: ['महीने', 'महीने'] },
} as const;

/** Common dose words in Hindi as [singular, plural]; numbers and units such as mg and ml stay as written. */
const HINDI_DOSE_WORDS: [RegExp, string, string][] = [
  [/\b(tablets?|tabs?)\b/gi, 'गोली', 'गोलियाँ'],
  [/\bcapsules?\b/gi, 'कैप्सूल', 'कैप्सूल'],
  [/\bdrops?\b/gi, 'बूँद', 'बूँदें'],
  [/\bpuffs?\b/gi, 'पफ़', 'पफ़'],
  [/\bsachets?\b/gi, 'पाउच', 'पाउच'],
  [/\bteaspoons?\b/gi, 'चम्मच', 'चम्मच'],
  [/\bthin layer\b/gi, 'पतली परत', 'पतली परत'],
];

/** True for a dose that starts with a number above one ("2 tablets", "1.5 tablets"). */
function isPlural(dose: string): boolean {
  const n = /^([\d.]+)(?![\d./½])/.exec(dose)?.[1];
  return n !== undefined && Number(n) > 1;
}

function list(items: string[], lang: RemarkLanguage): string {
  const and = lang === 'en' ? 'and' : 'और';
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} ${and} ${items[items.length - 1]}`;
}

function doseText(dose: string, lang: RemarkLanguage): string {
  const d = dose.trim();
  if (lang === 'en') return d;
  const plural = isPlural(d);
  return HINDI_DOSE_WORDS.reduce((s, [re, one, many]) => s.replace(re, plural ? many : one), d);
}

function durationText(step: DoseStep, lang: RemarkLanguage): string {
  if (!step.durationValue || !step.durationUnit) return '';
  const [one, many] = UNIT[lang][step.durationUnit];
  const unit = step.durationValue === 1 ? one : many;
  return lang === 'en' ? `for ${step.durationValue} ${unit}` : `${step.durationValue} ${unit} तक`;
}

const MEAL_TIMINGS = ['after_food', 'before_food', 'with_food'] as const;
const isMealTiming = (t: DoseTiming | null): t is (typeof MEAL_TIMINGS)[number] =>
  (MEAL_TIMINGS as readonly (DoseTiming | null)[]).includes(t);

/** Frequency and timing words for one step, e.g. "three times a day, after breakfast…". */
function whenText(freq: Frequency, timing: DoseTiming | null, lang: RemarkLanguage): string[] {
  if (freq.kind === 'text') {
    return [freq.text, ...(timing ? [GENERAL_TIMING[lang][timing]] : [])];
  }
  if (freq.kind === 'perDay') {
    return [TIMES_A_DAY[lang][freq.times]!, ...(timing ? [GENERAL_TIMING[lang][timing]] : [])];
  }
  if (freq.kind !== 'slots') {
    // HS already says "at bedtime"; any other timing is added as chosen.
    const fixed = FIXED[lang][freq.kind];
    return timing && !(freq.kind === 'hs' && timing === 'bedtime')
      ? [fixed, GENERAL_TIMING[lang][timing]]
      : [fixed];
  }

  const taken = slotsTaken(freq);
  const daySlots = taken.filter(({ slot }) => slot !== 'bedtime').map(({ slot }) => slot);
  const atBedtime = taken.some(({ slot }) => slot === 'bedtime');
  const out: string[] = [TIMES_A_DAY[lang][Math.min(taken.length, 4)]!];

  if (isMealTiming(timing)) {
    const meals = daySlots.map((s) => MEAL[lang][s as Exclude<Slot, 'bedtime'>]);
    if (meals.length > 0) {
      out.push(
        lang === 'en'
          ? `${MEAL_TIMING.en[timing]} ${list(meals, 'en')}`
          : `${list(meals, 'hi')} ${MEAL_TIMING.hi[timing]}`,
      );
    } else {
      // Bedtime only (0-0-0-1): keep the chosen food timing.
      out.push(GENERAL_TIMING[lang][timing]);
    }
    if (atBedtime) out.push(TIME[lang].bedtime);
    return out;
  }
  if (timing === 'bedtime') return [...out, TIME[lang].bedtime];
  out.push(
    list(
      taken.map(({ slot }) => TIME[lang][slot]),
      lang,
    ),
  );
  // The time of day first: "in the morning, on an empty stomach".
  if (timing === 'empty_stomach') out.push(GENERAL_TIMING[lang].empty_stomach);
  return out;
}

const slotsTaken = (freq: { values: string[] }) =>
  freq.values.map((v, i) => ({ v, slot: SLOTS[i]! })).filter(({ v }) => v !== '0');

/** Words that take an English plural ("2 tablets", "1 tablet"); units such as ml do not. */
const COUNTABLE = /^(tablet|tab|capsule|drop|puff|sachet|teaspoon)s?$/i;

/** "tablet" from "1 tablet", "tablets" or "2 tablets"; "ml" from "5 ml"; '' from "2". */
const doseUnit = (dose: string) => dose.trim().replace(/^[\d½./]+\s*/, '');

function amount(value: string, unit: string, lang: RemarkLanguage): string {
  if (!unit) return value;
  if (lang === 'hi') return doseText(`${value} ${unit}`, 'hi');
  if (!COUNTABLE.test(unit)) return `${value} ${unit}`;
  const singular = unit.replace(/s$/i, '');
  return `${value} ${value === '1' || value === '½' ? singular : `${singular}s`}`;
}

/**
 * A slot pattern with amounts other than 1 ("2-0-2", "½-0-½", "2-0-1"): each slot gets
 * its own amount, so the remark never understates the dose — "2 tablets after breakfast
 * and 1 tablet after dinner".
 */
function slotAmountsText(
  values: string[],
  dose: string,
  timing: DoseTiming | null,
  lang: RemarkLanguage,
): string[] {
  const taken = slotsTaken({ values });
  const whole = dose.trim();
  const unit = doseUnit(dose);
  const measured = unit !== whole && unit !== '' && !COUNTABLE.test(unit);
  const phrases = taken.map(({ v, slot }) => {
    const when =
      isMealTiming(timing) && slot !== 'bedtime'
        ? lang === 'en'
          ? `${MEAL_TIMING.en[timing]} ${MEAL.en[slot]}`
          : `${MEAL.hi[slot]} ${MEAL_TIMING.hi[timing]}`
        : TIME[lang][slot];
    // A measured dose ("500 mg", "5 ml") is one unit of medicine: "2 × 500 mg".
    const qty = measured ? (v === '1' ? whole : `${v} × ${whole}`) : amount(v, unit, lang);
    return lang === 'en' ? `${qty} ${when}` : `${when} ${qty}`;
  });
  const out = [list(phrases, lang)];
  if (timing === 'empty_stomach') out.push(GENERAL_TIMING[lang].empty_stomach);
  if (timing === 'bedtime' && !taken.some(({ slot }) => slot === 'bedtime')) {
    out.push(TIME[lang].bedtime);
  }
  return out;
}

/** "5 ml three times a day, after breakfast, lunch and dinner, for 5 days". */
function stepText(step: DoseStep, timing: DoseTiming | null, lang: RemarkLanguage): string {
  const freq = parseFrequency(step.frequency);
  const duration = durationText(step, lang);
  if (freq.kind === 'slots' && freq.values.some((v) => v !== '0' && v !== '1')) {
    // The amounts already carry the dose: "2 tablets in the morning…, for 5 days".
    return [...slotAmountsText(freq.values, step.dose, timing, lang), duration]
      .filter(Boolean)
      .join(', ');
  }
  const parts = [doseText(step.dose, lang), ...whenText(freq, timing, lang), duration];
  const [first, ...rest] = parts.filter(Boolean);
  return rest.length > 0 ? `${first} ${rest.join(', ')}` : (first ?? '');
}

/**
 * The remark for one prescription line, or '' when there is nothing to say yet (no dose
 * and no frequency in the first step).
 */
export function dosageRemarks(input: RemarkInput, lang: RemarkLanguage): string {
  const steps = input.steps.filter((s) => s.dose.trim() || s.frequency.trim());
  if (steps.length === 0) return '';
  const verb = VERB[lang][input.route ?? 'oral'];
  const body = steps.map((s) => stepText(s, input.timing, lang));
  if (lang === 'en') return `${verb} ${body.join(', then ')}.`;
  return `${body.join(', फिर ')} ${verb}।`;
}
