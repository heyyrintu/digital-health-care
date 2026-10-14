/**
 * Something on a day's queue changed. Open queue screens already hear about it from the
 * database (the `notify_queue_change` trigger feeds `/queue/stream`, API guide §3o), so
 * this in-process hook is for tests and future consumers; by default it does nothing.
 */
export interface QueueChanged {
  type: 'queue.changed';
  organisationId: string;
  /** The appointment's day (IST), YYYY-MM-DD. */
  date: string;
  clinicId: string;
  doctorUserId: string;
  appointmentId?: string;
  reason: string;
}

export type QueuePublisher = (event: QueueChanged) => void;

let publisher: QueuePublisher = () => {};

/** Called after the change commits. */
export function publishQueueChanged(event: QueueChanged): void {
  try {
    publisher(event);
  } catch {
    // A live update is best-effort: the next refresh still shows the change.
  }
}

/** For the live-queue transport (and tests) to receive events. */
export function setQueuePublisher(next: QueuePublisher): void {
  publisher = next;
}
