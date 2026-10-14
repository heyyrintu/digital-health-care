import { describe, expect, it } from 'vitest';
import { appointmentActions } from './appointment-actions';

const doctor = { role: 'doctor', userId: 'd1' };
const desk = { role: 'front_desk', userId: 'f1' };
const now = new Date('2026-10-06T05:00:00Z');
const appt = (status: string, extra = {}) => ({
  status,
  doctorUserId: 'd1',
  date: '2026-10-06',
  startAt: '2026-10-06T04:30:00Z',
  ...extra,
});

describe('appointmentActions', () => {
  it('offers check-in and no-show for today’s booking once its slot has started', () => {
    expect(appointmentActions(appt('confirmed'), desk, '2026-10-06', now)).toEqual([
      'check_in',
      'no_show',
      'cancel',
    ]);
    expect(
      appointmentActions(
        appt('confirmed', { startAt: '2026-10-06T06:00:00Z' }),
        desk,
        '2026-10-06',
        now,
      ),
    ).toEqual(['check_in', 'cancel']);
    expect(
      appointmentActions(appt('confirmed', { date: '2026-10-07' }), desk, '2026-10-06', now),
    ).not.toContain('check_in');
  });

  it('leaves the consultation to the patient’s own doctor', () => {
    expect(appointmentActions(appt('checked_in'), doctor, '2026-10-06', now)).toEqual([
      'start',
      'cancel',
    ]);
    expect(appointmentActions(appt('checked_in'), desk, '2026-10-06', now)).toEqual(['cancel']);
    expect(
      appointmentActions(
        appt('in_consultation'),
        { role: 'doctor', userId: 'd2' },
        '2026-10-06',
        now,
      ),
    ).toEqual([]);
  });
});
