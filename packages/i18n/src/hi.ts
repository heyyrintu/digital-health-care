import type { MessageKey } from './en';

/** Hindi strings. Needs review by a native speaker before release. */
export const hi: Record<MessageKey, string> = {
  'app.patient.name': 'मरीज़',
  'app.clinic.name': 'क्लिनिक',
  'common.retry': 'फिर से कोशिश करें',
  'common.cancel': 'रद्द करें',
  'common.save': 'सहेजें',
  'common.loading': 'लोड हो रहा है…',
  'error.generic': 'कुछ गलत हो गया। कृपया फिर से कोशिश करें।',
  'error.offline': 'आप ऑफ़लाइन हैं। दोबारा कनेक्ट होने पर बदलाव सिंक हो जाएंगे।',
  'sync.waiting': 'सिंक होने की प्रतीक्षा',
  'booking.book': 'अपॉइंटमेंट बुक करें',
  'queue.token': 'टोकन {token}',
  'queue.nowServing': 'अभी बुलाया गया',
  'queue.next': 'अगला',
  'prescription.sign': 'हस्ताक्षर करें',
  'portal.welcome': 'स्वागत है, {name}',
};
