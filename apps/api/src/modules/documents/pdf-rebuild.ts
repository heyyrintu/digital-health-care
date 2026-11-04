import { Worker } from 'node:worker_threads';
import type { RewriteJob, RewriteLimits, RewriteOutcome } from './pdf-rebuild-worker';

/**
 * Runs the rebuild of an uploaded PDF (`pdf-rebuild-worker.ts`, threat model T27) in a worker
 * thread of its own, so a hostile file cannot stall or exhaust the API: pdf-lib parses
 * synchronously and keeps every object (and every distinct name, in a pool that lives as
 * long as the thread) in memory.
 *
 * - **Memory:** the worker's heap is capped (`resourceLimits`, 128 MB old and 16 MB young
 *   generation) and, because a process-wide `--max-old-space-size` (as in `NODE_OPTIONS`)
 *   silently overrides those, also watched from here every 20 ms and the worker ended past
 *   the same limit. Its stream decoders share one byte budget (`maxDecodedBytes`, buffers
 *   outside the heap). A file that needs more ends the worker, not the API. One worker adds
 *   up to about 350 MB to the process (heap, decoded data, the file and its copy), so by
 *   default one runs at a time (`PDF_REBUILD_CONCURRENCY`; runbook `docs/runbooks/deploy.md`).
 * - **Time:** the worker is terminated after `timeoutMs` of wall-clock time, and its slot is
 *   handed on only once it has exited.
 * - **Waiting:** at most `2 × concurrency` rebuilds wait for a slot, each for at most
 *   `queueWaitMs`, and one whose request has gone (its `signal` aborts) leaves the queue
 *   (or has its worker ended). An organisation has at most `perOrganisation` rebuilds running
 *   or waiting, so one clinic cannot fill the queue for every other. Beyond these the upload
 *   is answered `busy` (503, try again shortly).
 * - **Work:** at most `maxPages` pages.
 *
 * A fresh worker per file: nothing a file leaves behind reaches the next one. A timeout or an
 * out-of-memory end is the upload's fault (`not_a_document`); a worker that cannot start or
 * fails otherwise is ours (`unavailable`, logged as an error by the caller).
 */

export interface PdfRebuildLimits {
  /** Pages a PDF may have. */
  maxPages: number;
  /** Wall-clock time for one rebuild, from the worker's start. */
  timeoutMs: number;
  /** The worker's heap (`resourceLimits`). */
  maxOldGenerationSizeMb: number;
  maxYoungGenerationSizeMb: number;
  /** Bytes all stream decoders of one rebuild may produce, across filter stages. */
  maxDecodedBytes: number;
  /** Filters one stream may chain. */
  maxFilters: number;
  /** Largest rebuilt file kept. */
  maxOutputBytes: number;
  /** Rebuilds running at once in the process. */
  concurrency: number;
  /** Rebuilds waiting for a slot (beyond this: `busy`). */
  maxQueue: number;
  /** How long a rebuild waits for a slot before `busy`. */
  queueWaitMs: number;
  /** Rebuilds one organisation may have running or waiting. */
  perOrganisation: number;
}

/** Defaults; `concurrency` (and the queue with it) comes from `PDF_REBUILD_CONCURRENCY`. */
export function pdfRebuildLimits(concurrency = 1): PdfRebuildLimits {
  return {
    maxPages: 500,
    timeoutMs: 5_000,
    maxOldGenerationSizeMb: 128,
    maxYoungGenerationSizeMb: 16,
    maxDecodedBytes: 128 * 1024 * 1024,
    maxFilters: 4,
    maxOutputBytes: 25 * 1024 * 1024,
    concurrency,
    maxQueue: 2 * concurrency,
    queueWaitMs: 10_000,
    perOrganisation: 2,
  };
}

export const PDF_REBUILD_LIMITS: Readonly<PdfRebuildLimits> = pdfRebuildLimits();

