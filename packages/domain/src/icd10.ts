/**
 * A starter list of ICD-10 (WHO) codes for diagnosis search: the orthopaedic pack's
 * favourites (PRD §6.2) and common conditions. `terms` holds everyday names doctors
 * type. The full code set comes from a licensed source later; free-text diagnoses are
 * always allowed.
 */
export interface Icd10Entry {
  code: string;
  label: string;
  terms?: string;
}

export const ICD10_STARTER: readonly Icd10Entry[] = [
  { code: 'M17.1', label: 'Primary osteoarthritis of knee', terms: 'knee oa gonarthrosis' },
  { code: 'M16.1', label: 'Primary osteoarthritis of hip', terms: 'hip oa coxarthrosis' },
  { code: 'M54.5', label: 'Low back pain', terms: 'lbp lumbago backache' },
  { code: 'M54.4', label: 'Lumbago with sciatica' },
  { code: 'M54.3', label: 'Sciatica' },
  { code: 'M54.2', label: 'Neck pain', terms: 'cervicalgia' },
  {
    code: 'M51.1',
    label: 'Lumbar disc disorder with radiculopathy',
    terms: 'pivd slipped disc prolapse',
  },
  { code: 'M75.0', label: 'Adhesive capsulitis of shoulder', terms: 'frozen shoulder' },
  { code: 'M75.1', label: 'Rotator cuff syndrome', terms: 'shoulder impingement' },
  { code: 'M77.1', label: 'Lateral epicondylitis', terms: 'tennis elbow' },
  { code: 'M72.2', label: 'Plantar fasciitis', terms: 'heel pain plantar fascial fibromatosis' },
  { code: 'M65.3', label: 'Trigger finger' },
  { code: 'G56.0', label: 'Carpal tunnel syndrome', terms: 'cts wrist numbness' },
  { code: 'M22.4', label: 'Chondromalacia patellae', terms: 'anterior knee pain' },
  { code: 'M23.2', label: 'Derangement of meniscus due to old tear', terms: 'meniscus knee' },
  { code: 'M25.5', label: 'Pain in joint', terms: 'arthralgia' },
  { code: 'M25.4', label: 'Effusion of joint', terms: 'swelling knee effusion' },
  { code: 'M79.1', label: 'Myalgia', terms: 'muscle pain' },
  { code: 'M81.0', label: 'Postmenopausal osteoporosis' },
  { code: 'M10.0', label: 'Idiopathic gout' },
  { code: 'M06.9', label: 'Rheumatoid arthritis, unspecified', terms: 'ra' },
  { code: 'S93.4', label: 'Sprain of ankle', terms: 'ankle twist ligament' },
  { code: 'S83.5', label: 'Sprain of cruciate ligament of knee', terms: 'acl pcl ligament injury' },
  { code: 'S83.2', label: 'Tear of meniscus, current injury', terms: 'meniscal tear knee' },
  { code: 'S63.5', label: 'Sprain of wrist' },
  { code: 'S43.4', label: 'Sprain of shoulder joint' },
  { code: 'S13.4', label: 'Sprain of cervical spine', terms: 'whiplash neck' },
  { code: 'S33.5', label: 'Sprain of lumbar spine', terms: 'back strain' },
  { code: 'S52.5', label: 'Fracture of lower end of radius', terms: 'colles wrist fracture' },
  { code: 'S82.6', label: 'Fracture of lateral malleolus', terms: 'ankle fracture' },
  { code: 'S42.0', label: 'Fracture of clavicle', terms: 'collarbone' },
  { code: 'S72.0', label: 'Fracture of neck of femur', terms: 'hip fracture nof' },
  { code: 'S62.6', label: 'Fracture of other finger' },
  { code: 'S92.3', label: 'Fracture of metatarsal bone', terms: 'foot fracture' },
  { code: 'I10', label: 'Essential hypertension', terms: 'high blood pressure htn bp' },
  {
    code: 'E11.9',
    label: 'Type 2 diabetes mellitus without complications',
    terms: 'dm t2dm sugar',
  },
  { code: 'E78.5', label: 'Hyperlipidaemia, unspecified', terms: 'cholesterol dyslipidaemia' },
  { code: 'E03.9', label: 'Hypothyroidism, unspecified', terms: 'thyroid' },
  { code: 'E55.9', label: 'Vitamin D deficiency' },
  { code: 'D64.9', label: 'Anaemia, unspecified', terms: 'anemia low haemoglobin' },
  { code: 'J45.9', label: 'Asthma, unspecified' },
  { code: 'N18.9', label: 'Chronic kidney disease, unspecified', terms: 'ckd renal failure' },
  { code: 'K76.0', label: 'Fatty liver', terms: 'nafld liver disease' },
  { code: 'K21.9', label: 'Gastro-oesophageal reflux disease', terms: 'gerd acidity' },
  { code: 'J06.9', label: 'Acute upper respiratory infection', terms: 'urti cold' },
  { code: 'R50.9', label: 'Fever, unspecified' },
];

const words = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9.]+/)
    .filter(Boolean);

/**
 * Entries whose code starts with the query, or whose label or terms contain every word
 * of it (as word prefixes). Code matches come first.
 */
export function searchIcd10(query: string, limit = 10): Icd10Entry[] {
  const q = words(query);
  if (q.length === 0) return [];
  const code = query.trim().toUpperCase();
  const byCode = ICD10_STARTER.filter((e) => e.code.startsWith(code));
  const byText = ICD10_STARTER.filter((e) => {
    if (byCode.includes(e)) return false;
    const hay = words(`${e.label} ${e.terms ?? ''}`);
    return q.every((w) => hay.some((h) => h.startsWith(w)));
  });
  return [...byCode, ...byText].slice(0, limit);
}
