import { z } from 'zod';
import { Medicine, PrescriptionTemplate } from './prescriptions';
import { QueueResponse } from './queue';

/**
 * Read side of the Clinic app's offline mode (ADR 0009): what it caches so the day keeps
 * going when the network drops. Queued writes replay through the normal endpoints with
 * idempotency keys.
 */

export const SyncMedicinesQuery = z.object({
  /** From the previous response; leave out for a full download. */
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(500),
});
export type SyncMedicinesQuery = z.infer<typeof SyncMedicinesQuery>;

/** A medicine as cached on the device; inactive ones tell the device to drop it. */
export const SyncMedicine = Medicine.extend({
  active: z.boolean(),
  updatedAt: z.iso.datetime(),
});
export type SyncMedicine = z.infer<typeof SyncMedicine>;

export const SyncMedicinesResponse = z.object({
  /** Medicines changed since `cursor`, oldest change first. */
  data: z.array(SyncMedicine),
  /** Store this and send it next time. Unchanged when nothing changed. */
  cursor: z.string().nullable(),
  /** More changes are waiting: call again straight away with `cursor`. */
  hasMore: z.boolean(),
  /**
   * Every name the clinic admin linked to a medicine (approval queue), so offline search
   * finds the brand doctors type. Always the full list.
   */
  aliases: z.array(z.object({ name: z.string(), medicineId: z.uuid() })),
});
export type SyncMedicinesResponse = z.infer<typeof SyncMedicinesResponse>;

export const SyncTodayQuery = z.object({ clinicId: z.uuid().optional() });
export type SyncTodayQuery = z.infer<typeof SyncTodayQuery>;

/** Today's working set: the queue (a doctor's own, everyone's for other staff) and templates. */
export const SyncTodayResponse = z.object({
  /** Server clock, so the device can tell how stale its cache is. */
  serverTime: z.iso.datetime(),
  queue: QueueResponse,
  /** The doctor's own prescription templates; empty for other roles. */
  templates: z.array(PrescriptionTemplate),
});
export type SyncTodayResponse = z.infer<typeof SyncTodayResponse>;
