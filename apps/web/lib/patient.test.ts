import { ApiError } from '@dhc/api-client';
import type {
  BookingOptions,
  ConsentStatus,
  PortalAppointment,
  PortalPatient,
} from '@dhc/contracts';
import { t as translate, type MessageKey } from '@dhc/i18n';
import { describe, expect, it } from 'vitest';
import {
  acceptBody,
  bookingDates,
  canBookOnline,
  cancelOption,
  checkChosenFile,
  clinicSlug,
  consentRequired,
  consentsToAccept,
  guardianChoices,
  isClinicSlug,
  isConsentUpdate,
  isIndianMobile,
  keepAttemptKey,
  newAttemptKey,
  nextAppointmentFor,
  patientDraftProblems,
  portalErrorMessage,
  portalNext,
  initialDoctor,
  preselectedDoctor,
  sessionEndReason,
  signedInDestination,
  slotTaken,
  UPLOAD_ACCEPT,
  uploadFailureText,
} from './patient';

const t = (key: MessageKey, params?: Record<string, string | number>) =>
  translate('en', key, params);

const apiError = (status: number, code: string, fields: Record<string, string> = {}) =>
  new ApiError(status, code as never, `API says ${code}`, 'r', fields);

const unreachable = apiError(503, 'INTERNAL', { api: 'unreachable' });

// Synthetic family from the test plan (docs/qa/test-plan.md §3).
const pooja: PortalPatient = {
  id: '3c0b6f2e-1d4a-4b7e-9f10-2a3b4c5d6e7f',
  uhid: 'E2E-000101',
  name: 'Pooja Singh',
  dob: '1992-03-14',
  gender: 'female',
  language: 'en',
  relation: 'account',
  guardianPatientId: null,
};
const aarav: PortalPatient = {
  ...pooja,
  id: '4d1c7a3f-2e5b-4c8f-8a21-3b4c5d6e7f80',
  name: 'Aarav Singh',
  dob: '2020-06-01',
  gender: 'male',
  relation: 'dependant',
  guardianPatientId: pooja.id,
};
const teen: PortalPatient = {
  ...pooja,
  id: '5e2d8b4a-3f6c-4d9a-9b32-4c5d6e7f8091',
  dob: '2012-01-01',
};

describe('portal errors and sessions', () => {
  it('shows the API’s own message, and translated ones for the network and server faults', () => {
    expect(portalErrorMessage(apiError(409, 'SLOT_TAKEN'), t)).toBe('API says SLOT_TAKEN');
    expect(portalErrorMessage(new TypeError('fetch failed'), t)).toBe(t('error.network'));
    expect(portalErrorMessage(unreachable, t)).toBe(t('error.network'));
    expect(portalErrorMessage(apiError(500, 'INTERNAL'), t)).toBe(t('error.generic'));
    expect(portalErrorMessage(new Error('x'), t)).toBe(t('error.generic'));
  });

  it('says why a session ended: none to restore, offline, or expired', () => {
    expect(sessionEndReason(apiError(401, 'UNAUTHENTICATED'))).toBeNull();
    expect(sessionEndReason(new TypeError('fetch failed'))).toBe('offline');
    expect(sessionEndReason(unreachable)).toBe('offline');
    expect(sessionEndReason(apiError(502, 'INTERNAL'))).toBe('expired');
    expect(sessionEndReason(apiError(403, 'FORBIDDEN'))).toBe('expired');
  });

  it('accepts the mobile numbers the API accepts', () => {
    for (const ok of ['9876543210', '98765 43210', '+91 98765 43210', '09876543210']) {
      expect(isIndianMobile(ok), ok).toBe(true);
    }
    for (const bad of ['5876543210', '987654321', '+1 98765 43210', 'abc']) {
      expect(isIndianMobile(bad), bad).toBe(false);
    }
  });

  it('reads the clinic ID as the API does', () => {
    expect(clinicSlug('  Demo-Clinic ')).toBe('demo-clinic');
    expect(isClinicSlug('Demo-Clinic')).toBe(true);
    expect(isClinicSlug('demo clinic')).toBe(false);
    expect(isClinicSlug('')).toBe(false);
  });
});

