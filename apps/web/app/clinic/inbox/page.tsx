'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ApiError } from '@dhc/api-client';
import {
  InboxList,
  InboxMessages,
  InboxMessage,
  InboxThread,
  InboxTemplates,
  InboxDoctors,
  type InboxThread as Thread,
} from '@dhc/contracts';
import { Button, Textarea, NativeSelect, Field } from '@dhc/ui-web';
import type { MessageKey } from '@dhc/i18n';
import { useSession } from '../session-provider';
import { ClinicShell, NotAllowed } from '../shell';
export default function Page() {
  return (
    <ClinicShell>
      {(me) =>
        ['doctor', 'front_desk', 'clinic_admin'].includes(me.role) ? <Inbox /> : <NotAllowed />
      }
    </ClinicShell>
  );
}
function Inbox() {
  const { api, t, me } = useSession();
  const [threads, setThreads] = useState<Thread[]>([]),
    [available, setAvailable] = useState(false),
    [cursor, setCursor] = useState<string | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [selected, setSelected] = useState<string | null>(null),
    [view, setView] = useState<ReturnType<typeof InboxMessages.parse> | null>(null),
    [templates, setTemplates] = useState<ReturnType<typeof InboxTemplates.parse>['data']>([]),
    [doctors, setDoctors] = useState<{ id: string; name: string }[]>([]),
    [state, setState] = useState('open'),
    [text, setText] = useState(''),
    [template, setTemplate] = useState(''),
    [mode, setMode] = useState('text'),
    [agreed, setAgreed] = useState(false),
    [source, setSource] = useState('written'),
    [doctor, setDoctor] = useState(''),
    [notice, setNotice] = useState('');
  const pending = useRef<{ id: string; text?: string; templateId?: string } | null>(null);
  const load = useCallback(
    async (next?: string) => {
      const r = await api.request('GET', '/inbox', {
        schema: InboxList,
        query: { state, cursor: next },
      });
      setThreads((old) => (next ? [...old, ...r.data] : r.data));
      setCursor(r.nextCursor);
      setAvailable(r.available);
    },
    [api, state],
  );
  const messages = useCallback(
    async (id: string, next?: string) => {
      const r = await api.request('GET', `/inbox/threads/${id}/messages`, {
        schema: InboxMessages,
        query: { cursor: next },
      });
      setView((old) => (next && old ? { ...r, data: [...old.data, ...r.data] } : r));
    },
    [api],
  );
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('inbox.failed'));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load().catch((e) => setError(e instanceof Error ? e.message : t('inbox.failed')));
  }, [load, t]);
  useEffect(() => {
    void api
      .request('GET', '/inbox/templates', { schema: InboxTemplates })
      .then((r) => setTemplates(r.data))
      .catch(() => setError(t('inbox.failed')));
    void api
      .request('GET', '/inbox/doctors', { schema: InboxDoctors })
      .then((r) => setDoctors(r.data))
      .catch(() => setError(t('inbox.failed')));
  }, [api, t]);
  async function select(thread: Thread) {
    setSelected(thread.id);
    setView(null);
    setText('');
    setTemplate('');
    pending.current = null;
    setAgreed(false);
    setDoctor(thread.assignedDoctorId ?? '');
    await messages(thread.id);
  }
  async function act(path: string, body: object) {
    if (!view) return;
    const r = await api.request('POST', `/inbox/threads/${view.thread.id}/${path}`, {
      schema: InboxThread,
      body,
    });
    if (r.canRead) {
      await messages(r.id);
    } else {
      setView(null);
      setSelected(null);
    }
    await load();
  }
  async function send() {
    if (!view) return;
    pending.current ??= {
      id: crypto.randomUUID(),
      ...(mode === 'template' ? { templateId: template } : { text }),
    };
    let r;
    try {
      r = await api.request('POST', `/inbox/threads/${view.thread.id}/messages`, {
        schema: InboxMessage,
        body: pending.current,
      });
    } catch (e) {
      if (e instanceof ApiError && [400, 409, 429].includes(e.status)) pending.current = null;
      throw e;
    }
    pending.current = null;
    setText('');
    setNotice(t(`inbox.state.${r.state}` as MessageKey));
    await messages(view.thread.id);
    await load();
  }
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap justify-between gap-3">
        <h1 className="font-display text-2xl font-bold">{t('inbox.title')}</h1>
        {me?.role === 'clinic_admin' && (
          <Link className="underline" href="/clinic/message-templates">
            {t('inbox.templates')}
          </Link>
        )}
      </div>
      <p>{t('inbox.intro')}</p>
      {!available && <p role="status">{t('inbox.unavailable')}</p>}
      {error && (
        <p role="alert" className="rounded-xl border p-3">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <div className="flex flex-wrap gap-3">
        <Field label={t('inbox.filter')}>
          <NativeSelect
            disabled={busy || !!pending.current}
            value={state}
            onChange={(e) => {
              setState(e.target.value);
              setSelected(null);
              setView(null);
            }}
          >
            <option value="open">{t('inbox.open')}</option>
            <option value="resolved">{t('inbox.resolved')}</option>
          </NativeSelect>
        </Field>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await load();
              if (selected) await messages(selected);
            })
          }
        >
          {t('inbox.refresh')}
        </Button>
      </div>
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(16rem,1fr)_2fr]">
        <section className="space-y-3" aria-label={t('inbox.conversations')}>
          {!threads.length && <p>{t('inbox.empty')}</p>}
          {threads.map((r) => (
            <article className="surface space-y-3 p-4" key={r.id}>
              <p className="font-semibold">{r.phone ?? `•••• ${r.last4}`}</p>
              <p>
                {t('inbox.unread', { count: r.unread })} · {new Date(r.updatedAt).toLocaleString()}
              </p>
              <p>
                {r.stopped
                  ? t('inbox.stopped')
                  : r.canReply
                    ? t('inbox.windowOpen')
                    : t('inbox.windowClosed')}
              </p>
              {r.canRead ? (
                <Button
                  disabled={busy || !!pending.current}
                  variant={selected === r.id ? 'default' : 'outline'}
                  onClick={() => void run(() => select(r))}
                >
                  {t('inbox.view')}
                </Button>
              ) : (
                <p>{t('inbox.restricted')}</p>
              )}
              {!r.assignedDoctorId && me?.role !== 'doctor' && (
                <form
                  className="space-y-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const form = new FormData(e.currentTarget),
                      doctorId = String(form.get('doctor'));
                    void run(async () => {
                      await api.request('POST', `/inbox/threads/${r.id}/assign`, {
                        schema: InboxThread,
                        body: { revision: r.revision, doctorId },
                      });
                      if (selected === r.id) {
                        setSelected(null);
                        setView(null);
                      }
                      await load();
                    });
                  }}
                >
                  <Field label={t('inbox.assign')}>
                    <NativeSelect name="doctor" required>
                      <option value="">{t('inbox.choose')}</option>
                      {doctors.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                    </NativeSelect>
                  </Field>
                  <Button type="submit" variant="outline" disabled={busy || !!pending.current}>
                    {t('inbox.assign')}
                  </Button>
                </form>
              )}
            </article>
          ))}
          {cursor && (
            <Button disabled={busy} onClick={() => void run(() => load(cursor))}>
              {t('inbox.more')}
            </Button>
          )}
        </section>
        {view && (
          <section className="surface space-y-4 p-4 sm:p-6" aria-label={t('inbox.conversation')}>
            <h2 className="font-display text-xl font-bold">{view.thread.phone}</h2>
            <p>
              {t('inbox.windowUntil', {
                date: new Date(view.thread.windowEndsAt).toLocaleString(),
              })}
            </p>
            <p className="text-sm">{t('inbox.safety')}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void run(() => act('action', { revision: view.thread.revision, markRead: true }))
                }
              >
                {t('inbox.markRead')}
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    act('action', {
                      revision: view.thread.revision,
                      state: view.thread.state === 'open' ? 'resolved' : 'open',
                    }),
                  )
                }
              >
                {t(view.thread.state === 'open' ? 'inbox.resolve' : 'inbox.reopen')}
              </Button>
            </div>
            <ol className="space-y-3" aria-label={t('inbox.messages')}>
              {view.data.map((m) => (
                <li
                  className={`rounded-xl border p-3 ${m.direction === 'outbound' ? 'bg-muted' : 'bg-card'}`}
                  key={m.id}
                >
                  <p className="text-sm font-medium">
                    {t(m.direction === 'inbound' ? 'inbox.incoming' : 'inbox.outgoing')} ·{' '}
                    {new Date(m.occurredAt).toLocaleString()}
                  </p>
                  <p className="whitespace-pre-wrap break-words">
                    {m.kind === 'unsupported' ? t('inbox.unsupported') : m.body}
                  </p>
                  <p className="text-xs">{t(`inbox.state.${m.state}` as MessageKey)}</p>
                  {m.direction === 'outbound' && (
                    <p className="break-all text-xs">{t('inbox.sendReference', { id: m.id })}</p>
                  )}
                </li>
              ))}
            </ol>
            {view.nextCursor && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void run(() => messages(view.thread.id, view.nextCursor!))}
              >
                {t('inbox.older')}
              </Button>
            )}
            <form
              className="space-y-3 border-t pt-4"
              onSubmit={(e) => {
                e.preventDefault();
                void run(send);
              }}
            >
              <Field label={t('inbox.replyType')}>
                <NativeSelect
                  disabled={busy || !!pending.current}
                  value={mode}
                  onChange={(e) => setMode(e.target.value)}
                >
                  <option value="text">{t('inbox.text')}</option>
                  <option value="template">{t('inbox.approvedTemplate')}</option>
                </NativeSelect>
              </Field>
              {mode === 'text' ? (
                <Field label={t('inbox.reply')}>
                  <Textarea
                    required
                    maxLength={4000}
                    disabled={busy || !!pending.current}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                  />
                </Field>
              ) : (
                <>
                  <Field label={t('inbox.approvedTemplate')}>
                    <NativeSelect
                      required
                      disabled={busy || !!pending.current}
                      value={template}
                      onChange={(e) => setTemplate(e.target.value)}
                    >
                      <option value="">{t('inbox.choose')}</option>
                      {templates.map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.name} · {x.language}
                        </option>
                      ))}
                    </NativeSelect>
                  </Field>
                  {template && (
                    <p className="whitespace-pre-wrap">
                      {templates.find((x) => x.id === template)?.body}
                    </p>
                  )}
                </>
              )}
              <p>{t('inbox.sendHelp')}</p>
              {pending.current && (
                <p className="break-all text-sm">
                  {t('inbox.sendReference', { id: pending.current.id })}
                </p>
              )}
              <Button
                type="submit"
                disabled={
                  busy ||
                  !available ||
                  (!pending.current &&
                    (view.thread.state !== 'open' ||
                      view.thread.stopped ||
                      (mode === 'text' && !view.thread.canReply) ||
                      (mode === 'template' && !view.thread.templateConsent)))
                }
              >
                {pending.current ? t('inbox.recover') : t('inbox.send')}
              </Button>
            </form>
            <form
              className="space-y-3 border-t pt-4"
              onSubmit={(e) => {
                e.preventDefault();
                void run(() =>
                  act('consent', {
                    revision: view.thread.revision,
                    enabled: true,
                    recipientAgreed: agreed,
                    source,
                  }),
                );
              }}
            >
              <h3 className="font-semibold">{t('inbox.consent')}</h3>
              <p>{t('inbox.consentHelp')}</p>
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-1 h-5 w-5 shrink-0"
                  checked={agreed}
                  onChange={(e) => setAgreed(e.target.checked)}
                />
                {t('inbox.agreed')}
              </label>
              <Field label={t('inbox.consentSource')}>
                <NativeSelect value={source} onChange={(e) => setSource(e.target.value)}>
                  {['written', 'phone', 'in_person'].map((x) => (
                    <option key={x} value={x}>
                      {t(`inbox.source.${x}` as MessageKey)}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Button type="submit" disabled={busy || !agreed}>
                {t('inbox.saveConsent')}
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    act('consent', {
                      revision: view.thread.revision,
                      enabled: false,
                      recipientAgreed: false,
                      source,
                    }),
                  )
                }
              >
                {t('inbox.revoke')}
              </Button>
            </form>
            {view.thread.assignedDoctorId === me?.user.id && (
              <form
                className="space-y-3 border-t pt-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(() =>
                    act('assign', { revision: view.thread.revision, doctorId: doctor || null }),
                  );
                }}
              >
                <Field label={t('inbox.handoff')}>
                  <NativeSelect value={doctor} onChange={(e) => setDoctor(e.target.value)}>
                    <option value="">{t('inbox.frontDesk')}</option>
                    {doctors.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
                <Button type="submit" disabled={busy || !!pending.current}>
                  {t('inbox.handoff')}
                </Button>
              </form>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
