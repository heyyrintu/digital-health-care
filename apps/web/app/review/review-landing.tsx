'use client';
import { createApiClient } from '@dhc/api-client';
import { ReviewLanding, ReviewDestination } from '@dhc/contracts';
import { Button, Surface } from '@dhc/ui-web';
import { useEffect, useMemo, useState } from 'react';
export function ReviewLandingPage({ apiBaseUrl }: { apiBaseUrl: string }) {
  const api = useMemo(() => createApiClient({ baseUrl: apiBaseUrl }), [apiBaseUrl]);
  const [name, setName] = useState(''),
    [token, setToken] = useState(''),
    [error, setError] = useState(false),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const value = window.location.hash.slice(1);
    setToken(value);
    api
      .request('POST', '/review-links/resolve', { schema: ReviewLanding, body: { token: value } })
      .then((r) => setName(r.clinicName))
      .catch(() => setError(true));
  }, [api]);
  async function open() {
    setBusy(true);
    try {
      const r = await api.request('POST', '/review-links/open', {
        schema: ReviewDestination,
        body: { token },
      });
      window.location.assign(r.url);
    } catch {
      setError(true);
      setBusy(false);
    }
  }
  return (
    <main className="mx-auto grid min-h-dvh max-w-xl content-center gap-4 p-5">
      <Surface className="space-y-5 p-6">
        <h1 className="text-2xl font-bold">Optional clinic review</h1>
        <p lang="hi">क्लिनिक की वैकल्पिक समीक्षा</p>
        {error ? (
          <p role="alert">
            This invitation is unavailable or expired. / यह आमंत्रण उपलब्ध नहीं है या समाप्त हो गया
            है।
          </p>
        ) : !name ? (
          <p>Loading…</p>
        ) : (
          <>
            <h2 className="text-xl font-bold">{name}</h2>
            <p>
              You may share an honest review on Google. Any rating is welcome. Reviewing is optional
              and does not affect your care. Avoid including private medical details.
            </p>
            <p lang="hi">
              Google पर अपनी ईमानदार समीक्षा दे सकते हैं। हर रेटिंग का स्वागत है। समीक्षा वैकल्पिक
              है और इससे आपके इलाज पर असर नहीं पड़ता। निजी चिकित्सा विवरण साझा न करें।
            </p>
            <p>
              Continuing opens Google and records that this invitation was opened. No review text or
              rating is collected here.
            </p>
            <Button disabled={busy} onClick={() => void open()}>
              Continue to Google / Google पर जाएँ
            </Button>
          </>
        )}
      </Surface>
    </main>
  );
}
