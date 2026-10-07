import { describe, expect, it } from 'vitest';
import {
  dosageRemarks,
  parseFrequency,
  REMARKS_MAX,
  type DoseStep,
  type RemarkInput,
} from './index';

const step = (over: Partial<DoseStep> = {}): DoseStep => ({
  dose: '1 tablet',
  frequency: '1-0-1',
  durationValue: 5,
  durationUnit: 'days',
  ...over,
});
const line = (over: Partial<RemarkInput> = {}, steps = [step()]): RemarkInput => ({
  steps,
  timing: 'after_food',
  route: 'oral',
  ...over,
});

describe('parseFrequency', () => {
  it('reads slot patterns, codes and free text', () => {
    expect(parseFrequency('1-0-1')).toEqual({ kind: 'slots', values: ['1', '0', '1'] });
    expect(parseFrequency(' 1 - 1 - 1 ')).toEqual({ kind: 'slots', values: ['1', '1', '1'] });
    expect(parseFrequency('1/2-0-1/2')).toEqual({ kind: 'slots', values: ['½', '0', '½'] });
    expect(parseFrequency('0-0-0-1')).toEqual({ kind: 'slots', values: ['0', '0', '0', '1'] });
    expect(parseFrequency('BD')).toEqual({ kind: 'perDay', times: 2 });
    expect(parseFrequency('sos')).toEqual({ kind: 'sos' });
    expect(parseFrequency('0-0-0')).toEqual({ kind: 'text', text: '0-0-0' });
    expect(parseFrequency('every 6 hours')).toEqual({ kind: 'text', text: 'every 6 hours' });
  });
});

