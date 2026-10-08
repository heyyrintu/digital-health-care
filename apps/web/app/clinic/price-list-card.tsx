'use client';

import { ApiError } from '@dhc/api-client';
import { PriceList, PriceListItem } from '@dhc/contracts';
import { formatInr, rupeesToPaise } from '@dhc/domain';
import { Button, Input } from '@dhc/ui-web';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useSession } from './session-provider';

const ROW = 'flex flex-wrap items-center gap-x-3 gap-y-2 py-3';
const PILL = 'rounded-full bg-accent px-2.5 py-0.5 text-xs font-semibold text-accent-foreground';
const LABEL = 'block text-sm font-medium';

/** Clinic admin: the price list bills draw on (PRD §5.6). Items are deactivated, never deleted. */
export function PriceListCard() {
  const { api, locale, signOut, t } = useSession();
  const [items, setItems] = useState<PriceListItem[] | null>(null);
  const [repricing, setRepricing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setItems((await api.request('GET', '/price-list', { schema: PriceList })).data);
  }, [api]);

  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) return void signOut('expired');
      setError(e instanceof ApiError ? e.message : t('error.network'));
    },
    [signOut, t],
  );

  useEffect(() => {
    load().catch(fail);
  }, [load, fail]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    void run(async () => {
      await api.request('POST', '/price-list', {
        schema: PriceListItem,
        body: {
          name: String(data.get('name') ?? ''),
          pricePaise: rupeesToPaise(Number(data.get('price'))),
        },
      });
      await load();
      form.reset();
    });
  }

  const update = (item: PriceListItem, body: { pricePaise?: number; active?: boolean }) =>
    run(async () => {
      await api.request('PATCH', `/price-list/${item.id}`, { schema: PriceListItem, body });
      await load();
      if (body.pricePaise !== undefined) {
        setRepricing(null);
        setNotice(t('billing.priceSaved'));
      }
    });

  return (
    <section aria-labelledby="price-list-title" className="surface p-4 sm:p-6">
      <h2 id="price-list-title" className="font-display text-lg font-bold">
        {t('billing.priceListTitle')}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">{t('billing.priceListHint')}</p>

      {items && items.length === 0 && <p className="mt-4">{t('billing.noItems')}</p>}
      {items && items.length > 0 && (
        <ul className="mt-3 divide-y divide-border/70">
          {items.map((item) => (
            <li key={item.id} data-testid={`price-${item.name}`} className={ROW}>
              <strong>{item.name}</strong>
              <span className="tabular text-sm text-muted-foreground">
                {formatInr(item.pricePaise, locale)}
              </span>
              {!item.active && <span className={PILL}>{t('practice.inactive')}</span>}
              <span className="ml-auto flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setRepricing(repricing === item.id ? null : item.id)}
                >
                  {t('billing.reprice')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void update(item, { active: !item.active })}
                >
                  {item.active ? t('practice.deactivate') : t('practice.activate')}
                </Button>
              </span>
              {repricing === item.id && (
                <form
                  className="flex w-full flex-wrap items-end gap-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const price = Number(new FormData(e.currentTarget).get('price'));
                    void update(item, { pricePaise: rupeesToPaise(price) });
                  }}
                >
                  <div className="w-full space-y-1.5 sm:w-48">
                    <label className={LABEL} htmlFor={`reprice-${item.id}`}>
                      {t('billing.newPrice', { name: item.name })}
                    </label>
                    <Input
                      id={`reprice-${item.id}`}
                      name="price"
                      type="number"
                      min={0.01}
                      max={100000}
                      step="0.01"
                      required
                      defaultValue={item.pricePaise / 100}
                    />
                  </div>
                  <Button type="submit" disabled={busy}>
                    {t('billing.savePrice')}
                  </Button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}

      <form className="mt-4 grid items-end gap-3 sm:grid-cols-2" onSubmit={add}>
        <div className="space-y-1.5">
          <label className={LABEL} htmlFor="price-name">
            {t('billing.itemName')}
          </label>
          <Input id="price-name" name="name" required maxLength={80} />
        </div>
        <div className="space-y-1.5">
          <label className={LABEL} htmlFor="price-amount">
            {t('billing.itemPrice')}
          </label>
          <Input
            id="price-amount"
            name="price"
            type="number"
            min={0.01}
            max={100000}
            step="0.01"
            required
          />
        </div>
        <Button type="submit" disabled={busy} className="sm:col-span-2 sm:justify-self-start">
          {t('billing.addItem')}
        </Button>
      </form>
      {notice && (
        <p role="status" className="mt-3 rounded-xl bg-success-soft px-4 py-3 text-sm text-success">
          {notice}
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="mt-3 rounded-xl bg-danger-soft px-4 py-3 text-sm font-medium text-destructive"
        >
          {error}
        </p>
      )}
    </section>
  );
}
