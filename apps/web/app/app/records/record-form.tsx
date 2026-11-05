'use client';
import { RecordCategory, type PatientRecord, type RecordOptions } from '@dhc/contracts';
import { Field, Input, NativeSelect, Textarea } from '@dhc/ui-web';
import { usePatientSession } from '../session-provider';
export function RecordMetadataForm({
  options,
  record,
}: {
  options: RecordOptions | null;
  record?: PatientRecord;
}) {
  const { t } = usePatientSession();
  return (
    <div className="space-y-3">
      <Field label={t('patientRecords.name')}>
        <Input name="title" required maxLength={110} defaultValue={record?.title ?? ''} />
      </Field>
      <Field label={t('patientRecords.category')}>
        <NativeSelect name="category" defaultValue={record?.category ?? 'other'}>
          {RecordCategory.options.map((c) => (
            <option key={c} value={c}>
              {t(`patientRecords.category.${c}`)}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field label={t('patientRecords.date')}>
        <Input type="date" name="recordDate" defaultValue={record?.recordDate ?? ''} />
      </Field>
      <Field label={t('patientRecords.note')}>
        <Textarea name="note" maxLength={500} defaultValue={record?.note ?? ''} />
      </Field>
      <Field label={t('patientRecords.appointment')}>
        <NativeSelect name="appointmentId" defaultValue={record?.appointmentId ?? ''}>
          <option value="">{t('patientRecords.noneSelected')}</option>
          {options?.appointments.map((a) => (
            <option key={a.id} value={a.id}>
              {a.date} · {a.id.slice(0, 8)}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field label={t('patientRecords.order')}>
        <NativeSelect name="testOrderId" defaultValue={record?.testOrderId ?? ''}>
          <option value="">{t('patientRecords.noneSelected')}</option>
          {options?.orders.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <p className="text-xs text-muted-foreground">{t('patientRecords.orderHelp')}</p>
    </div>
  );
}