describe('consents', () => {
  const firstVisit: ConsentStatus = { consents: [], pending: ['health_data', 'privacy_notice'] };
  const newTerms: ConsentStatus = {
    consents: [
      { kind: 'terms', version: '2026-01', acceptedAt: '2026-01-02T00:00:00Z', withdrawnAt: null },
    ],
    pending: ['terms'],
  };

  it('lists what is pending in the screen’s order', () => {
    expect(consentsToAccept(firstVisit)).toEqual(['privacy_notice', 'health_data']);
  });

  it('tells a first visit from a new version of something already accepted', () => {
    expect(isConsentUpdate(firstVisit)).toBe(false);
    expect(isConsentUpdate(newTerms)).toBe(true);
  });

  it('accepts each document at the version in force', () => {
    expect(acceptBody(['privacy_notice', 'terms'])).toEqual([
      { kind: 'privacy_notice', version: '2026-10' },
      { kind: 'terms', version: '2026-10' },
    ]);
  });

  it('spots a consent withdrawn elsewhere', () => {
    expect(consentRequired(apiError(403, 'CONSENT_REQUIRED'))).toBe(true);
    expect(consentRequired(apiError(403, 'FORBIDDEN'))).toBe(false);
  });
});

describe('family', () => {
  const today = '2026-10-18';

  it('offers only adults on this number as guardians', () => {
    expect(guardianChoices([pooja, aarav, teen], today)).toEqual([pooja]);
    // No date of birth on file: the API decides.
    expect(guardianChoices([{ ...pooja, dob: null }], today)).toHaveLength(1);
  });

  it('checks the name, date of birth and gender before sending', () => {
    expect(
      patientDraftProblems({ name: ' ', dob: '2026-02-30', gender: null, guardianId: null }, today),
    ).toEqual({
      name: 'patient.profile.nameRequired',
      dob: 'patient.profile.dobInvalid',
      gender: 'portal.genderRequired',
    });
  });

  it('asks for a guardian for a child, and none for an adult', () => {
    const child = { name: 'Aarav Singh', dob: '2020-06-01', gender: 'male', guardianId: null };
    expect(patientDraftProblems(child, today)).toEqual({
      form: 'patient.family.childNeedsGuardian',
    });
    expect(patientDraftProblems({ ...child, guardianId: pooja.id }, today)).toEqual({});
    expect(patientDraftProblems({ ...child, dob: '1992-03-14' }, today)).toEqual({});
  });
});

describe('appointments', () => {
  const visit = (over: Partial<PortalAppointment>): PortalAppointment => ({
    id: '6f3e9c5b-4a7d-4e0b-8c43-5d6e7f8091a2',
    patient: { id: aarav.id, name: aarav.name, uhid: aarav.uhid },
    doctorName: 'Dr. Synthetic',
    clinicName: 'Main clinic',
    consultationTypeName: 'In-person consultation',
    mode: 'in_person',
    date: '2026-10-19',
    startAt: '2026-10-19T03:30:00.000Z',
    startTime: '09:00',
    tokenNumber: 1,
    status: 'confirmed',
    reason: null,
    canCancel: true,
    prescription: null,
    ...over,
  });

  it('finds the selected patient’s next visit', () => {
    const list = { upcoming: [visit({})], past: [] };
    expect(nextAppointmentFor(list, aarav.id)?.startTime).toBe('09:00');
    expect(nextAppointmentFor(list, pooja.id)).toBeUndefined();
  });

  it('offers cancel, a note to call, or nothing', () => {
    expect(cancelOption(visit({}))).toBe('cancel');
    expect(cancelOption(visit({ canCancel: false }))).toBe('call');
    expect(cancelOption(visit({ canCancel: false, status: 'pending' }))).toBe('call');
    expect(cancelOption(visit({ canCancel: false, status: 'checked_in' }))).toBeNull();
  });
});