describe('dosageRemarks in English', () => {
  it('writes the PRD example', () => {
    expect(dosageRemarks(line({}, [step({ dose: '5 ml', frequency: '1-1-1' })]), 'en')).toBe(
      'Take 5 ml three times a day, after breakfast, lunch and dinner, for 5 days.',
    );
  });

  it('names the meals for each slot pattern and timing', () => {
    expect(dosageRemarks(line(), 'en')).toBe(
      'Take 1 tablet twice a day, after breakfast and dinner, for 5 days.',
    );
    expect(
      dosageRemarks(line({ timing: 'before_food' }, [step({ frequency: '1-0-0' })]), 'en'),
    ).toBe('Take 1 tablet once a day, before breakfast, for 5 days.');
    expect(dosageRemarks(line({ timing: null }, [step({ frequency: '0-0-1' })]), 'en')).toBe(
      'Take 1 tablet once a day, at night, for 5 days.',
    );
    expect(
      dosageRemarks(line({ timing: 'empty_stomach' }, [step({ frequency: '1-0-0' })]), 'en'),
    ).toBe('Take 1 tablet once a day, in the morning, on an empty stomach, for 5 days.');
    expect(dosageRemarks(line({}, [step({ frequency: '1-0-1-1' })]), 'en')).toBe(
      'Take 1 tablet three times a day, after breakfast and dinner, at bedtime, for 5 days.',
    );
  });

  it('gives each slot its own amount whenever an amount is not 1', () => {
    expect(
      dosageRemarks(line({ timing: null }, [step({ dose: 'tablets', frequency: '2-0-1' })]), 'en'),
    ).toBe('Take 2 tablets in the morning and 1 tablet at night, for 5 days.');
    // Same amount in every slot still says how much.
    expect(dosageRemarks(line({}, [step({ frequency: '2-0-2' })]), 'en')).toBe(
      'Take 2 tablets after breakfast and 2 tablets after dinner, for 5 days.',
    );
    expect(dosageRemarks(line({ timing: null }, [step({ frequency: '½-0-½' })]), 'en')).toBe(
      'Take ½ tablet in the morning and ½ tablet at night, for 5 days.',
    );
    expect(
      dosageRemarks(line({ timing: null }, [step({ dose: '5 ml', frequency: '2-0-1' })]), 'en'),
    ).toBe('Take 2 × 5 ml in the morning and 5 ml at night, for 5 days.');
    expect(dosageRemarks(line({}, [step({ dose: '500 mg', frequency: '2-0-1' })]), 'hi')).toBe(
      'नाश्ते के बाद 2 × 500 mg और रात के खाने के बाद 500 mg, 5 दिन तक लें।',
    );
    // A chosen bedtime is kept.
    expect(dosageRemarks(line({ timing: 'bedtime' }, [step({ frequency: '2-1-0' })]), 'en')).toBe(
      'Take 2 tablets in the morning and 1 tablet in the afternoon, at bedtime, for 5 days.',
    );
  });

  it('keeps the timing chosen with fixed schedules', () => {
    expect(
      dosageRemarks(
        line({ timing: 'bedtime' }, [
          step({ frequency: 'SOS', durationValue: null, durationUnit: null }),
        ]),
        'en',
      ),
    ).toBe('Take 1 tablet when needed, at bedtime.');
    expect(dosageRemarks(line({ timing: 'after_food' }, [step({ frequency: 'HS' })]), 'en')).toBe(
      'Take 1 tablet at bedtime, after food, for 5 days.',
    );
    expect(dosageRemarks(line({ timing: 'bedtime' }, [step({ frequency: 'HS' })]), 'en')).toBe(
      'Take 1 tablet at bedtime, for 5 days.',
    );
  });

  it('handles codes, as-needed and long-interval schedules', () => {
    expect(
      dosageRemarks(
        line({}, [step({ frequency: 'TDS', durationValue: 1, durationUnit: 'weeks' })]),
        'en',
      ),
    ).toBe('Take 1 tablet three times a day, after food, for 1 week.');
    expect(
      dosageRemarks(
        line({ timing: null }, [
          step({ frequency: 'SOS', durationValue: null, durationUnit: null }),
        ]),
        'en',
      ),
    ).toBe('Take 1 tablet when needed.');
    expect(
      dosageRemarks(
        line({}, [
          step({ dose: '1 sachet', frequency: 'weekly', durationValue: 8, durationUnit: 'weeks' }),
        ]),
        'en',
      ),
    ).toBe('Take 1 sachet once a week, after food, for 8 weeks.');
    expect(dosageRemarks(line({ timing: null }, [step({ frequency: 'HS' })]), 'en')).toBe(
      'Take 1 tablet at bedtime, for 5 days.',
    );
    expect(
      dosageRemarks(line({ timing: null }, [step({ frequency: 'every 6 hours' })]), 'en'),
    ).toBe('Take 1 tablet every 6 hours, for 5 days.');
  });

  it('uses the route’s verb', () => {
    expect(
      dosageRemarks(
        line({ route: 'topical', timing: null }, [
          step({ dose: 'a thin layer', frequency: 'TDS' }),
        ]),
        'en',
      ),
    ).toBe('Apply a thin layer three times a day, for 5 days.');
    expect(
      dosageRemarks(
        line({ route: 'eye', timing: null }, [step({ dose: '1 drop', frequency: 'QID' })]),
        'en',
      ),
    ).toBe('Put 1 drop four times a day, for 5 days.');
  });

  it('writes tapering courses as steps', () => {
    expect(
      dosageRemarks(
        line({}, [
          step({ dose: '2 tablets', frequency: 'OD', durationValue: 5 }),
          step({ dose: '1 tablet', frequency: 'OD', durationValue: 5 }),
        ]),
        'en',
      ),
    ).toBe(
      'Take 2 tablets once a day, after food, for 5 days, then 1 tablet once a day, after food, for 5 days.',
    );
  });

  it('says nothing until there is a dose or frequency', () => {
    expect(dosageRemarks(line({}, [step({ dose: '', frequency: '' })]), 'en')).toBe('');
    expect(dosageRemarks(line({}, []), 'en')).toBe('');
  });
});

describe('dosageRemarks in Hindi', () => {
  it('writes the PRD example', () => {
    expect(dosageRemarks(line({}, [step({ dose: '5 ml', frequency: '1-1-1' })]), 'hi')).toBe(
      '5 ml दिन में तीन बार, नाश्ते, दोपहर के खाने और रात के खाने के बाद, 5 दिन तक लें।',
    );
  });

  it('gives each slot its own amount in Hindi too', () => {
    expect(dosageRemarks(line({}, [step({ frequency: '2-0-1' })]), 'hi')).toBe(
      'नाश्ते के बाद 2 गोलियाँ और रात के खाने के बाद 1 गोली, 5 दिन तक लें।',
    );
  });

  it('translates dose words, timings, as-needed and tapering', () => {
    expect(dosageRemarks(line(), 'hi')).toBe(
      '1 गोली दिन में दो बार, नाश्ते और रात के खाने के बाद, 5 दिन तक लें।',
    );
    expect(
      dosageRemarks(
        line({ timing: null }, [
          step({ frequency: 'SOS', durationValue: null, durationUnit: null }),
        ]),
        'hi',
      ),
    ).toBe('1 गोली ज़रूरत पड़ने पर लें।');
    expect(
      dosageRemarks(
        line({}, [
          step({ dose: '2 tablets', frequency: 'OD', durationValue: 1, durationUnit: 'weeks' }),
          step({ dose: '1 tablet', frequency: 'OD', durationValue: 1, durationUnit: 'weeks' }),
        ]),
        'hi',
      ),
    ).toBe(
      '2 गोलियाँ दिन में एक बार, खाने के बाद, 1 हफ़्ते तक, फिर 1 गोली दिन में एक बार, खाने के बाद, 1 हफ़्ते तक लें।',
    );
    expect(
      dosageRemarks(
        line({ route: 'topical', timing: null }, [step({ dose: 'thin layer', frequency: 'BD' })]),
        'hi',
      ),
    ).toBe('पतली परत दिन में दो बार, 5 दिन तक लगाएँ।');
  });
});