/** What a rebuild gives: the worker's outcome, or why it did not run. */
export type RebuildOutcome =
  RewriteOutcome | { ok: false; reason: 'busy' | 'aborted'; detail: string };

/**
 * The worker's file: the TypeScript source beside this one when the API runs from source
 * (tsx, vitest), the bundled `pdf-rebuild-worker.js` beside the server in the build (an
 * entry of its own in `tsup.config.ts`).
 */
const fromSource = import.meta.url.endsWith('.ts');
const WORKER_URL = new URL(
  fromSource ? './pdf-rebuild-worker.ts' : './pdf-rebuild-worker.js',
  import.meta.url,
);
/** From source, Node strips the worker's types itself (the file uses only erasable syntax). */
const WORKER_EXEC_ARGV = fromSource
  ? ['--experimental-strip-types', '--disable-warning=ExperimentalWarning']
  : [];

/** How often a running worker's heap is checked against its limit. */
const HEAP_WATCH_MS = 20;

interface Waiter {
  grant(): void;
}

/** One per API process (`Services.pdf`): the queue and slots for PDF rebuilds (above). */
export class PdfRebuilder {
  private running = 0;
  private readonly queue: Waiter[] = [];
  private readonly perOrganisation = new Map<string, number>();
  /** Workers alive now, and the most ever alive at once (for tests and health). */
  private live = 0;
  peakWorkers = 0;

  constructor(
    readonly limits: PdfRebuildLimits = PDF_REBUILD_LIMITS,
    private readonly workerUrl: URL = WORKER_URL,
  ) {}

  /** Rebuilds running and waiting now. */
  get load() {
    return { running: this.running, queued: this.queue.length, workers: this.live };
  }

  /** Rebuilds a PDF (above): the new file, or why not. */
  async rebuild(
    data: Uint8Array,
    { organisationId, signal }: { organisationId?: string; signal?: AbortSignal } = {},
  ): Promise<RebuildOutcome> {
    if (signal?.aborted) return { ok: false, reason: 'aborted', detail: 'request closed' };
    if (organisationId) {
      const count = this.perOrganisation.get(organisationId) ?? 0;
      if (count >= this.limits.perOrganisation) {
        return { ok: false, reason: 'busy', detail: 'organisation has rebuilds in progress' };
      }
      this.perOrganisation.set(organisationId, count + 1);
    }
    try {
      const slot = await this.acquire(signal);
      if (slot !== 'ok') {
        return {
          ok: false,
          reason: slot,
          detail: slot === 'busy' ? 'queue full or wait over' : 'request closed',
        };
      }
      try {
        return await this.run(data, signal);
      } finally {
        this.release();
      }
    } finally {
      if (organisationId) {
        const count = (this.perOrganisation.get(organisationId) ?? 1) - 1;
        if (count > 0) this.perOrganisation.set(organisationId, count);
        else this.perOrganisation.delete(organisationId);
      }
    }
  }

  /**
   * Rebuilds a tiny synthetic PDF: null when the rebuild works, else why not (the worker file
   * is missing, or pdf-lib changed so its decoders can no longer be capped). Run at start-up.
   */
  async selfTest(sample: Uint8Array): Promise<string | null> {
    const outcome = await this.rebuild(sample);
    return outcome.ok ? null : `${outcome.reason}: ${outcome.detail}`;
  }

