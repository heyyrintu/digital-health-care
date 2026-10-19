import { Worker } from 'node:worker_threads';
import type { RewriteJob, RewriteOutcome } from './pdf-rebuild-worker';

/**
 * Runs the rebuild of an uploaded PDF (`pdf-rebuild-worker.ts`, threat model T27) in a worker
 * thread of its own, so a hostile file cannot stall or exhaust the API: pdf-lib parses
 * synchronously and keeps every object (and every distinct name, in a pool that lives as
 * long as the thread) in memory.
 *
 * - **Memory:** the worker's heap is capped (`resourceLimits`); a file that needs more ends
 *   the worker, not the API.
 * - **Time:** the worker is terminated after `timeoutMs` of wall-clock time.
 * - **Work:** at most `maxPages` pages, and at most `concurrency` rebuilds at a time across
 *   the process (others wait their turn; the time limit starts when a rebuild starts).
 *
 * A fresh worker per file: nothing a file leaves behind reaches the next one. Any failure
 * (timeout, out of memory, a crash) is a refusal, `not_a_document`.
 */

export interface PdfRebuildLimits {
  /** Pages a PDF may have. */
  maxPages: number;
  /** Wall-clock time for one rebuild, from the worker's start. */
  timeoutMs: number;
  /** The worker's heap (`resourceLimits`). */
  maxOldGenerationSizeMb: number;
  maxYoungGenerationSizeMb: number;
  /** Rebuilds running at once in the process. */
  concurrency: number;
}

export const PDF_REBUILD_LIMITS: Readonly<PdfRebuildLimits> = {
  maxPages: 500,
  timeoutMs: 5_000,
  maxOldGenerationSizeMb: 256,
  maxYoungGenerationSizeMb: 32,
  concurrency: 2,
};

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

let running = 0;
const waiting: (() => void)[] = [];

async function turn(concurrency: number) {
  if (running >= concurrency) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
}
function done() {
  running--;
  waiting.shift()?.();
}

/** Rebuilds a PDF in a worker (above): the new file, or why the upload is refused. */
export async function rebuildPdf(
  data: Uint8Array,
  limits: PdfRebuildLimits = PDF_REBUILD_LIMITS,
): Promise<RewriteOutcome> {
  await turn(limits.concurrency);
  try {
    return await new Promise<RewriteOutcome>((resolve) => {
      const job: RewriteJob = { task: 'rebuild-pdf', data, maxPages: limits.maxPages };
      const worker = new Worker(WORKER_URL, {
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
      worker.stdout.resume();
      worker.stderr.resume();
      let settled = false;
      const settle = (outcome: RewriteOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate();
        resolve(outcome);
      };
      const refuse = (detail: string) => settle({ ok: false, reason: 'not_a_document', detail });
      const timer = setTimeout(() => refuse('timeout'), limits.timeoutMs);
      worker.on('message', (outcome: RewriteOutcome) => settle(outcome));
      worker.on('error', (error) => refuse(`worker: ${String(error)}`));
      worker.on('exit', (code) => refuse(`worker exited (${code})`));
    });
  } finally {
    done();
  }
}
