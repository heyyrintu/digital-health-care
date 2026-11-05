'use client';
import {
  PatientRecord,
  PatientRecordList,
  RecordOptions,
  RecordShare,
  RecordShareList,
  RecordRevoked,
  RecordCategory,
  type RecordPhotoPages,
} from '@dhc/contracts';
import { Button, Field, Input, NativeSelect, Surface } from '@dhc/ui-web';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { keepAttemptKey, portalErrorMessage } from '../../../lib/patient';
import { openFile } from '../../../lib/patient-files';
import { PortalShell, type ReadyAccount } from '../shell';
import { usePatientSession } from '../session-provider';
import { PortalPage, Notice, PatientPicker, BlockedDownload } from '../parts';
import { RecordMetadataForm } from './record-form';

type Work = { id: string; file: File; payload?: RecordPhotoPages; meta: Record<string, unknown> };
export default function RecordsPage() {
  return (
    <PortalShell>
      {(account) => <Records key={account.selected.id} account={account} />}
    </PortalShell>
  );
}
function Records({ account }: { account: ReadyAccount }) {
  const { api, t, files } = usePatientSession();
  const [rows, setRows] = useState<PatientRecord[]>([]),
    [options, setOptions] = useState<RecordOptions | null>(null),
    [cursor, setCursor] = useState<string | null>(null),
    [hidden, setHidden] = useState(false),
    [category, setCategory] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null),
    [blocked, setBlocked] = useState<{ url: string; name: string } | null>(null),
    [pending, setPending] = useState(false);
  const work = useRef<Work[] | null>(null),
    combine = useRef(false),
    generation = useRef(0);
  const query = {
    patientId: account.selected.id,
    hidden: hidden ? 'true' : 'false',
    ...(category ? { category } : {}),
  };
  const load = useCallback(async () => {
    const n = ++generation.current;
    try {
      const data = await api.request('GET', '/portal/records', {
        schema: PatientRecordList,
        query: {
          patientId: account.selected.id,
          hidden: hidden ? 'true' : 'false',
          ...(category ? { category } : {}),
        },
      });
      if (n === generation.current) {
        setRows(data.data);
        setCursor(data.nextCursor);
      }
    } catch (e) {
      if (n === generation.current) setError(portalErrorMessage(e, t));
    }
  }, [api, account.selected.id, hidden, category, t]);
  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [load]);
  useEffect(() => {
    api
      .request('GET', `/portal/patients/${account.selected.id}/record-options`, {
        schema: RecordOptions,
      })
      .then(setOptions)
      .catch((e: unknown) => setError(portalErrorMessage(e, t)));
  }, [api, account.selected.id, t]);
  async function run(fn: () => Promise<unknown>, refresh = true) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (refresh) await load();
    } catch (e) {
      setError(portalErrorMessage(e, t));
    } finally {
      setBusy(false);
    }
  }
  async function send() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      for (const item of work.current ?? []) {
        await api.request('POST', `/portal/patients/${account.selected.id}/records`, {
          schema: PatientRecord,
          body: { id: item.id, ...item.meta },
        });
        if (combine.current) {
          if (!item.payload)
            item.payload = await photoPages((work.current ?? []).map((w) => w.file));
          await api.request('POST', `/portal/records/${item.id}/photo-pages`, {
            schema: PatientRecord,
            body: item.payload,
          });
          break;
        }
        await api.uploadFile(`/portal/records/${item.id}/file`, item.file, {
          schema: PatientRecord,
        });
      }
      work.current = null;
      setPending(false);
      setNotice(t('patientRecords.uploaded'));
      await load();
    } catch (e) {
      const uncertain = keepAttemptKey(e);
      setPending(uncertain);
      if (!uncertain) work.current = null;
      setError(portalErrorMessage(e, t));
      await load();
    } finally {
      setBusy(false);
    }
  }
  async function upload(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return void send();
    const data = new FormData(e.currentTarget),
      picked = (data.getAll('files') as File[]).filter((f) => f.size),
      title = String(data.get('title') ?? '').trim();
    if (
      !options ||
      !title ||
      !picked.length ||
      picked.length > 10 ||
      picked.some(
        (f) =>
          f.size > options.maxUploadMb * 1048576 ||
          !options.uploadTypes.some(
            (type) =>
              ({
                pdf: 'application/pdf',
                jpeg: 'image/jpeg',
                png: 'image/png',
                webp: 'image/webp',
              })[type] === f.type,
          ),
      )
    )
      return setError(t('patientRecords.fileLimit', { mb: options?.maxUploadMb ?? 0 }));
    combine.current = data.get('combine') === 'on';
    if (combine.current && (picked.length < 2 || picked.some((f) => !f.type.startsWith('image/'))))
      return setError(t('patientRecords.photosOnly'));
    const text = (key: string) => String(data.get(key) ?? '').trim() || null;
    work.current = picked.map((file, i) => ({
      id: crypto.randomUUID(),
      file,
      meta: {
        title: picked.length > 1 && !combine.current ? `${title} (${i + 1})` : title,
        note: text('note'),
        category: text('category') ?? 'other',
        recordDate: text('recordDate'),
        appointmentId: text('appointmentId'),
        testOrderId: text('testOrderId'),
      },
    }));
    await send();
  }
  async function view(r: PatientRecord) {
    setBlocked(null);
    await run(async () => {
      const result = await openFile(
        () =>
          api.requestFile('GET', `/portal/records/${r.id}/file`, {
            accept: r.mediaType ?? 'application/pdf',
          }),
        {
          name:
            r.mediaType === 'application/pdf'
              ? 'record.pdf'
              : 'record.' + (r.mediaType?.split('/')[1] ?? 'bin'),
          mediaType: r.mediaType ?? 'application/pdf',
        },
        files,
      );
      if (result.kind === 'blocked') setBlocked(result);
    });
  }
  return (
    <PortalPage title={t('patientRecords.title')} intro={t('patientRecords.intro')}>
      <fieldset disabled={busy || pending}>
        <PatientPicker
          label={t('patient.book.for')}
          patients={account.patients}
          selectedId={account.selected.id}
          onSelect={account.select}
        />
      </fieldset>
      {error && <Notice tone="error">{error}</Notice>}
      {notice && <Notice tone="success">{notice}</Notice>}
      {blocked && <BlockedDownload {...blocked} />}
      <Surface className="space-y-4 p-5">
        <h2 className="font-display text-lg font-bold">{t('patientRecords.upload')}</h2>
        <form onSubmit={(e) => void upload(e)} className="space-y-3">
          <fieldset disabled={busy || pending || !options} className="space-y-3">
            <Field label={t('patientRecords.files')}>
              <Input
                name="files"
                type="file"
                multiple
                accept={options?.uploadTypes
                  .map(
                    (x) =>
                      ({
                        pdf: 'application/pdf',
                        jpeg: 'image/jpeg',
                        png: 'image/png',
                        webp: 'image/webp',
                      })[x],
                  )
                  .join(',')}
              />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="combine" />
              {t('patientRecords.combine')}
            </label>
            <RecordMetadataForm options={options} />
          </fieldset>
          {pending && (
            <>
              <Notice tone="info">{t('patientRecords.recover')}</Notice>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  work.current = null;
                  setPending(false);
                  void load();
                }}
              >
                {t('patientRecords.reviewSaved')}
              </Button>
            </>
          )}
          <Button disabled={busy || !options} type="submit">
            {t(pending ? 'patientRecords.retry' : 'patientRecords.upload')}
          </Button>
        </form>
      </Surface>
      <div className="flex flex-wrap items-center gap-3">
        <Field label={t('patientRecords.category')}>
          <NativeSelect
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            disabled={busy || pending}
          >
            <option value="">{t('patientRecords.all')}</option>
            {RecordCategory.options.map((c) => (
              <option key={c} value={c}>
                {t(`patientRecords.category.${c}`)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <label className="flex gap-2 text-sm">
          <input
            type="checkbox"
            checked={hidden}
            disabled={busy || pending}
            onChange={(e) => setHidden(e.target.checked)}
          />
          {t('patientRecords.hidden')}
        </label>
        <Button variant="outline" disabled={busy} onClick={() => void load()}>
          {t('patientRecords.refresh')}
        </Button>
      </div>
      {!rows.length && <p>{t('patientRecords.none')}</p>}
      <ul className="space-y-4">
        {rows.map((r) => (
          <RecordRow
            key={`${r.id}:${r.revision}:${r.state}:${r.hiddenAt}`}
            record={r}
            options={options}
            busy={busy || pending}
            action={(fn) => run(fn)}
            view={() => void view(r)}
          />
        ))}
      </ul>
      {cursor && (
        <Button
          variant="outline"
          disabled={busy || pending}
          onClick={() =>
            void run(async () => {
              const data = await api.request('GET', '/portal/records', {
                schema: PatientRecordList,
                query: { ...query, cursor },
              });
              setRows((old) => [...old, ...data.data]);
              setCursor(data.nextCursor);
            }, false)
          }
        >
          {t('documents.more')}
        </Button>
      )}
    </PortalPage>
  );
}
function RecordRow({
  record: r,
  options,
  busy,
  action,
  view,
}: {
  record: PatientRecord;
  options: RecordOptions | null;
  busy: boolean;
  action: (fn: () => Promise<unknown>) => Promise<void>;
  view: () => void;
}) {
  const { api, t } = usePatientSession();
  const [editing, setEditing] = useState(false),
    [confirm, setConfirm] = useState(false),
    [sharing, setSharing] = useState(false),
    [shares, setShares] = useState<RecordShare[]>([]),
    [copied, setCopied] = useState(false);
  const shareId = useRef(crypto.randomUUID());
  async function loadShares() {
    const data = await api.request('GET', `/portal/records/${r.id}/shares`, {
      schema: RecordShareList,
    });
    setShares(data.data);
  }
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget),
      value = (k: string) => String(d.get(k) ?? '').trim() || null;
    await action(async () => {
      await api.request('PATCH', `/portal/records/${r.id}`, {
        schema: PatientRecord,
        body: {
          title: value('title'),
          note: value('note'),
          category: value('category'),
          recordDate: value('recordDate'),
          appointmentId: value('appointmentId'),
          testOrderId: value('testOrderId'),
          revision: r.revision,
        },
      });
      setEditing(false);
    });
  }
  return (
    <li className="surface space-y-3 p-5" data-testid="patient-upload">
      <h2 className="font-display text-lg font-bold">{r.title ?? t('patientRecords.deleted')}</h2>
      <p className="text-sm">
        {t(`patientRecords.category.${r.category}`)} · {r.recordDate ?? r.createdAt.slice(0, 10)}
      </p>
      <p className="text-sm">{t(`patientRecords.state.${r.state}`)}</p>
      {r.note && <p className="whitespace-pre-line text-sm">{r.note}</p>}
      {r.reviewedAt && (
        <p className="text-sm font-medium">
          {t('patientRecords.reviewed', { name: r.reviewedByName ?? t('patientRecords.doctor') })}
        </p>
      )}
      {r.usedAt && <p className="text-sm text-muted-foreground">{t('patientRecords.retained')}</p>}
      {r.state === 'ready' && !r.hiddenAt && (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={busy} onClick={view}>
            {t('portal.documents.view')}
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              void action(async () => {
                await loadShares();
                setSharing(!sharing);
              })
            }
          >
            {t('patientRecords.share')}
          </Button>
        </div>
      )}
      {r.state === 'awaiting_upload' && !r.hiddenAt && (
        <Field label={t('patientRecords.finishUpload')}>
          <Input
            type="file"
            disabled={busy}
            accept="application/pdf,image/jpeg,image/png,image/webp"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f)
                void action(() =>
                  api.uploadFile(`/portal/records/${r.id}/file`, f, { schema: PatientRecord }),
                );
            }}
          />
        </Field>
      )}
      {r.canEdit && (
        <Button variant="link" disabled={busy} onClick={() => setEditing(!editing)}>
          {t('patientRecords.edit')}
        </Button>
      )}
      {editing && (
        <form className="space-y-3" onSubmit={(e) => void save(e)}>
          <fieldset disabled={busy}>
            <RecordMetadataForm options={options} record={r} />
          </fieldset>
          <Button type="submit" disabled={busy}>
            {t('patientRecords.save')}
          </Button>
        </form>
      )}
      {sharing && (
        <div className="space-y-3 border-t pt-3">
          <p className="text-sm">{t('patientRecords.shareHelp')}</p>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              const d = new FormData(e.currentTarget);
              void action(async () => {
                await api.request('POST', `/portal/records/${r.id}/shares`, {
                  schema: RecordShare,
                  body: {
                    id: shareId.current,
                    doctorUserId: d.get('doctor'),
                    ttlHours: Number(d.get('hours')),
                  },
                });
                await loadShares();
                shareId.current = crypto.randomUUID();
              });
            }}
          >
            <Field label={t('patientRecords.doctor')}>
              <NativeSelect
                name="doctor"
                required
                disabled={busy}
                onChange={() => {
                  shareId.current = crypto.randomUUID();
                }}
              >
                {options?.doctors.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name ?? t('patientRecords.doctor')}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label={t('patientRecords.expires')}>
              <NativeSelect
                name="hours"
                defaultValue="24"
                disabled={busy}
                onChange={() => {
                  shareId.current = crypto.randomUUID();
                }}
              >
                {[1, 24, 72, 168].map((h) => (
                  <option key={h} value={h}>
                    {h} {t('patientRecords.hours')}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Button type="submit" disabled={busy || !options?.doctors.length}>
              {t('patientRecords.createLink')}
            </Button>
          </form>
          {shares.map((s) => (
            <div key={s.id} className="space-y-2 border-t pt-2 text-sm">
              <p>
                {s.doctorName ?? t('patientRecords.doctor')} ·{' '}
                {s.expiresAt.slice(0, 16).replace('T', ' ')} UTC
              </p>
              {s.url ? (
                <>
                  <Input value={s.url} readOnly aria-label={t('patientRecords.link')} />
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(s.url!)
                        .then(() => setCopied(true))
                        .catch(() => setCopied(false));
                    }}
                  >
                    {t('patientRecords.copy')}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        await api.request('DELETE', `/portal/records/${r.id}/shares/${s.id}`, {
                          schema: RecordRevoked,
                        });
                        await loadShares();
                      })
                    }
                  >
                    {t('patientRecords.revoke')}
                  </Button>
                </>
              ) : (
                <p>{t('patientRecords.expired')}</p>
              )}
            </div>
          ))}
          {copied && <p role="status">{t('patientRecords.copied')}</p>}
        </div>
      )}
      {r.canDelete && (
        <Button variant="outline" disabled={busy} onClick={() => setConfirm(!confirm)}>
          {t(r.usedAt ? 'patientRecords.hide' : 'patientRecords.delete')}
        </Button>
      )}
      {confirm && (
        <div className="space-y-2">
          <p>{t(r.usedAt ? 'patientRecords.confirmHide' : 'patientRecords.confirmDelete')}</p>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() =>
              void action(() =>
                api.request('DELETE', `/portal/records/${r.id}`, { schema: PatientRecord }),
              )
            }
          >
            {t('patientRecords.confirm')}
          </Button>
        </div>
      )}
      {r.canRestore && (
        <Button
          disabled={busy}
          onClick={() =>
            void action(() =>
              api.request('POST', `/portal/records/${r.id}/restore`, { schema: PatientRecord }),
            )
          }
        >
          {t('patientRecords.restore')}
        </Button>
      )}
    </li>
  );
}
async function photoPages(files: File[]): Promise<RecordPhotoPages> {
  const pages: RecordPhotoPages['pages'] = [];
  for (const file of files) {
    const image = await createImageBitmap(file);
    try {
      const scale = Math.min(1, 1536 / Math.max(image.width, image.height)),
        canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas unavailable');
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const data = canvas.toDataURL('image/jpeg', 0.9).split(',')[1]!;
      pages.push({ mediaType: 'image/jpeg', data });
    } finally {
      image.close();
    }
  }
  return { pages };
}
