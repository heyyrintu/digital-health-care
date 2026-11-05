import { z } from 'zod';
import { DocumentTitle, DocumentNote, DocumentMediaType } from './documents';
export const RecordCategory = z.enum(['prescription', 'lab', 'imaging', 'discharge', 'other']);
export const RecordDetails = z.object({ title: DocumentTitle, note: DocumentNote });
export const RecordMetadata = z
  .object({
    title: DocumentTitle,
    note: DocumentNote,
    category: RecordCategory,
    recordDate: z.iso.date().nullable(),
    appointmentId: z.uuid().nullable(),
    testOrderId: z.uuid().nullable(),
  })
  .strict();
export const CreatePatientRecord = RecordMetadata.extend({ id: z.uuid() }).strict();
export type CreatePatientRecord = z.infer<typeof CreatePatientRecord>;
export const UpdatePatientRecord = RecordMetadata.extend({
  revision: z.number().int().positive(),
}).strict();
export type UpdatePatientRecord = z.infer<typeof UpdatePatientRecord>;
export const PatientRecord = z.object({
  id: z.uuid(),
  patient: z.object({ id: z.uuid(), name: z.string() }),
  title: z.string().nullable(),
  note: z.string().nullable(),
  category: RecordCategory,
  recordDate: z.iso.date().nullable(),
  appointmentId: z.uuid().nullable(),
  testOrderId: z.uuid().nullable(),
  revision: z.number().int(),
  state: z.enum(['awaiting_upload', 'ready', 'deleting', 'deleted']),
  mediaType: DocumentMediaType.nullable(),
  sizeBytes: z.number().int().nullable(),
  createdAt: z.iso.datetime(),
  reviewedAt: z.iso.datetime().nullable(),
  reviewedByName: z.string().nullable(),
  usedAt: z.iso.datetime().nullable(),
  hiddenAt: z.iso.datetime().nullable(),
  canEdit: z.boolean(),
  canDelete: z.boolean(),
  canRestore: z.boolean(),
});
export type PatientRecord = z.infer<typeof PatientRecord>;
export const PatientRecordQuery = z.object({
  patientId: z.uuid().optional(),
  category: RecordCategory.optional(),
  hidden: z.enum(['true', 'false']).default('false'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.uuid().optional(),
});
export type PatientRecordQuery = z.infer<typeof PatientRecordQuery>;
export const PatientRecordList = z.object({
  data: z.array(PatientRecord),
  nextCursor: z.uuid().nullable(),
});
export const RecordOptions = z.object({
  maxUploadMb: z.number(),
  uploadTypes: z.array(z.enum(['pdf', 'jpeg', 'png', 'webp'])),
  doctors: z.array(z.object({ id: z.uuid(), name: z.string().nullable() })),
  appointments: z.array(z.object({ id: z.uuid(), date: z.iso.date() })),
  orders: z.array(z.object({ id: z.uuid(), name: z.string(), appointmentId: z.uuid() })),
});
export type RecordOptions = z.infer<typeof RecordOptions>;
export const CreateRecordShare = z
  .object({ id: z.uuid(), doctorUserId: z.uuid(), ttlHours: z.number().int().min(1).max(168) })
  .strict();
export type CreateRecordShare = z.infer<typeof CreateRecordShare>;
export const RecordShare = z.object({
  id: z.uuid(),
  doctorUserId: z.uuid(),
  doctorName: z.string().nullable(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
  url: z.string().nullable(),
});
export type RecordShare = z.infer<typeof RecordShare>;
export const RecordShareList = z.object({ data: z.array(RecordShare) });
export const ResolveRecordShare = z
  .object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
  .strict();
export const RecordRevision = z.object({ revision: z.number().int().positive() }).strict();
export const UsePatientRecord = RecordRevision.extend({ appointmentId: z.uuid() }).strict();
export const RecordPhotoPages = z
  .object({
    pages: z
      .array(
        z
          .object({
            mediaType: z.literal('image/jpeg'),
            data: z
              .string()
              .min(4)
              .max(2800000)
              .regex(/^[A-Za-z0-9+/]+={0,2}$/),
          })
          .strict(),
      )
      .min(2)
      .max(10),
  })
  .strict();
export type RecordPhotoPages = z.infer<typeof RecordPhotoPages>;

export const RecordRevoked = z.object({ revoked: z.literal(true) });
