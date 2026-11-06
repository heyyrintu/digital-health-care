import { setTimeout as delay } from 'node:timers/promises';

/** Retry only the trusted startup sample's transient timeout, never an uploaded PDF. */
export async function checkPdfStartup(
  check: () => Promise<string | null>,
  onRetry: (attempt: number) => void,
): Promise<string | null> {
  for (let attempt = 1; ; attempt++) {
    const problem = await check();
    if (problem !== 'not_a_document: timeout' || attempt === 3) return problem;
    onRetry(attempt);
    await delay(1000);
  }
}
