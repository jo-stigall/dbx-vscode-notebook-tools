/** React hooks for compare mode: the drift of each pair of columns, and results that need more than one request. */
import { useEffect, useMemo, useState } from 'react';
import { columnDrift, compareKind, type Ask, type CompareKind } from '../../core/compare.ts';
import type { Drift } from '../../core/drift.ts';
import type { ColumnPair } from '../../core/match.ts';
import type { Dataset } from '../../core/schema.ts';
import type { OverviewState } from '../Overview.tsx';
import { acquire, useRequests, type RequestError } from '../rpc.ts';

/** Sends a request to the host. The requests of compare mode stay until the next "Refresh". */
export const ask: Ask = (request) => acquire(request);

/**
 * The drift of one pair: not known yet, known, not compared, or failed.
 *
 * If `stale` is true, the drift belongs to the datasets before the last
 * change, and the new drift is not here yet. The page shows it dimmed.
 */
export type DriftState = { status: 'loading' } | { status: 'done'; drift: Drift; kind: CompareKind; stale?: boolean } | { status: 'skip' } | { status: 'error'; error: RequestError };

/** Mark each drift as old. A state that has no drift becomes "loading". */
function asStale(values: Map<string, DriftState>): Map<string, DriftState> {
  const out = new Map<string, DriftState>();
  for (const [name, value] of values) out.set(name, value.status === 'done' ? { ...value, stale: true } : { status: 'loading' });
  return out;
}

/** The drift computations that run or are done, by their inputs as text. Two components that need the same drift share one computation. */
const drifts = new Map<string, Promise<Drift | undefined>>();

/**
 * Get the drift of each pair of columns.
 *
 * The hook starts the computation of a pair when the overview numbers of
 * its two columns are here. It never runs the same computation two times.
 *
 * When a dataset changes, the hook keeps the drift of each pair, with
 * `stale: true`, until the new drift of that pair is here. The rows of the
 * table then keep their sequence.
 *
 * @param asText  The names of the columns of A that the user chose to compare as text.
 * @returns Column name of A -> the state of its drift.
 */
export function useDrifts(a: Dataset, b: Dataset, pairs: ColumnPair[], overviewA: OverviewState, overviewB: OverviewState, asText: string[]): Map<string, DriftState> {
  const { generation } = useRequests();
  const [state, setState] = useState<{ base: string; values: Map<string, DriftState> }>({ base: '', values: new Map() });
  const base = JSON.stringify([a, b, generation]);
  // The pairs whose numbers are here, as text. The effect runs again when more numbers arrive.
  const ready = pairs
    .filter((pair) => overviewA.stats.has(pair.a.name) && overviewB.stats.has(pair.b.name))
    .map((pair) => `${pair.a.name}:${pair.b.name}:${asText.includes(pair.a.name)}`)
    .join('|');

  useEffect(() => {
    let current = true;
    const set = (name: string, value: DriftState) =>
      current && setState((prev) => ({ base, values: new Map(prev.base === base ? prev.values : asStale(prev.values)).set(name, value) }));
    for (const pair of pairs) {
      const statsA = overviewA.stats.get(pair.a.name);
      const statsB = overviewB.stats.get(pair.b.name);
      if (!statsA || !statsB || overviewA.rowCount === undefined || overviewB.rowCount === undefined) continue;
      const kind = compareKind(pair, statsA, statsB, asText.includes(pair.a.name));
      if (kind === 'skip') {
        set(pair.a.name, { status: 'skip' });
        continue;
      }
      const key = JSON.stringify([base, pair.a, pair.b, kind]);
      let promise = drifts.get(key);
      if (!promise) {
        promise = columnDrift(ask, a, b, pair, kind, overviewA.rowCount, statsA, overviewB.rowCount, statsB);
        promise.catch(() => drifts.delete(key));
        drifts.set(key, promise);
      }
      promise.then(
        (drift) => set(pair.a.name, drift ? { status: 'done', drift, kind } : { status: 'skip' }),
        (error: RequestError) => set(pair.a.name, { status: 'error', error })
      );
    }
    return () => {
      current = false;
    };
  }, [base, ready]);
  return useMemo(() => (state.base === base ? state.values : asStale(state.values)), [state, base]);
}

/** The state of a value that an async function computes. */
export type AsyncState<T> = { status: 'loading' } | { status: 'done'; value: T } | { status: 'error'; error: RequestError };

/**
 * Run an async function and get its state. The function runs again when `key` changes or the user clicks "Refresh".
 *
 * @example
 * const frequency = useAsync(JSON.stringify([a, b, pair]), () => comparedFrequency(ask, a, b, pair, 200));
 */
export function useAsync<T>(key: string, run: () => Promise<T>): AsyncState<T> {
  const { generation } = useRequests();
  const full = `${key}#${generation}`;
  const [state, setState] = useState<{ key: string; value: AsyncState<T> }>({ key: full, value: { status: 'loading' } });
  useEffect(() => {
    let current = true;
    run().then(
      (value) => current && setState({ key: full, value: { status: 'done', value } }),
      (error: RequestError) => current && setState({ key: full, value: { status: 'error', error } })
    );
    return () => {
      current = false;
    };
  }, [full]);
  return state.key === full ? state.value : { status: 'loading' };
}
