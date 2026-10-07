/**
 * Slot engine (PRD §4.3, §5.5). Pure: turns a doctor's weekly schedule versions and
 * exceptions into the bookable slots of one day. Clinic times are IST wall-clock
 * (`HH:MM`); India has no daylight saving, so IST is always UTC+05:30.
 */

export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** A block of consulting time, e.g. 10:00–13:00. Breaks are the gaps between sessions. */
export interface Session {
  start: string;
  end: string;
}

export type WeeklySchedule = Partial<Record<Weekday, Session[]>>;

export interface ScheduleVersion {
  /** `YYYY-MM-DD`: applies from this day until a later version takes over. */
  effectiveFrom: string;
  weekly: WeeklySchedule;
  slotMinutes: number;
  bufferMinutes: number;
}

export type ExceptionType = 'leave' | 'holiday' | 'extra_session';

export interface ScheduleException {
  type: ExceptionType;
  startDate: string;
  endDate: string;
  /** Leave or holiday for part of a day, or the hours of an extra session. */
  startTime?: string | null;
  endTime?: string | null;
}

export interface BookingWindow {
  /** Patients may book this many days ahead (PRD default 30). */
  horizonDays: number;
  /** Same-day bookings close this long before the slot (PRD default 60). */
  sameDayCutoffMinutes: number;
}

/** `staff` books on a patient's behalf and ignores the horizon and cutoff (not the past). */
export type Channel = 'patient' | 'staff';

export type SlotUnavailable = 'past' | 'cutoff' | 'busy';

export interface Slot {
  /** ISO instants (UTC). */
  start: string;
  end: string;
  /** IST wall-clock, for display. */
  startTime: string;
  endTime: string;
  available: boolean;
  unavailableReason?: SlotUnavailable;
}

export type DayClosed = 'past' | 'beyond_horizon' | 'no_schedule' | 'leave' | 'holiday';

export interface DaySlots {
  date: string;
  slots: Slot[];
  /** Why the day has no slots at all, when it has none. */
  closed?: DayClosed;
}

export interface Interval {
  start: Date;
  end: Date;
}

