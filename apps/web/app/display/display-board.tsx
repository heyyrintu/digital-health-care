'use client';

import { ApiError, createApiClient } from '@dhc/api-client';
import { DisplayBoard } from '@dhc/contracts';
import { t as translate, type MessageKey } from '@dhc/i18n';
import { cn } from '@dhc/ui-web';
import { useEffect, useMemo, useState } from 'react';

/** How often the screen refreshes. */
const REFRESH_MS = 10_000;

/** Labels in English and Hindi together: a waiting room serves both. */
const both = (key: MessageKey) => `${translate('en', key)} · ${translate('hi', key)}`;

/** Dark theme on a TV: high contrast and readable from across the room. */
const screen = 'dark flex min-h-dvh flex-col bg-background p-4 text-foreground sm:p-8 lg:p-10';

type State =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'board'; board: DisplayBoard; offline: boolean };

/**
 * Kiosk view. The link (`/display#<token>`) stays in the address bar so the screen
 * survives a reload; the fragment is never sent to any server except as the API body.
 */
export function DisplayBoardView({ apiBaseUrl }: { apiBaseUrl: string }) {
  const api = useMemo(() => createApiClient({ baseUrl: apiBaseUrl }), [apiBaseUrl]);
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    const token = window.location.hash.replace(/^#/, '');
    if (token.length < 20) {
      setState({ kind: 'missing' });
      return;
    }
    let stopped = false;
    const refresh = () =>
      api
        .request('POST', '/display/board', { schema: DisplayBoard, body: { token } })
        .then((board) => !stopped && setState({ kind: 'board', board, offline: false }))
        .catch((e: unknown) => {
          if (stopped) return;
          if (e instanceof ApiError && e.status === 404) {
            stopped = true;
            setState({ kind: 'invalid' });
          } else {
            // Keep the last board up and say we are reconnecting.
            setState((s) => (s.kind === 'board' ? { ...s, offline: true } : s));
          }
        });
    void refresh();
    const timer = setInterval(() => !stopped && void refresh(), REFRESH_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [api]);

  if (state.kind === 'missing' || state.kind === 'invalid') {
    return (
      <main className={screen}>
        <div className="flex flex-1 items-center justify-center">
          <p
            className="surface max-w-3xl px-8 py-10 text-center font-display text-2xl font-bold sm:text-4xl"
            role="alert"
          >
            {both(state.kind === 'missing' ? 'display.missing' : 'display.invalid')}
          </p>
        </div>
      </main>
    );
  }
  if (state.kind === 'loading') {
    return (
      <main className={screen}>
        <div className="flex flex-1 items-center justify-center">
          <p aria-live="polite" className="text-2xl text-muted-foreground">
            {translate('en', 'common.loading')}
          </p>
        </div>
      </main>
    );
  }

  const { board, offline } = state;
  return (
    <main className={screen}>
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border pb-5">
        <h1 className="font-display text-3xl font-extrabold sm:text-5xl">{board.clinicName}</h1>
        {offline && (
          <p className="rounded-full bg-warning-soft px-5 py-2 text-lg font-semibold text-warning-foreground sm:text-xl">
            {both('display.offline')}
          </p>
        )}
      </header>
      {board.doctors.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-center font-display text-2xl font-bold text-muted-foreground sm:text-4xl">
            {both('display.none')}
          </p>
        </div>
      ) : (
        <div className="grid flex-1 content-start gap-6 pt-6 [grid-template-columns:repeat(auto-fit,minmax(min(100%,22rem),1fr))]">
          {board.doctors.map((d, i) => (
            <section
              key={i}
              className="surface flex flex-col p-6 sm:p-8"
              data-testid="display-doctor"
            >
              <h2 className="font-display text-2xl font-bold sm:text-3xl">
                {d.doctorName ?? translate('en', 'display.doctor')}
              </h2>
              <p className="mt-6 text-sm font-bold uppercase tracking-wide text-muted-foreground sm:text-base">
                {both('queue.nowServing')}
              </p>
              <p
                className={cn(
                  'my-2 font-display text-[7rem] font-extrabold leading-none text-primary tabular sm:text-[9rem]',
                  d.nowServing != null && 'token-pulse motion-reduce:animate-none',
                )}
                data-testid="now-serving"
              >
                {d.nowServing ?? '—'}
              </p>
              <p className="mt-4 border-t border-border pt-4 text-sm font-bold uppercase tracking-wide text-muted-foreground sm:text-base">
                {both('queue.next')}
              </p>
              <p
                className="mt-1 whitespace-pre-wrap font-display text-4xl font-bold tabular sm:text-5xl"
                data-testid="next-tokens"
              >
                {d.next.length > 0 ? d.next.join('  ') : '—'}
              </p>
            </section>
          ))}
        </div>
      )}
    </main>
  );
}
