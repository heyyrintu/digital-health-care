import {
  ApiError,
  appendPage,
  canUploadResult,
  fileSize,
  findOrder,
  InFlight,
  isStale,
  PICK_TYPES,
  replaceRow,
  resultFileName,
  shareTypeOf,
  uploadErrorMessage,
  withUploaded,
  type Message,
} from '@dhc/api-client';
import type { PortalTestOrder, TestResultSummary } from '@dhc/contracts';
import { MAX_RESULTS_PER_ORDER } from '@dhc/contracts';
import { shortDate, testOrderLabel } from '@dhc/domain';
import type { Locale } from '@dhc/i18n';
import { Button, Card, Notice, Text, useTheme } from '@dhc/ui-native';
import * as DocumentPicker from 'expo-document-picker';
import { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { api, patientAccount } from '../../api';
import { errorMessage } from '../../errors';
import { useLocale } from '../../locale/provider';
import { istToday } from '../logic';
import { LoadError, Loading, PatientScreen } from '../parts';
import { blobBytes, pickedBlob, pickOptions, removePicked, testResultFiles } from '../pdf-native';
import { pickAndUpload } from '../upload';

type ListState =
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  | { status: 'ready'; rows: PortalTestOrder[]; nextCursor: string | null };

type RowNotice = { tone: 'success' | 'error'; text: string };

/** The IST day of a timestamp, as the other screens show dates. */
const dayOf = (at: string, locale: Locale) => shortDate(istToday(new Date(at)), locale);

/**
 * PRD §4.4, §7.1: the family's ordered tests, newest first, with their status and the
 * results so far. A result can be uploaded (a PDF or a photo) until the doctor has reviewed
 * the test, and every result opens in the share sheet like a prescription PDF.
 */
export function TestsScreen() {
  const { t, locale } = useLocale();
  const theme = useTheme();
  const [state, setState] = useState<ListState>({ status: 'loading' });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  // Per test, so an upload on one row never freezes or unfreezes another.
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [notices, setNotices] = useState<Readonly<Record<string, RowNotice>>>({});
  /** The one result being downloaded or shown; the other View buttons wait for it. */
  const [opening, setOpening] = useState<string | null>(null);
  const run = useRef(0);
  const inFlight = useRef(new InFlight());

  const mark = (id: string, on: boolean) =>
    setBusy((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const say = (id: string, notice: RowNotice | null) =>
    setNotices((current) => {
      const next = { ...current };
      if (notice) next[id] = notice;
      else delete next[id];
      return next;
    });
  const text = (m: Message) => t(m.key, m.params);
  const setRow = (next: PortalTestOrder) =>
    setState((s) => (s.status === 'ready' ? { ...s, rows: replaceRow(s.rows, next) } : s));

  const load = useCallback(async () => {
    const id = ++run.current;
    setState({ status: 'loading' });
    setMoreError(null);
    setNotices({});
    try {
      const first = await api.portalTestOrders();
      if (id === run.current) {
        setState({ status: 'ready', rows: first.data, nextCursor: first.nextCursor });
      }
    } catch (error) {
      if (id === run.current) setState({ status: 'error', error });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function more() {
    if (state.status !== 'ready' || !state.nextCursor) return;
    const id = run.current;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await api.portalTestOrders(state.nextCursor);
      if (id !== run.current) return;
      setState((s) =>
        s.status === 'ready'
          ? { status: 'ready', rows: appendPage(s.rows, page.data), nextCursor: page.nextCursor }
          : s,
      );
    } catch (e) {
      if (id === run.current) setMoreError(errorMessage(e, t));
    } finally {
      setLoadingMore(false);
    }
  }

  /** After a 409 the row is out of date: put the server's copy back, so its buttons match. */
  async function refresh(orderId: string) {
    try {
      const found = await findOrder((cursor) => api.portalTestOrders(cursor), orderId);
      // Only a fresh copy replaces the row. Not found (or not within the pages searched), the
      // row stays as it is with the refusal's message: never removed or blanked.
      if (typeof found === 'object') setRow(found);
    } catch {
      // The refusal's message is already showing; the next visit to the screen reloads.
    }
  }

  async function upload(order: PortalTestOrder) {
    if (!inFlight.current.start(order.id)) return;
    say(order.id, null);
    mark(order.id, true);
    try {
      const outcome = await pickAndUpload({
        pick: async () => {
          const picked = await DocumentPicker.getDocumentAsync({
            type: PICK_TYPES,
            ...pickOptions,
          });
          return picked.canceled ? null : (picked.assets[0] ?? null);
        },
        read: pickedBlob,
        send: (file) => api.uploadPortalTestResult(order.id, file),
        removePicked,
      });
      switch (outcome.kind) {
        case 'cancelled':
          return;
        case 'refused':
          return say(order.id, { tone: 'error', text: text(outcome.message) });
        case 'unreadable':
          return say(order.id, { tone: 'error', text: t('patient.tests.pickFailed') });
        case 'uploaded':
          setState((s) => {
            if (s.status !== 'ready') return s;
            const row = s.rows.find((o) => o.id === order.id);
            return row ? { ...s, rows: replaceRow(s.rows, withUploaded(row, outcome.order)) } : s;
          });
          return say(order.id, { tone: 'success', text: t('orders.uploaded') });
        case 'failed': {
          const e = outcome.error;
          const known = uploadErrorMessage(e);
          say(order.id, { tone: 'error', text: known ? text(known) : errorMessage(e, t) });
          // A consent withdrawn elsewhere sends the person back to onboarding.
          if (e instanceof ApiError && e.code === 'CONSENT_REQUIRED') void patientAccount.reload();
          if (isStale(e)) void refresh(order.id);
        }
      }
    } finally {
      inFlight.current.end(order.id);
      mark(order.id, false);
    }
  }

  async function view(order: PortalTestOrder, result: TestResultSummary, n: number) {
    setOpening(result.id);
    say(order.id, null);
    try {
      const outcome = await testResultFiles.open(
        resultFileName(n, result.mediaType),
        async () => blobBytes(await api.portalTestResultFile(result.id)),
        t('patient.tests.resultTitle', { name: testOrderLabel(order, locale), n }),
        result.mediaType,
      );
      if (outcome === 'cannot-share') {
        say(order.id, { tone: 'error', text: t('patient.tests.cannotOpen') });
      }
    } catch (e) {
      say(order.id, { tone: 'error', text: errorMessage(e, t) });
    } finally {
      setOpening(null);
    }
  }

  return (
    <PatientScreen title={t('patient.nav.tests')}>
      {state.status === 'loading' && <Loading />}
      {state.status === 'error' && <LoadError error={state.error} retry={() => void load()} />}
      {state.status === 'ready' &&
        (state.rows.length === 0 ? (
          <Text variant="muted">{t('orders.none')}</Text>
        ) : (
          <View style={{ gap: theme.spacing[3] }}>
            <Text variant="muted">{t('patient.tests.intro')}</Text>
            {state.rows.map((o) => (
              <Card key={o.id}>
                <Text variant="label">{o.patient.name}</Text>
                <Text>{testOrderLabel(o, locale)}</Text>
                <Text variant="muted">
                  {o.doctorName ? `${o.doctorName} · ` : ''}
                  {shortDate(o.visitDate, locale)}
                </Text>
                <Text
                  variant="caption"
                  style={o.status === 'reviewed' ? { color: theme.colors.success } : undefined}
                >
                  {t(`orders.status.${o.status}`)}
                </Text>
                {o.notes && (
                  <Text variant="caption">{t('patient.tests.notes', { notes: o.notes })}</Text>
                )}
                {o.reviewedAt && (
                  <Text variant="caption">
                    {t('patient.tests.reviewed', { date: dayOf(o.reviewedAt, locale) })}
                  </Text>
                )}
                {o.results.map((r, i) => (
                  <View
                    key={r.id}
                    style={{
                      flexDirection: 'row',
                      flexWrap: 'wrap',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: theme.spacing[2],
                    }}
                  >
                    <Text variant="muted" style={{ flexShrink: 1 }}>
                      {shareTypeOf(r.mediaType).label ?? t('patient.tests.fileType')} ·{' '}
                      {fileSize(r.sizeBytes)} ·{' '}
                      {t(
                        r.uploadedBy === 'patient'
                          ? 'patient.tests.byPatient'
                          : 'patient.tests.byClinic',
                        { date: dayOf(r.uploadedAt, locale) },
                      )}
                    </Text>
                    <Button
                      variant="ghost"
                      label={t('patient.tests.view', { n: i + 1 })}
                      loading={opening === r.id}
                      disabled={opening !== null && opening !== r.id}
                      onPress={() => void view(o, r, i + 1)}
                    />
                  </View>
                ))}
                {canUploadResult(o) ? (
                  <View style={{ alignSelf: 'flex-start', marginTop: theme.spacing[2] }}>
                    <Button
                      variant="secondary"
                      label={t('orders.upload')}
                      loading={busy.has(o.id)}
                      onPress={() => void upload(o)}
                    />
                  </View>
                ) : (
                  o.status !== 'reviewed' && (
                    <Text variant="caption">
                      {t('patient.tests.full', { max: MAX_RESULTS_PER_ORDER })}
                    </Text>
                  )
                )}
                {notices[o.id] && <Notice tone={notices[o.id]!.tone}>{notices[o.id]!.text}</Notice>}
              </Card>
            ))}
            {moreError && <Notice tone="error">{moreError}</Notice>}
            {state.nextCursor && (
              <Button
                variant="secondary"
                label={t('orders.more')}
                loading={loadingMore}
                onPress={() => void more()}
              />
            )}
          </View>
        ))}
    </PatientScreen>
  );
}
