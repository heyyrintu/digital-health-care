'use client';
import { ApiError } from '@dhc/api-client';
import { DrugMoleculeList } from '@dhc/contracts';
import { Button, Input } from '@dhc/ui-web';
import { useState } from 'react';
import { usePlatformSession } from '../session-provider';

/** Explicit identity selection; never guesses clinical equivalence from source text. */
export function MoleculePicker({
  sourceName,
  selectedId,
  selectedName,
  onSelect,
}: {
  sourceName: string;
  selectedId: string | null;
  selectedName: string | null;
  onSelect: (id: string, name: string) => void;
}) {
  const { api, t, signOut } = usePlatformSession();
  const [q, setQ] = useState((selectedName ?? sourceName).slice(0, 60));
  const [rows, setRows] = useState<{ id: string; name: string; drugClass: string | null }[]>([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const search = async () => {
    if (busy || q.trim().length < 2) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.request('GET', '/platform/medicine-molecules', {
        schema: DrugMoleculeList,
        query: { q: q.trim() },
      });
      setRows(result.data);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        void signOut('expired');
        return;
      }
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2 rounded border p-3">
      <p>
        {t('medicineImport.clinicalTarget')}:{' '}
        {selectedId ? selectedName : t('medicineImport.unmapped')}
      </p>
      <label className="block">
        {t('medicineImport.targetSearch')}
        <Input maxLength={60} value={q} onChange={(e) => setQ(e.target.value)} />
      </label>
      <Button type="button" disabled={busy || q.trim().length < 2} onClick={() => void search()}>
        {t('medicineImport.findTarget')}
      </Button>
      {error ? <p role="alert">{error}</p> : null}
      {rows.map((m) => (
        <div key={m.id} className="flex flex-wrap items-center gap-3">
          <span>
            {m.name} {m.drugClass ? `· ${m.drugClass}` : ''}
          </span>
          <Button
            type="button"
            onClick={() => {
              onSelect(m.id, m.name);
              setRows([]);
            }}
          >
            {t('medicineImport.useTarget', { name: m.name })}
          </Button>
        </div>
      ))}
      <p className="text-sm">{t('medicineImport.targetHint')}</p>
    </div>
  );
}
