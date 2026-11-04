'use client';

import { ApiError } from '@dhc/api-client';
import {
  DOCUMENT_LIMITS,
  DocumentCategory,
  DocumentLanguage,
  type LibraryDocument,
} from '@dhc/contracts';
import { fileSize } from '@dhc/api-client';
import { formatIstDateTime } from '@dhc/domain';
import {
  Button,
  Chip,
  EmptyState,
  Field,
  Input,
  NativeSelect,
  PageHeader,
  Surface,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@dhc/ui-web';
import { FileText } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { checkDocumentFile, documentAccept, documentErrorText } from '../../../lib/documents';
import { openStaffFile, useUploadLimits } from '../documents-card';
import { useSession } from '../session-provider';
import { ClinicShell, NotAllowed } from '../shell';

const H2 = 'font-display text-lg font-bold';
const MUTED = 'text-sm text-muted-foreground';
const ALERT = 'rounded-xl bg-danger-soft px-4 py-3 text-sm font-medium text-destructive';

type Status = 'active' | 'archived';

/**
 * The clinic's document library (PRD §7.3): reusable sheets (exercise sheets, diet charts,
 * information) that doctors share with patients. Clinic admins and doctors add, rename,
 * replace, archive and restore them; nothing is ever deleted, and patients keep the copy
 * they were sent whatever happens to the sheet afterwards.
 */
export default function LibraryPage() {
  return (
    <ClinicShell>
      {(me) =>
        me.role === 'clinic_admin' || me.role === 'doctor' ? <LibraryScreen /> : <NotAllowed />
      }
    </ClinicShell>
  );
}

function LibraryScreen() {
  const { api, locale, signOut, t } = useSession();
  const settings = useUploadLimits();
  const [status, setStatus] = useState<Status>('active');
  const [rows, setRows] = useState<LibraryDocument[] | null>(null);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<LibraryDocument | 'new' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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

  // Only the latest request may set the list, so a slow load cannot hide a change.
  const latest = useRef(0);
  const load = useCallback(async () => {
    const request = ++latest.current;
    try {
      const list = await api.libraryDocuments({ status });
      if (request === latest.current) setRows(list.data);
    } catch (e) {
      if (request === latest.current) failRef.current(e);
    }
  }, [api, status]);

  useEffect(() => {
    setRows(null);
    void load();
  }, [load]);

  async function run(action: () => Promise<string>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setNotice(await action());
      return true;
    } catch (e) {
      fail(e);
      return false;
    } finally {
      setBusy(false);
    }
  }

  const setArchived = (doc: LibraryDocument, archived: boolean) =>
    run(async () => {
      await api.updateLibraryDocument(doc.id, { archived });
      await load();
      return t(archived ? 'library.archived' : 'library.restored');
    });

  async function view(doc: LibraryDocument) {
    setError(null);
    try {
      await openStaffFile(() => api.libraryDocumentFile(doc.id));
    } catch (e) {
      fail(e);
    }
  }

  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = rows?.filter((r) => words.every((w) => r.title.toLowerCase().includes(w)));

  return (
    <section className="space-y-5">
      <PageHeader
        titleId="library-title"
        title={t('library.title')}
        sub={t('library.sub')}
        actions={
          editing === null ? (
            <Button
              type="button"
              disabled={busy}
              onClick={() => {
                setNotice(null);
                setEditing('new');
              }}
            >
              {t('library.add')}
            </Button>
          ) : undefined
        }
      />

      {editing !== null && (
        <SheetForm
          key={editing === 'new' ? 'new' : editing.id}
          sheet={editing === 'new' ? null : editing}
          settings={settings}
          onCancel={() => setEditing(null)}
          onSaved={(text) => {
            setEditing(null);
            setError(null);
            setNotice(text);
            void load();
          }}
        />
      )}

      {notice && (
        <p role="status" className="rounded-xl bg-success-soft px-4 py-3 text-sm text-success">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className={ALERT}>
          {error}
        </p>
      )}

      <Surface className="space-y-4 p-4 sm:p-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <Tabs value={status} onValueChange={(v) => setStatus(v as Status)}>
            <TabsList>
              <TabsTrigger value="active">{t('library.tabActive')}</TabsTrigger>
              <TabsTrigger value="archived">{t('library.tabArchived')}</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="w-full sm:w-72">
            <Field label={t('library.search')}>
              <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} />
            </Field>
          </div>
        </div>

        {rows === null && !error && (
          <p aria-live="polite" className={MUTED}>
            {t('common.loading')}
          </p>
        )}
        {rows?.length === 0 && (
          <EmptyState title={t(status === 'active' ? 'library.none' : 'library.noneArchived')} />
        )}
        {rows && rows.length > 0 && shown?.length === 0 && (
          <p className={MUTED}>{t('library.noMatches')}</p>
        )}
        {shown && shown.length > 0 && (
          <ul className="m-0 list-none divide-y divide-border/70 p-0" data-testid="library-list">
            {shown.map((doc) => (
              <li
                key={doc.id}
                data-testid="library-item"
                className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3"
              >
                <span className="min-w-0 flex-1">
                  <strong className="[overflow-wrap:anywhere]">{doc.title}</strong>
                  <span className="mt-1 flex flex-wrap gap-1.5">
                    {doc.category && <Chip>{t(`documents.category.${doc.category}`)}</Chip>}
                    <Chip>{t(`documents.language.${doc.language}`)}</Chip>
                    <Chip>
                      {doc.mediaType === 'application/pdf'
                        ? 'PDF'
                        : doc.mediaType.slice(6).toUpperCase()}{' '}
                      · {fileSize(doc.sizeBytes)}
                    </Chip>
                  </span>
                  <span className={`mt-1 block ${MUTED}`}>
                    {t('library.shareCount', { count: doc.shareCount })} ·{' '}
                    {t('library.updatedOn', { date: formatIstDateTime(doc.updatedAt, locale) })}
                  </span>
                </span>
                <span className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={t('library.openFor', { title: doc.title })}
                    onClick={() => void view(doc)}
                  >
                    <FileText aria-hidden />
                    {t('library.open')}
                  </Button>
                  {!doc.archived && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy || editing !== null}
                      aria-label={t('library.editFor', { title: doc.title })}
                      onClick={() => {
                        setNotice(null);
                        setEditing(doc);
                      }}
                    >
                      {t('library.edit')}
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    aria-label={t(doc.archived ? 'library.restoreFor' : 'library.archiveFor', {
                      title: doc.title,
                    })}
                    onClick={() => void setArchived(doc, !doc.archived)}
                  >
                    {t(doc.archived ? 'library.restore' : 'library.archive')}
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Surface>
    </section>
  );
}

/** Add a sheet (a file and its details), or edit one's details and give it a new file. */
function SheetForm({
  sheet,
  settings,
  onCancel,
  onSaved,
}: {
  sheet: LibraryDocument | null;
  settings: ReturnType<typeof useUploadLimits>;
  onCancel: () => void;
  onSaved: (notice: string) => void;
}) {
  const { api, signOut, t } = useSession();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState(sheet?.title ?? '');
  const [category, setCategory] = useState<DocumentCategory | ''>(sheet?.category ?? '');
  const [language, setLanguage] = useState<DocumentLanguage>(sheet?.language ?? 'en');
  const [errors, setErrors] = useState<{ file?: string; title?: string }>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // One key per form: a retried submit (a lost response) adds the sheet once.
  const key = useRef(crypto.randomUUID());
  // The chosen file once uploaded, so a retry uses it instead of uploading it again.
  const uploaded = useRef<{ file: File; id: string } | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const found: { file?: string; title?: string } = {};
    let mediaType = '';
    if (!sheet && !file) found.file = t('library.errorFile');
    if (file) {
      const check = checkDocumentFile(file, settings, t);
      if ('text' in check) found.file = check.text;
      else mediaType = check.mediaType;
    }
    if (!title.trim()) found.title = t('library.errorTitle');
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    setFailure(null);
    try {
      let fileId: string | undefined;
      if (file) {
        if (uploaded.current?.file !== file) {
          const stored = await api.uploadDocumentFile(file.slice(0, file.size, mediaType));
          uploaded.current = { file, id: stored.id };
        }
        fileId = uploaded.current.id;
      }
      const details = { title: title.trim(), category: category || null, language };
      if (sheet) {
        await api.updateLibraryDocument(sheet.id, { ...details, ...(fileId ? { fileId } : {}) });
        onSaved(t('library.saved'));
      } else {
        await api.createLibraryDocument({ ...details, fileId: fileId! }, key.current);
        onSaved(t('library.added'));
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return void signOut('expired');
      setFailure(documentErrorText(e, t, settings));
      if (e instanceof ApiError) {
        if (e.fields.file || e.fields.fileId) uploaded.current = null;
        if (!['in_progress', 'unknown'].includes(e.fields.idempotencyKey ?? '')) {
          key.current = crypto.randomUUID();
        }
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Surface className="p-4 sm:p-6">
      <form
        data-testid="library-form"
        aria-labelledby="library-form-title"
        className="space-y-4"
        onSubmit={(e) => void submit(e)}
        noValidate
      >
        <h2 id="library-form-title" className={H2}>
          {sheet ? t('library.editTitle') : t('library.addTitle')}
        </h2>
        <Field
          label={sheet ? t('library.replaceFile') : t('library.file')}
          error={errors.file}
          hint={
            sheet
              ? t('library.replaceHint')
              : t('documents.fileHint', { mb: settings?.maxUploadMb ?? 25 })
          }
        >
          <Input
            type="file"
            accept={documentAccept(settings)}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </Field>
        <Field label={t('library.titleLabel')} error={errors.title}>
          <Input
            value={title}
            maxLength={DOCUMENT_LIMITS.title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('library.category')}>
            <NativeSelect
              value={category}
              onChange={(e) => setCategory(e.target.value as DocumentCategory | '')}
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
              value={language}
              onChange={(e) => setLanguage(e.target.value as DocumentLanguage)}
            >
              {DocumentLanguage.options.map((l) => (
                <option key={l} value={l}>
                  {t(`documents.language.${l}`)}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </div>
        {failure && (
          <p role="alert" className={ALERT}>
            {failure}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy}>
            {sheet ? t('common.save') : t('library.save')}
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        </div>
      </form>
    </Surface>
  );
}
