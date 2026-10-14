/**
 * Something on a day's queue changed. Shape agreed for the live queue (server-sent
 * events); until that lands, screens refresh by polling and this is a no-op hook.
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