  private acquire(signal?: AbortSignal): Promise<'ok' | 'busy' | 'aborted'> {
    if (this.running < this.limits.concurrency && this.queue.length === 0) {
      this.running++;
      return Promise.resolve('ok');
    }
    if (this.queue.length >= this.limits.maxQueue) return Promise.resolve('busy');
    return new Promise((resolve) => {
      const leave = (result: 'ok' | 'busy' | 'aborted') => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const at = this.queue.indexOf(waiter);
        if (at >= 0) this.queue.splice(at, 1);
        resolve(result);
      };
      // The slot is handed over by `release`, already counted as running.
      const waiter: Waiter = { grant: () => leave('ok') };
      const timer = setTimeout(() => leave('busy'), this.limits.queueWaitMs);
      const onAbort = () => leave('aborted');
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(waiter);
    });
  }

  /** Hands the slot straight to the next waiter, so `running` never exceeds `concurrency`. */
  private release() {
    const next = this.queue.shift();
    if (next) next.grant();
    else this.running--;
  }

  /** Runs one worker; resolves once it has exited (so its memory is given back first). */
  private run(data: Uint8Array, signal?: AbortSignal): Promise<RebuildOutcome> {
    const { limits } = this;
    return new Promise((resolve) => {
      const job: RewriteJob = {
        task: 'rebuild-pdf',
        data,
        limits: {
          maxPages: limits.maxPages,
          maxDecodedBytes: limits.maxDecodedBytes,
          maxFilters: limits.maxFilters,
          maxOutputBytes: limits.maxOutputBytes,
        } satisfies RewriteLimits,
      };
      let outcome: RebuildOutcome | null = null;
      let worker: Worker;
      try {
        worker = new Worker(this.workerUrl, {
          workerData: job,
          execArgv: WORKER_EXEC_ARGV,
          resourceLimits: {
            maxOldGenerationSizeMb: limits.maxOldGenerationSizeMb,
            maxYoungGenerationSizeMb: limits.maxYoungGenerationSizeMb,
          },
          // The worker's output is not the server's log.
          stdout: true,
          stderr: true,
        });
      } catch (error) {
        resolve({ ok: false, reason: 'unavailable', detail: `worker: ${String(error)}` });
        return;
      }
      this.live++;
      this.peakWorkers = Math.max(this.peakWorkers, this.live);
      worker.stdout.resume();
      worker.stderr.resume();
      const finish = (result: RebuildOutcome) => {
        if (outcome) return;
        outcome = result;
        clearTimeout(timer);
        clearInterval(watch);
        signal?.removeEventListener('abort', onAbort);
        void worker.terminate();
      };
      const timer = setTimeout(
        () => finish({ ok: false, reason: 'not_a_document', detail: 'timeout' }),
        limits.timeoutMs,
      );
      const onAbort = () => finish({ ok: false, reason: 'aborted', detail: 'request closed' });
      // `resourceLimits` give way to a process-wide --max-old-space-size (NODE_OPTIONS), so the
      // heap is also watched from here, and the worker ended when it passes the same limit.
      const ceiling =
        (limits.maxOldGenerationSizeMb + limits.maxYoungGenerationSizeMb) * 1024 * 1024;
      const watch = setInterval(() => {
        worker.getHeapStatistics?.().then(
          (heap) => {
            if (heap.used_heap_size > ceiling) {
              finish({ ok: false, reason: 'not_a_document', detail: 'out of memory (watched)' });
            }
          },
          () => {},
        );
      }, HEAP_WATCH_MS);
      signal?.addEventListener('abort', onAbort, { once: true });
      worker.on('message', (result: RewriteOutcome) => finish(result));
      worker.on('error', (error: Error & { code?: string }) =>
        finish(
          error.code === 'ERR_WORKER_OUT_OF_MEMORY'
            ? { ok: false, reason: 'not_a_document', detail: 'out of memory' }
            : { ok: false, reason: 'unavailable', detail: `worker: ${String(error)}` },
        ),
      );
      worker.on('exit', (code) => {
        this.live--;
        finish({ ok: false, reason: 'unavailable', detail: `worker exited (${code})` });
        resolve(outcome!);
      });
    });
  }
}

/** Rebuilds one PDF with a rebuilder of its own (tests and tools; the API uses `Services.pdf`). */
export const rebuildPdf = (data: Uint8Array, limits: PdfRebuildLimits = PDF_REBUILD_LIMITS) =>
  new PdfRebuilder(limits).rebuild(data);
