'use client';

import { ApiError, createApiClient } from '@dhc/api-client';
import { DisplayBoard } from '@dhc/contracts';
import { t as translate, type MessageKey } from '@dhc/i18n';
import { useEffect, useMemo, useState } from 'react';

/** How often the screen refreshes. */
const REFRESH_MS = 10_000;

/** Labels in English and Hindi together: a waiting room serves both. */
const both = (key: MessageKey) => `${translate('en', key)} · ${translate('hi', key)}`;

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
      <main className="display">
        <p className="display-message" role="alert">
          {both(state.kind === 'missing' ? 'display.missing' : 'display.invalid')}
        </p>
      </main>
    );
  }
  if (state.kind === 'loading') {
    return (
      <main className="display">
        <p aria-live="polite">{translate('en', 'common.loading')}</p>
      </main>
    );
  }

  const { board, offline } = state;
  return (
    <main className="display board">
      <header>
        <h1>{board.clinicName}</h1>
        {offline && <p className="display-offline">{both('display.offline')}</p>}
      </header>
      {board.doctors.length === 0 ? (
        <p className="display-message">{both('display.none')}</p>
      ) : (
        <div className="display-doctors">
          {board.doctors.map((d, i) => (
            <section key={i} className="display-doctor" data-testid="display-doctor">
              <h2>{d.doctorName ?? translate('en', 'display.doctor')}</h2>
              <p className="label">{both('queue.nowServing')}</p>
              <p className="token" data-testid="now-serving">
                {d.nowServing ?? '—'}
              </p>
              <p className="label">{both('queue.next')}</p>
              <p className="next" data-testid="next-tokens">
                {d.next.length > 0 ? d.next.join('  ') : '—'}
              </p>
            </section>
          ))}
        </div>
      )}
    </main>
  );
}
