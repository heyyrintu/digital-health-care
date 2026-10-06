export const en = {
  'app.patient.name': 'Patient',
  'app.clinic.name': 'Clinic',
  'common.retry': 'Try again',
  'common.cancel': 'Cancel',
  'common.save': 'Save',
  'common.loading': 'Loading…',
  'error.generic': 'Something went wrong. Please try again.',
  'error.offline': 'You are offline. Changes will sync when you reconnect.',
  'sync.waiting': 'Waiting to sync',
  'booking.book': 'Book appointment',
  'queue.token': 'Token {token}',
  'queue.nowServing': 'Now serving',
  'queue.next': 'Next',
  'prescription.sign': 'Sign',
  'portal.welcome': 'Welcome, {name}',
} as const;

export type MessageKey = keyof typeof en;