describe('booking', () => {
  const options: BookingOptions = {
    doctors: [
      {
        userId: '7a4f0d6c-5b8e-4f1c-9d54-6e7f8091a2b3',
        displayName: 'Dr. Synthetic',
        publicSlug: 'dr-synthetic',
      },
      {
        userId: '1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b',
        displayName: 'Dr. Unlisted',
        publicSlug: null,
      },
    ],
    clinics: [{ id: '8b5a1e7d-6c9f-4a2d-8e65-7f8091a2b3c4', name: 'Main clinic', address: null }],
    consultationTypes: [
      {
        id: '9c6b2f8e-7d0a-4b3e-9f76-8091a2b3c4d5',
        name: 'In-person consultation',
        mode: 'in_person',
        defaultDurationMin: 20,
        feePaise: 80000,
      },
    ],
    horizonDays: 2,
    cancelCutoffMinutes: 120,
    maxActiveBookings: 3,
  };

  it('picks the doctor a public page links to, and nobody for an unknown address', () => {
    expect(preselectedDoctor(options, 'dr-synthetic')).toBe('7a4f0d6c-5b8e-4f1c-9d54-6e7f8091a2b3');
    expect(preselectedDoctor(options, 'dr-other')).toBeNull();
    expect(preselectedDoctor(options, null)).toBeNull();
    expect(preselectedDoctor(options, '')).toBeNull();
  });

  it('starts with the linked doctor, nobody for a link that matches no one, else the first', () => {
    expect(initialDoctor(options, 'dr-synthetic')).toEqual({
      doctorId: '7a4f0d6c-5b8e-4f1c-9d54-6e7f8091a2b3',
      unmatched: false,
    });
    expect(initialDoctor(options, 'dr-elsewhere')).toEqual({ doctorId: null, unmatched: true });
    expect(initialDoctor(options, null)).toEqual({
      doctorId: '7a4f0d6c-5b8e-4f1c-9d54-6e7f8091a2b3',
      unmatched: false,
    });
  });

  it('books online only when there is a doctor, a clinic and a consultation', () => {
    expect(canBookOnline(options)).toBe(true);
    expect(canBookOnline({ ...options, consultationTypes: [] })).toBe(false);
  });

  it('offers today and every day up to the horizon', () => {
    expect(bookingDates('2026-10-31', options)).toEqual(['2026-10-31', '2026-11-01', '2026-11-02']);
  });

  it('makes a new key per attempt', () => {
    expect(newAttemptKey()).toMatch(/^book-[0-9a-f-]{36}$/);
    expect(newAttemptKey()).not.toBe(newAttemptKey());
  });

  it('keeps the key when the booking may have happened, and renews it after a refusal', () => {
    expect(keepAttemptKey(new TypeError('fetch failed'))).toBe(true);
    expect(keepAttemptKey(apiError(409, 'CONFLICT', { idempotencyKey: 'in_progress' }))).toBe(true);
    expect(keepAttemptKey(apiError(409, 'CONFLICT', { idempotencyKey: 'unknown' }))).toBe(true);
    expect(keepAttemptKey(apiError(500, 'INTERNAL'))).toBe(true);
    expect(keepAttemptKey(apiError(409, 'SLOT_TAKEN'))).toBe(false);
    expect(keepAttemptKey(apiError(422, 'BOOKING_LIMIT'))).toBe(false);
  });

  it('reloads the day when the slot was taken meanwhile', () => {
    expect(slotTaken(apiError(409, 'SLOT_TAKEN'))).toBe(true);
    expect(slotTaken(apiError(422, 'BOOKING_LIMIT'))).toBe(false);
  });
});

