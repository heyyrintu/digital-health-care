import { useCallback, useEffect, useRef, useState } from 'react';

export type Loaded<T> =
  { status: 'loading' } | { status: 'error'; error: unknown } | { status: 'ready'; data: T };

/**
 * Runs `load` on mount and when `deps` change; `reload` runs it again. Results of a load
 * that was overtaken by a newer one are dropped.
 */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<Loaded<T>>({ status: 'loading' });
  const run = useRef(0);
  // `deps` decide when `load` is a new function, as with useEffect.
  const stable = useCallback(load, deps);

  const reload = useCallback(async () => {
    const id = ++run.current;
    setState((s) => (s.status === 'ready' ? s : { status: 'loading' }));
    try {
      const data = await stable();
      if (id === run.current) setState({ status: 'ready', data });
    } catch (error) {
      if (id === run.current) setState({ status: 'error', error });
    }
  }, [stable]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { state, reload };
}