const IST_OFFSET_MINUTES = 330;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Minutes since midnight for `HH:MM`. */
export function minutesOf(time: string): number {
  const match = TIME.exec(time);
  if (!match) throw new Error(`Invalid time ${time}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

const timeOf = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

function parseDate(date: string): [number, number, number] {
  if (!DATE.test(date)) throw new Error(`Invalid date ${date}`);
  return date.split('-').map(Number) as [number, number, number];
}

/** The UTC instant of an IST wall-clock time on a date. */
export function istInstant(date: string, minutes: number): Date {
  const [y, m, d] = parseDate(date);
  return new Date(Date.UTC(y, m - 1, d, 0, minutes) - IST_OFFSET_MINUTES * 60_000);
}

export function weekdayOf(date: string): Weekday {
  const [y, m, d] = parseDate(date);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]!;
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = parseDate(date);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** IST calendar date of an instant. */
export function istDate(instant: Date): string {
  return new Date(instant.getTime() + IST_OFFSET_MINUTES * 60_000).toISOString().slice(0, 10);
}

/**
 * Problems with a weekly schedule, as `{ path: message }` (empty when valid): times must
 * be `HH:MM`, each session must end after it starts and fit at least one slot, and a
 * day's sessions must not overlap.
 */
export function validateWeekly(
  weekly: WeeklySchedule,
  slotMinutes: number,
): Record<string, string> {
  const problems: Record<string, string> = {};
  for (const day of WEEKDAYS) {
    const sessions = weekly[day] ?? [];
    const ranges: [number, number][] = [];
    sessions.forEach((s, i) => {
      const path = `weekly.${day}.${i}`;
      if (!TIME.test(s.start) || !TIME.test(s.end)) {
        problems[path] = 'Use HH:MM times.';
        return;
      }
      const start = minutesOf(s.start);
      const end = minutesOf(s.end);
      if (end - start < slotMinutes) {
        problems[path] = 'A session must end after it starts and fit at least one slot.';
        return;
      }
      ranges.push([start, end]);
    });
    ranges.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < ranges.length; i++) {
      if (ranges[i]![0] < ranges[i - 1]![1]) problems[`weekly.${day}`] = 'Sessions overlap.';
    }
  }
  return problems;
}

/** The version in force on a date: the latest one effective on or before it. */
export function versionOn<V extends ScheduleVersion>(versions: V[], date: string): V | undefined {
  return versions
    .filter((v) => v.effectiveFrom <= date)
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0];
}

const covers = (e: ScheduleException, date: string) => e.startDate <= date && date <= e.endDate;

/** Slots of a session: back to back, each followed by the buffer, none overrunning the end. */
function sessionSlots(
  start: number,
  end: number,
  slot: number,
  buffer: number,
): [number, number][] {
  const out: [number, number][] = [];
  for (let t = start; t + slot <= end; t += slot + buffer) out.push([t, t + slot]);
  return out;
}

export interface SlotsForDayInput {
  date: string;
  versions: ScheduleVersion[];
  exceptions: ScheduleException[];
  window: BookingWindow;
  now: Date;
  channel: Channel;
  /** Already taken (appointments, holds). Overlapping slots are marked busy. */
  busy?: Interval[];
  /** Slot length for an extra session on a day no version covers. */
  defaultSlotMinutes?: number;
}

export function slotsForDay(input: SlotsForDayInput): DaySlots {
  const { date, versions, exceptions, window, now, channel, busy = [] } = input;
  const today = istDate(now);
  const day = (closed: DayClosed): DaySlots => ({ date, slots: [], closed });

  if (date < today) return day('past');
  if (channel === 'patient' && date > addDays(today, window.horizonDays)) {
    return day('beyond_horizon');
  }

  const todays = exceptions.filter((e) => covers(e, date));
  const wholeDay = (type: ExceptionType) =>
    todays.some((e) => e.type === type && !(e.startTime && e.endTime));
  if (wholeDay('holiday')) return day('holiday');
  if (wholeDay('leave')) return day('leave');

  const version = versionOn(versions, date);
  const slotMinutes = version?.slotMinutes ?? input.defaultSlotMinutes ?? 15;
  const bufferMinutes = version?.bufferMinutes ?? 0;

  const ranges: [number, number][] = [];
  for (const s of version?.weekly[weekdayOf(date)] ?? []) {
    ranges.push(...sessionSlots(minutesOf(s.start), minutesOf(s.end), slotMinutes, bufferMinutes));
  }
  for (const e of todays) {
    if (e.type === 'extra_session' && e.startTime && e.endTime) {
      ranges.push(
        ...sessionSlots(minutesOf(e.startTime), minutesOf(e.endTime), slotMinutes, bufferMinutes),
      );
    }
  }

  // Part-day leave and holidays remove the slots they overlap.
  const blocked = todays
    .filter((e) => e.type !== 'extra_session' && e.startTime && e.endTime)
    .map((e) => [minutesOf(e.startTime!), minutesOf(e.endTime!)] as const);
  const open = ranges.filter(([s, e]) => !blocked.some(([bs, be]) => s < be && bs < e));

  // An extra session may repeat a regular slot; keep one of each start time.
  const unique = [...new Map(open.map((r) => [r[0], r])).values()].sort((a, b) => a[0] - b[0]);
  if (unique.length === 0) return day(ranges.length > 0 ? 'leave' : 'no_schedule');

  const cutoff = new Date(now.getTime() + window.sameDayCutoffMinutes * 60_000);
  const slots = unique.map(([s, e]): Slot => {
    const start = istInstant(date, s);
    const end = istInstant(date, e);
    let unavailableReason: SlotUnavailable | undefined;
    if (start < now) unavailableReason = 'past';
    else if (channel === 'patient' && start < cutoff) unavailableReason = 'cutoff';
    else if (busy.some((b) => start < b.end && b.start < end)) unavailableReason = 'busy';
    return {
      start: start.toISOString(),
      end: end.toISOString(),
      startTime: timeOf(s),
      endTime: timeOf(e),
      available: !unavailableReason,
      ...(unavailableReason ? { unavailableReason } : {}),
    };
  });
  return { date, slots };
}