describe('test results', () => {
  const file = (name: string, type: string, size = 120_000) => ({ name, type, size });

  it('offers PDFs and photos, as the Patient app does', () => {
    expect(UPLOAD_ACCEPT).toBe('application/pdf,image/*');
  });

  it('sends a PDF or a photo as its type, reading HEIC from the name when the browser gives none', () => {
    expect(checkChosenFile(file('report.pdf', 'application/pdf'), t)).toEqual({
      mediaType: 'application/pdf',
    });
    expect(checkChosenFile(file('IMG_0042.HEIC', ''), t)).toEqual({ mediaType: 'image/heic' });
    expect(checkChosenFile(file('scan.jpg', 'image/jpg'), t)).toEqual({ mediaType: 'image/jpeg' });
  });

  it('refuses another type, an empty file and one over 25 MB before sending', () => {
    expect(checkChosenFile(file('a.gif', 'image/gif'), t)).toEqual({
      text: 'Choose a PDF or a photo (JPEG, PNG, HEIC or HEIF).',
    });
    expect(checkChosenFile(file('a.pdf', 'application/pdf', 0), t)).toEqual({
      text: 'The file is empty.',
    });
    expect(checkChosenFile(file('a.pdf', 'application/pdf', 26 * 1024 * 1024), t)).toEqual({
      text: 'The file is larger than 25 MB. Choose a smaller file.',
    });
  });

  it('words each upload refusal, in English and Hindi', () => {
    const hi = (key: MessageKey, params?: Record<string, string | number>) =>
      translate('hi', key, params);
    const full = apiError(409, 'CONFLICT', { file: 'too_many' });
    const reviewed = apiError(409, 'CONFLICT', { status: 'reviewed' });
    const unsupported = apiError(415, 'VALIDATION_FAILED', { file: 'type_not_allowed' });
    const huge = apiError(413, 'VALIDATION_FAILED');
    expect(uploadFailureText(full, t)).toBe(
      'This test already has 10 results. Combine the pages into one file.',
    );
    expect(uploadFailureText(reviewed, t)).toBe(
      'The doctor has reviewed this test. A new result needs a new order.',
    );
    expect(uploadFailureText(unsupported, t)).toBe(
      'Choose a PDF or a photo (JPEG, PNG, HEIC or HEIF).',
    );
    expect(uploadFailureText(huge, t)).toBe(
      'The file is larger than 25 MB. Choose a smaller file.',
    );
    for (const e of [full, reviewed, unsupported, huge]) {
      expect(uploadFailureText(e, hi)).not.toBe(uploadFailureText(e, t));
      expect(uploadFailureText(e, hi)).not.toMatch(/\{\w+\}/);
    }
  });

  it('falls back to the usual wording for anything else', () => {
    expect(uploadFailureText(new TypeError('fetch failed'), t)).toBe(t('error.network'));
    expect(uploadFailureText(apiError(404, 'NOT_FOUND'), t)).toBe('API says NOT_FOUND');
  });
});

describe('portalNext', () => {
  it.each([
    ['/app/book?doctor=dr-synthetic', '/app/book?doctor=dr-synthetic'],
    ['/app', '/app'],
    ['/app/appointments', '/app/appointments'],
  ])('follows %s', (next, expected) => {
    expect(portalNext(next)).toBe(expected);
  });

  it.each([
    null,
    '',
    'https://evil.test/app',
    '//evil.test/app',
    '/\\evil.test/app',
    '/clinic',
    '/apple',
    '/app/login?next=/app',
    'app/book',
    '/app/../clinic',
  ])('goes home instead of %s', (next) => {
    expect(portalNext(next)).toBe('/app');
  });
});

describe('signedInDestination', () => {
  it('goes on when the link names this clinic or none', () => {
    expect(signedInDestination('clinic-a', 'clinic-a', '/app/book?doctor=dr-x')).toEqual({
      go: '/app/book?doctor=dr-x',
    });
    expect(signedInDestination('clinic-a', ' Clinic-A ', null)).toEqual({ go: '/app' });
    expect(signedInDestination('clinic-a', null, '/app/tests')).toEqual({ go: '/app/tests' });
  });

  it('stops when the link names another clinic', () => {
    expect(signedInDestination('clinic-a', 'clinic-b', '/app/book?doctor=dr-x')).toEqual({
      otherClinic: 'clinic-b',
    });
  });
});
