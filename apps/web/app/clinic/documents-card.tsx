'use client';

import { ApiError } from '@dhc/api-client';
import {
  DOCUMENT_LIMITS,
  DocumentCategory,
  DocumentLanguage,
  OrganisationSettings,
  type LibraryDocument,
  type PatientDocument,
} from '@dhc/contracts';
import { formatIstDateTime } from '@dhc/domain';
import {
  Button,
  Chip,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  NativeSelect,
  Textarea,
} from '@dhc/ui-web';
import { FileText, Share2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { checkDocumentFile, documentAccept, documentErrorText } from '../../lib/documents';
import { useSession } from './session-provider';

const ALERT = 'rounded-xl bg-danger-soft px-4 py-3 text-sm font-medium text-destructive';
const OK = 'rounded-xl bg-success-soft px-4 py-3 text-sm text-success';
const CHOICE = 'flex min-h-11 items-start gap-2 text-sm';
const BOX = 'mt-1 size-4 shrink-0 accent-primary';

type Settings = Pick<OrganisationSettings, 'maxUploadMb' | 'uploadTypes'>;

/** The clinic's upload limits, for the file pickers; null until loaded (or if that failed). */
export function useUploadLimits(): Settings | null {
  const { api } = useSession();
  const [settings, setSettings] = useState<Settings | null>(null);
  useEffect(() => {
    let current = true;
    api
      .request('GET', '/organisation-settings', { schema: OrganisationSettings })
      .then((s) => current && setSettings(s))
      .catch(() => current && setSettings(null));
    return () => {
      current = false;
    };
  }, [api]);
  return settings;
}

/**
 * Opens a document file in a new tab, as results open on the patient profile: the tab
 * opens first (so the browser does not block it), then shows the file from an object URL
 * that is revoked after a minute.
 */
export async function openStaffFile(fetchFile: () => Promise<Blob>) {
  const tab = window.open('', '_blank');
  if (tab) tab.opener = null;
  try {
    const url = URL.createObjectURL(await fetchFile());
    if (tab) tab.location.href = url;
    else window.location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (e) {
    tab?.close();
    throw e;
  }
}

/**
 * Documents shared with a patient (PRD §7.3) on the patient page (all of them) and the
 * consultation screen (those shared at the visit): what was shared, by whom and when,
 * whether the patient has opened it, **Open** and **Withdraw**; and **Share document**,
 * from the library or as a one-off upload. Doctors only, under the chart model. Shared
 * documents are part of the clinical record: withdrawn ones stay listed, marked.
 */
export function DocumentsCard({
  patientId,
  patientName,
  appointmentId,
  canShare,
}: {
  patientId: string;
  patientName: string;
  /** Only the documents shared at this visit, and new shares made at it. */
  appointmentId?: string;
  canShare: boolean;
}) {
  const { api, locale, signOut, t } = useSession();
  const settings = useUploadLimits();
  const [rows, setRows] = useState<PatientDocument[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) return void signOut('expired');
      setError(documentErrorText(e, t, settings));
    },
    [signOut, t, settings],
  );
  const failRef = useRef(fail);
  useEffect(() => {
    failRef.current = fail;
  }, [fail]);

  const load = useCallback(
    async (cursor?: string) => {
      try {
        const page = await api.patientDocuments(patientId, { appointmentId, cursor });
        setRows((current) => {
          if (!cursor) return page.data;
          // A double click can ask for the same page twice: keep each document once.
          const seen = new Set((current ?? []).map((d) => d.id));
          return [...(current ?? []), ...page.data.filter((d) => !seen.has(d.id))];
        });
        setNextCursor(page.nextCursor);
      } catch (e) {
        failRef.current(e);
      }
    },
    [api, patientId, appointmentId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function view(doc: PatientDocument) {
    setError(null);
    try {
      await openStaffFile(() => api.patientDocumentFile(doc.id));
    } catch (e) {
      fail(e);
    }
  }

  async function withdraw(doc: PatientDocument) {
    setBusy(doc.id);
    setError(null);
    setNotice(null);
    try {
      const updated = await api.withdrawPatientDocument(doc.id);
      setRows((current) => (current ?? []).map((r) => (r.id === updated.id ? updated : r)));
      setConfirming(null);
      setNotice(t('documents.withdrawn'));
    } catch (e) {
      fail(e);
      if (e instanceof ApiError && e.status === 409) void load();
    } finally {
      setBusy(null);
    }
  }

  const time = (at: string) => formatIstDateTime(at, locale);
  const titleId = appointmentId ? 'visit-documents-title' : 'patient-documents-title';

  return (
    <section aria-labelledby={titleId} data-testid="patient-documents">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 id={titleId} className="font-display text-lg font-bold">
          {t('documents.title')}
        </h2>
        {canShare && (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setNotice(null);
              setOpen(true);
            }}
          >
            <Share2 aria-hidden />
            {t('documents.share')}
          </Button>
        )}
      </div>
      {notice && (
        <p role="status" className={`mb-3 ${OK}`}>
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className={`mb-3 ${ALERT}`}>
          {error}
        </p>
      )}
      {rows === null && !error && (
        <p aria-live="polite" className="text-sm text-muted-foreground">
          {t('common.loading')}
        </p>
      )}
      {rows?.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {t(appointmentId ? 'documents.noneAtVisit' : 'documents.none')}
        </p>
      )}
      {rows && rows.length > 0 && (
        <ul className="m-0 grid list-none gap-2 p-0">
          {rows.map((d) => (
            <li
              key={d.id}
              className="grid gap-1.5 rounded-xl border border-border px-3 py-3"
              data-testid="patient-document"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p
                  className={`m-0 min-w-0 font-semibold [overflow-wrap:anywhere] ${d.withdrawnAt ? 'text-muted-foreground line-through' : ''}`}
                >
                  {d.title}
                </p>
                <span className="flex flex-wrap gap-1.5">
                  {d.withdrawnAt && (
                    <Chip className="border-danger-soft bg-danger-soft text-destructive">
                      {t('documents.status.withdrawn')}
                    </Chip>
                  )}
                  <Chip>{t(`documents.source.${d.source}`)}</Chip>
                  {d.category && <Chip>{t(`documents.category.${d.category}`)}</Chip>}
                </span>
              </div>
              <p className="m-0 text-sm text-muted-foreground">
                {t('documents.sharedOn', {
                  time: time(d.sharedAt),
                  name: d.sharedBy.name ?? t('documents.unknownDoctor'),
                })}
                {' · '}
                {d.openedAt
                  ? t('documents.openedOn', { time: time(d.openedAt) })
                  : t('documents.notOpened')}
              </p>
              {d.withdrawnAt && (
                <p className="m-0 text-sm text-muted-foreground">
                  {t('documents.withdrawnOn', {
                    time: time(d.withdrawnAt),
                    name: d.withdrawnBy?.name ?? t('documents.unknownDoctor'),
                  })}
                </p>
              )}
              {d.note && <p className="m-0 whitespace-pre-line text-sm">{d.note}</p>}
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={t('documents.openFor', { title: d.title })}
                  onClick={() => void view(d)}
                >
                  <FileText aria-hidden />
                  {t('documents.open')}
                </Button>
                {!d.withdrawnAt && confirming !== d.id && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={t('documents.withdrawFor', { title: d.title })}
                    onClick={() => setConfirming(d.id)}
                  >
                    {t('documents.withdraw')}
                  </Button>
                )}
              </div>
              {confirming === d.id && (
                <div className="confirm-actions grid gap-2 rounded-xl bg-muted p-3 text-sm">
                  <p className="m-0">{t('documents.withdrawConfirm', { title: d.title })}</p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      disabled={busy === d.id}
                      onClick={() => void withdraw(d)}
                    >
                      {t('documents.withdraw')}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setConfirming(null)}
                    >
                      {t('common.cancel')}
                    </Button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {nextCursor && (
        <Button
          type="button"
          variant="outline"
          className="mt-3"
          onClick={() => void load(nextCursor)}
        >
          {t('documents.more')}
        </Button>
      )}
      {canShare && (
        <ShareDialog
          open={open}
          onOpenChange={setOpen}
          patientId={patientId}
          patientName={patientName}
          appointmentId={appointmentId}
          settings={settings}
          onShared={() => {
            setOpen(false);
            setNotice(t('documents.shared'));
            void load();
          }}
        />
      )}
    </section>
  );
}

interface Draft {
  source: 'library' | 'upload';
  libraryDocumentId: string;
  file: File | null;
  title: string;
  category: DocumentCategory | '';
  language: DocumentLanguage | '';
  note: string;
}

const EMPTY: Draft = {
  source: 'library',
  libraryDocumentId: '',
  file: null,
  title: '',
  category: '',
  language: '',
  note: '',
};

type Errors = Partial<Record<'sheet' | 'file' | 'title', string>>;

/** Share a library sheet, or upload a one-off document (a report), with an optional note. */
function ShareDialog({
  open,
  onOpenChange,
  patientId,
  patientName,
  appointmentId,
  settings,
  onShared,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  patientId: string;
  patientName: string;
  appointmentId?: string;
  settings: Settings | null;
  onShared: () => void;
}) {
  const { api, signOut, t } = useSession();
  const [sheets, setSheets] = useState<LibraryDocument[] | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [errors, setErrors] = useState<Errors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // One key per attempt: a retry after a lost answer shares once, not twice.
  const [key, setKey] = useState(() => crypto.randomUUID());
  // The chosen file once uploaded, so a retry shares it instead of uploading it again.
  const uploaded = useRef<{ file: File; id: string } | null>(null);
  // The latest settings and wording, read when an error arrives, so their changes do not
  // reset a dialog the doctor is filling in.
  const settingsRef = useRef(settings);
  const tRef = useRef(t);
  useEffect(() => {
    settingsRef.current = settings;
    tRef.current = t;
  }, [settings, t]);

  useEffect(() => {
    if (!open) return;
    setDraft(EMPTY);
    setErrors({});
    setFailure(null);
    setKey(crypto.randomUUID());
    uploaded.current = null;
    let current = true;
    api
      .libraryDocuments()
      .then((list) => current && setSheets(list.data))
      .catch((e: unknown) => {
        if (!current) return;
        if (e instanceof ApiError && e.status === 401) return void signOut('expired');
        setSheets(null);
        setFailure(documentErrorText(e, tRef.current, settingsRef.current));
      });
    return () => {
      current = false;
    };
  }, [open, api, signOut]);

  const set = <K extends keyof Draft>(field: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [field]: value }));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const found: Errors = {};
    let mediaType = '';
    if (draft.source === 'library' && !draft.libraryDocumentId) {
      found.sheet = t('documents.errorSheet');
    }
    if (draft.source === 'upload') {
      if (!draft.file) found.file = t('library.errorFile');
      else {
        const check = checkDocumentFile(draft.file, settings, t);
        if ('text' in check) found.file = check.text;
        else mediaType = check.mediaType;
      }
      if (!draft.title.trim()) found.title = t('library.errorTitle');
    }
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    setFailure(null);
    try {
      const common = { appointmentId: appointmentId ?? null, note: draft.note.trim() || null };
      if (draft.source === 'library') {
        await api.shareDocument(
          patientId,
          { source: 'library', libraryDocumentId: draft.libraryDocumentId, ...common },
          key,
        );
      } else {
        const file = draft.file!;
        if (uploaded.current?.file !== file) {
          // Sent as the type checked here: some browsers give a file no type.
          const stored = await api.uploadDocumentFile(file.slice(0, file.size, mediaType));
          uploaded.current = { file, id: stored.id };
        }
        await api.shareDocument(
          patientId,
          {
            source: 'upload',
            fileId: uploaded.current.id,
            title: draft.title.trim(),
            category: draft.category || null,
            language: draft.language || null,
            ...common,
          },
          key,
        );
      }
      onShared();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return void signOut('expired');
      setFailure(documentErrorText(e, t, settings));
      if (e instanceof ApiError) {
        // A refused, expired or used upload is not kept: sharing again uploads it again.
        if (e.fields.file || e.fields.fileId) uploaded.current = null;
        // The server answered that nothing was shared, so a corrected form is a new attempt.
        // A lost answer, or a first attempt still running or of unknown result, keeps the
        // key, so a retry cannot share twice.
        if (!['in_progress', 'unknown'].includes(e.fields.idempotencyKey ?? '')) {
          setKey(crypto.randomUUID());
        }
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('documents.shareTitle', { name: patientName })}</DialogTitle>
          <DialogDescription>{t('documents.shareHint')}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => void submit(e)}
          noValidate
          data-testid="share-document-form"
        >
          <fieldset>
            <legend className="sr-only">{t('documents.share')}</legend>
            {(['library', 'upload'] as const).map((source) => (
              <label key={source} className={CHOICE}>
                <input
                  type="radio"
                  name="document-source"
                  value={source}
                  checked={draft.source === source}
                  onChange={() => set('source', source)}
                  className={BOX}
                />
                <span>
                  {t(source === 'library' ? 'documents.fromLibrary' : 'documents.uploadOne')}
                </span>
              </label>
            ))}
          </fieldset>

          {draft.source === 'library' ? (
            sheets?.length === 0 ? (
              <p className="rounded-xl bg-info-soft px-4 py-3 text-sm text-info">
                {t('documents.noSheets')}
              </p>
            ) : (
              <Field label={t('documents.sheet')} error={errors.sheet}>
                <NativeSelect
                  value={draft.libraryDocumentId}
                  onChange={(e) => set('libraryDocumentId', e.target.value)}
                  disabled={!sheets}
                >
                  <option value="">{t('documents.chooseSheet')}</option>
                  {sheets?.map((s) => (
                    <option key={s.id} value={s.id}>
                      {[
                        s.title,
                        s.category ? t(`documents.category.${s.category}`) : null,
                        t(`documents.language.${s.language}`),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            )
          ) : (
            <div className="grid gap-4">
              <Field
                label={t('library.file')}
                error={errors.file}
                hint={t('documents.fileHint', { mb: settings?.maxUploadMb ?? 25 })}
              >
                <Input
                  type="file"
                  accept={documentAccept(settings)}
                  onChange={(e) => set('file', e.target.files?.[0] ?? null)}
                />
              </Field>
              <Field label={t('library.titleLabel')} error={errors.title}>
                <Input
                  value={draft.title}
                  maxLength={DOCUMENT_LIMITS.title}
                  onChange={(e) => set('title', e.target.value)}
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t('library.category')}>
                  <NativeSelect
                    value={draft.category}
                    onChange={(e) => set('category', e.target.value as Draft['category'])}
                  >
                    <option value="">{t('documents.category.none')}</option>
                    {DocumentCategory.options.map((c) => (
                      <option key={c} value={c}>
                        {t(`documents.category.${c}`)}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
                <Field label={t('library.language')}>
                  <NativeSelect
                    value={draft.language}
                    onChange={(e) => set('language', e.target.value as Draft['language'])}
                  >
                    <option value="">—</option>
                    {DocumentLanguage.options.map((l) => (
                      <option key={l} value={l}>
                        {t(`documents.language.${l}`)}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
              </div>
            </div>
          )}

          <Field label={t('documents.note')}>
            <Textarea
              rows={3}
              value={draft.note}
              maxLength={DOCUMENT_LIMITS.note}
              onChange={(e) => set('note', e.target.value)}
            />
          </Field>

          {failure && (
            <p role="alert" className={ALERT}>
              {failure}
            </p>
          )}
          <DialogFooter className="gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={busy}>
              {t('documents.send')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
