'use client';

import type { PatientSummary, TagRef } from '@dhc/contracts';
import { ageFrom, istDateKey } from '@dhc/domain';
import type { CSSProperties } from 'react';
import { useSession } from './session-provider';

/** A coloured tag label. The colour is a border and dot, so text contrast never depends on it. */
export function TagChip({ tag }: { tag: Pick<TagRef, 'name' | 'colour'> }) {
  return (
    <span className="tag" style={{ '--tag': tag.colour } as CSSProperties}>
      {tag.name}
    </span>
  );
}

/** "34 y · Female", or "6 mo" for babies; parts that are unknown are left out. */
export function AgeGender({ patient }: { patient: Pick<PatientSummary, 'dob' | 'gender'> }) {
  const { t } = useSession();
  const parts: string[] = [];
  if (patient.dob) {
    const { years, months } = ageFrom(patient.dob, istDateKey(new Date()));
    parts.push(years > 0 ? t('patient.ageYears', { years }) : t('patient.ageMonths', { months }));
  }
  if (patient.gender) parts.push(t(`gender.${patient.gender}`));
  return <>{parts.length > 0 ? parts.join(' · ') : '—'}</>;
}