describe('dosageRemarks coverage', () => {
  const once = (over: Partial<DoseStep>, rest: Partial<RemarkInput> = {}) =>
    line({ timing: null, ...rest }, [step(over)]);

  it('keeps food timing on a bedtime-only pattern', () => {
    expect(dosageRemarks(line({}, [step({ frequency: '0-0-0-1' })]), 'en')).toBe(
      'Take 1 tablet once a day, after food, at bedtime, for 5 days.',
    );
    expect(dosageRemarks(line({}, [step({ frequency: '0-0-0-1' })]), 'hi')).toBe(
      '1 गोली दिन में एक बार, खाने के बाद, सोते समय, 5 दिन तक लें।',
    );
  });

  it('puts the time of day before an empty stomach in Hindi too', () => {
    expect(
      dosageRemarks(line({ timing: 'empty_stomach' }, [step({ frequency: '1-0-0' })]), 'hi'),
    ).toBe('1 गोली दिन में एक बार, सुबह, खाली पेट, 5 दिन तक लें।');
  });

  it('covers STAT, monthly and alternate days, months and with-food timing', () => {
    const stat = once({ frequency: 'STAT', durationValue: null, durationUnit: null });
    expect(dosageRemarks(stat, 'en')).toBe('Take 1 tablet immediately, once.');
    expect(dosageRemarks(stat, 'hi')).toBe('1 गोली तुरंत, एक बार लें।');
    const monthly = once({ frequency: 'monthly', durationValue: 3, durationUnit: 'months' });
    expect(dosageRemarks(monthly, 'en')).toBe('Take 1 tablet once a month, for 3 months.');
    expect(dosageRemarks(monthly, 'hi')).toBe('1 गोली महीने में एक बार, 3 महीने तक लें।');
    const alternate = once({ frequency: 'alternate days' });
    expect(dosageRemarks(alternate, 'en')).toBe('Take 1 tablet on alternate days, for 5 days.');
    expect(dosageRemarks(alternate, 'hi')).toBe('1 गोली एक दिन छोड़कर, 5 दिन तक लें।');
    expect(dosageRemarks(once({ frequency: 'BD' }, { timing: 'with_food' }), 'en')).toBe(
      'Take 1 tablet twice a day, with food, for 5 days.',
    );
  });

  it('uses the verb for each route, oral when none is chosen', () => {
    const verbs = (lang: 'en' | 'hi') =>
      ([null, 'inhaled', 'ear', 'nasal', 'injection', 'other'] as const).map((route) =>
        dosageRemarks(once({ dose: '2 puffs', frequency: 'BD' }, { route }), lang),
      );
    expect(verbs('en').map((r) => r.split(' ')[0])).toEqual([
      'Take',
      'Inhale',
      'Put',
      'Put',
      'Inject',
      'Use',
    ]);
    expect(verbs('hi').map((r) => r.replace(/^.*5 दिन तक /, ''))).toEqual([
      'लें।',
      'इनहेल करें।',
      'डालें।',
      'डालें।',
      'लगवाएँ।',
      'इस्तेमाल करें।',
    ]);
    expect(dosageRemarks(once({ dose: '2 drops', frequency: 'TDS' }, { route: 'ear' }), 'hi')).toBe(
      '2 बूँदें दिन में तीन बार, 5 दिन तक डालें।',
    );
  });

  it('stays within the remarks limit for the longest valid line', () => {
    const long = step({
      dose: '9'.repeat(3) + ' tablets ' + 'x'.repeat(48),
      frequency: 'f'.repeat(60),
      durationValue: 365,
      durationUnit: 'months',
    });
    for (const lang of ['en', 'hi'] as const) {
      const text = dosageRemarks(
        { steps: Array(6).fill(long), timing: 'empty_stomach', route: 'injection' },
        lang,
      );
      expect(text.length).toBeLessThanOrEqual(REMARKS_MAX);
    }
  });
});
