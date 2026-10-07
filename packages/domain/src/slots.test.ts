import { describe, expect, it } from 'vitest';
import {
  addDays,
  istDate,
  slotsForDay,
  validateWeekly,
  versionOn,
  weekdayOf,
  type ScheduleVersion,
  type SlotsForDayInput,
} from './slots';

// Wednesday 7 Oct 2026, 09:00 IST.
const NOW = new Date('2026-10-07T03:30:00Z');
const TODAY = '2026-10-07';

const v1: ScheduleVersion = {
  effectiveFrom: '2026-10-01',
  weekly: {
    mon: [{ start: '10:00', end: '11:00' }],
    wed: [
      { start: '10:00', end: '11:00' },
      { start: '17:00', end: '17:30' },
    ],
  },
  slotMinutes: 15,
  bufferMinutes: 0,
};

const base = (over: Partial<SlotsForDayInput> = {}): SlotsForDayInput => ({
  date: TODAY,
  versions: [v1],
  exceptions: [],
  window: { horizonDays: 30, sameDayCutoffMinutes: 60 },
  now: NOW,
  channel: 'staff',
  ...over,
});

const times = (input: SlotsForDayInput) => slotsForDay(input).slots.map((s) => s.startTime);

describe('calendar helpers', () => {
  it('works in IST dates and weekdays', () => {
    expect(weekdayOf('2026-10-07')).toBe('wed');
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    // 20:00 UTC is 01:30 the next day in IST.
    expect(istDate(new Date('2026-10-06T20:00:00Z'))).toBe('2026-10-07');
  });
});

describe('slotsForDay', () => {
  it('splits each session into slots, with breaks between sessions', () => {
    expect(times(base())).toEqual(['10:00', '10:15', '10:30', '10:45', '17:00', '17:15']);
    const [first] = slotsForDay(base()).slots;
    // 10:00 IST is 04:30 UTC.
    expect(first).toMatchObject({ start: '2026-10-07T04:30:00.000Z', endTime: '10:15' });
  });

  it('leaves a buffer after each slot and never overruns the session', () => {
    const v = { ...v1, slotMinutes: 20, bufferMinutes: 5 };
    expect(times(base({ versions: [v] }))).toEqual(['10:00', '10:25', '17:00']);
  });

  it('uses the version in force on the day, so later changes never disturb earlier days', () => {
    const v2: ScheduleVersion = { ...v1, effectiveFrom: '2026-10-14', slotMinutes: 30 };
    expect(versionOn([v1, v2], '2026-10-13')).toBe(v1);
    expect(versionOn([v1, v2], '2026-10-14')).toBe(v2);
    expect(times(base({ versions: [v1, v2], date: '2026-10-14' }))).toEqual([
      '10:00',
      '10:30',
      '17:00',
    ]);
    expect(slotsForDay(base({ versions: [v2], date: '2026-10-07' })).closed).toBe('no_schedule');
  });

  it('closes a whole day for leave or a holiday, and part of a day for part-day leave', () => {
    const leave = { type: 'leave' as const, startDate: '2026-10-05', endDate: '2026-10-09' };
    expect(slotsForDay(base({ exceptions: [leave] })).closed).toBe('leave');
    const holiday = { type: 'holiday' as const, startDate: TODAY, endDate: TODAY };
    expect(slotsForDay(base({ exceptions: [holiday] })).closed).toBe('holiday');

    const morningOff = { ...leave, startTime: '10:20', endTime: '11:00' };
    expect(times(base({ exceptions: [morningOff] }))).toEqual(['10:00', '17:00', '17:15']);
  });

  it('adds slots for an extra session, once each', () => {
    const extra = {
      type: 'extra_session' as const,
      startDate: TODAY,
      endDate: TODAY,
      startTime: '17:15',
      endTime: '18:00',
    };
    expect(times(base({ exceptions: [extra] }))).toEqual([
      '10:00',
      '10:15',
      '10:30',
      '10:45',
      '17:00',
      '17:15',
      '17:30',
      '17:45',
    ]);
    // An extra session on a day with no schedule uses the default slot length.
    const thursday = { ...extra, startDate: '2026-10-08', endDate: '2026-10-08' };
    expect(
      times(base({ date: '2026-10-08', exceptions: [thursday], defaultSlotMinutes: 15 })),
    ).toEqual(['17:15', '17:30', '17:45']);
  });

  it('marks past slots, the same-day cutoff for patients, and busy slots', () => {
    const at1005 = new Date('2026-10-07T04:35:00Z');
    const staff = slotsForDay(base({ now: at1005 })).slots;
    expect(staff.find((s) => s.startTime === '10:00')).toMatchObject({
      available: false,
      unavailableReason: 'past',
    });
    expect(staff.find((s) => s.startTime === '10:15')?.available).toBe(true);

    const patient = slotsForDay(base({ now: at1005, channel: 'patient' })).slots;
    // Within 60 minutes of 10:05: 10:15 to 10:45 close for patients.
    expect(patient.filter((s) => s.unavailableReason === 'cutoff').map((s) => s.startTime)).toEqual(
      ['10:15', '10:30', '10:45'],
    );
    expect(patient.find((s) => s.startTime === '17:00')?.available).toBe(true);

    const busy = [
      { start: new Date('2026-10-07T11:30:00Z'), end: new Date('2026-10-07T11:45:00Z') },
    ];
    const withBooking = slotsForDay(base({ busy })).slots;
    expect(withBooking.find((s) => s.startTime === '17:00')?.unavailableReason).toBe('busy');
  });

  it('limits patients to the booking horizon; staff can look further ahead', () => {
    const far = '2026-11-09'; // a Monday, 33 days out
    expect(slotsForDay(base({ date: far, channel: 'patient' })).closed).toBe('beyond_horizon');
    expect(times(base({ date: far }))).toHaveLength(4);
    expect(slotsForDay(base({ date: '2026-10-06' })).closed).toBe('past');
  });
});

describe('validateWeekly', () => {
  it('accepts a valid schedule', () => {
    expect(validateWeekly(v1.weekly, 15)).toEqual({});
  });

  it('reports bad times, sessions too short for a slot, and overlaps', () => {
    expect(
      validateWeekly(
        {
          mon: [{ start: '9:00', end: '10:00' }],
          tue: [{ start: '10:00', end: '10:10' }],
          wed: [
            { start: '10:00', end: '12:00' },
            { start: '11:00', end: '13:00' },
          ],
        },
        15,
      ),
    ).toEqual({
      'weekly.mon.0': 'Use HH:MM times.',
      'weekly.tue.0': 'A session must end after it starts and fit at least one slot.',
      'weekly.wed': 'Sessions overlap.',
    });
  });
});
