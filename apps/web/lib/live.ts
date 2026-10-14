/** Retry delays after a dropped stream, longest last. */
const RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
/** Changes often come in bursts (check-in, then vitals); one refetch covers them. */
const DEBOUNCE_MS = 300;

/**
 * Keeps a live stream open and calls `refresh` when it reports a change, once when it
 * (re)connects, and every `fallbackMs` as a safety net. Reconnects with a growing delay;
 * `onFatal` stops it for errors a retry cannot fix (signed out, revoked screen).
 * Returns a function that stops everything.
 */
export function keepLive({
  open,
  refresh,
  fallbackMs,
  onConnection,
  isFatal,
}: {
  open: (signal: AbortSignal, onEvent: (event: string) => void) => Promise<void>;
  refresh: () => void;
  fallbackMs: number;
  onConnection?: (connected: boolean) => void;
  isFatal?: (error: unknown) => boolean;
}): () => void {
  let stopped = false;
  let controller: AbortController | null = null;
  let attempt = 0;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const soon = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => !stopped && refresh(), DEBOUNCE_MS);
  };

  const connect = () => {
    if (stopped) return;
    controller = new AbortController();
    open(controller.signal, (event) => {
      if (event === 'ready') {
        attempt = 0;
        onConnection?.(true);
        soon();
      } else if (event === 'queue') {
        soon();
      }
    })
      .catch((error: unknown) => {
        if (stopped) return;
        if (isFatal?.(error)) {
          stop();
          return;
        }
      })
      .finally(() => {
        if (stopped) return;
        onConnection?.(false);
        const delay = RETRY_MS[Math.min(attempt++, RETRY_MS.length - 1)]!;
        retry = setTimeout(connect, delay);
      });
  };

  const safety = setInterval(() => !stopped && refresh(), fallbackMs);
  const stop = () => {
    stopped = true;
    clearInterval(safety);
    clearTimeout(debounce);
    clearTimeout(retry);
    controller?.abort();
  };
  connect();
  return stop;
}
