/**
 * React hooks for compare mode: the drift of each pair of columns, and results that need more than one request.
 *
 * The functions in core/compare.ts decide which requests a comparison
 * needs. They get a function `ask` that sends one request. This file makes
 * that `ask` from hold() in rpc.ts, and it releases the requests when the
 * board does not need their answers any more.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { columnDrift, compareKind, type Ask, type CompareKind } from '../../core/compare.ts';
import type { Drift } from '../../core/drift.ts';
import type { ColumnPair } from '../../core/match.ts';
import type { Dataset } from '../../core/schema.ts';
import type { OverviewState } from '../Overview.tsx';
import { hold, RequestError, useRequests } from '../rpc.ts';

/**
 * The requests of one computation, for example the drift of one pair of columns.
 *
 * A computation asks with `scope.ask`. When no component wants its answer
 * any more, `scope.close()` releases all its requests. The host then cancels
 * a request that still runs, and the query stops on Databricks. A request
 * that is done keeps its answer until the next "Refresh", so the same
 * question later sends no new query.
 *
 * @example
 * const scope = new Scope();
 * comparedFrequency(scope.ask, a, b, pair, 200).then(show);
 * // The user changes dataset B before the answer is here:
 * scope.close();   // the queries of this computation stop
 */
export class Scope {
  /** One function for each request that this computation sent. A call tells rpc.ts that the computation does not want the answer. */
  private releases: (() => void)[] = [];
  /** true after close(). */
  private closed = false;

  /** Send a request for this computation. After close(), the function sends nothing and fails with "Cancelled.". */
  readonly ask: Ask = (request) => {
    if (this.closed) return Promise.reject(new RequestError('Cancelled.', { cancelled: true }));
    const held = hold(request);
    this.releases.push(held.release);
    return held.promise;
  };

  /** Release all requests of this computation. A second call does nothing. */
  close(): void {
    this.closed = true;
    const releases = this.releases;
    this.releases = [];
    releases.forEach((release) => release());
  }
}

/**
 * The drift of one pair: not known yet, known, not compared, or failed.
 *
 * If `stale` is true, the drift belongs to the datasets before the last
 * change, and the new drift is not here yet. The page shows it dimmed.
 */
export type DriftState = { status: 'loading' } | { status: 'done'; drift: Drift; kind: CompareKind; stale?: boolean } | { status: 'skip' } | { status: 'error'; error: RequestError };

/**
 * Mark each drift as old. A state that has no drift becomes "loading".
 *
 * @example
 * asStale(new Map([['amount', { status: 'done', drift, kind: 'continuous' }], ['notes', { status: 'skip' }]]))
 * // Map { 'amount' => { status: 'done', drift, kind: 'continuous', stale: true }, 'notes' => { status: 'loading' } }
 */
function asStale(values: Map<string, DriftState>): Map<string, DriftState> {
  const out = new Map<string, DriftState>();
  for (const [name, value] of values) out.set(name, value.status === 'done' ? { ...value, stale: true } : { status: 'loading' });
  return out;
}

/** The text that identifies a dataset: its table, login, filter, chips, sample and version. */
const datasetKey = (dataset: Dataset) => JSON.stringify(dataset);

/**
 * The requests of the drift hook, by dataset.
 *
 * The hook keeps each request while the board shows its dataset. When a
 * dataset changes, the hook releases the requests on the old dataset, and
 * the host cancels those that still run. The requests on the other dataset
 * stay: the drifts of the new datasets need them again.
 *
 * @example
 * const holds = new DatasetHolds();
 * holds.show([a, b]);
 * columnDrift(holds.ask, a, b, pair, 'continuous', ...);   // asks for the deciles of A, then the bins of A and B
 * holds.show([a, b2]);   // the user changed B: the queries on b stop, the deciles of A continue
 */
export class DatasetHolds {
  /** The key of a dataset -> one release function for each request that the hook sent on that dataset. */
  private readonly groups = new Map<string, (() => void)[]>();
  /** The keys of the datasets that the board shows now. */
  private shown = new Set<string>();

  /** Tell which datasets the board shows now. Release the requests on all other datasets. */
  show(datasets: Dataset[]): void {
    this.shown = new Set(datasets.map(datasetKey));
    for (const [key, releases] of this.groups) {
      if (this.shown.has(key)) continue;
      this.groups.delete(key);
      releases.forEach((release) => release());
    }
  }

  /** Send a request. If the board does not show the dataset of the request, the function sends nothing and fails with "Cancelled.". */
  readonly ask: Ask = (request) => {
    const key = datasetKey(request.dataset);
    if (!this.shown.has(key)) return Promise.reject(new RequestError('Cancelled.', { cancelled: true }));
    const held = hold(request);
    const releases = this.groups.get(key) ?? [];
    releases.push(held.release);
    this.groups.set(key, releases);
    return held.promise;
  };

  /** Release all requests. Use it when the board leaves the page. */
  close(): void {
    this.show([]);
  }
}

/**
 * Get the drift of each pair of columns.
 *
 * The hook starts the computation of a pair when the overview numbers of
 * its two columns are here. The computations share their requests, so the
 * hook never sends the same query two times.
 *
 * When a dataset changes, the hook releases the requests on the old
 * dataset, and the host cancels those that still run. See DatasetHolds.
 * The hook also starts all computations again after a click on "Refresh".
 *
 * When a dataset changes, the hook keeps the drift of each pair, with
 * `stale: true`, until the new drift of that pair is here. The rows of the
 * table then keep their sequence.
 *
 * @example
 * const drifts = useDrifts(a, b, schema.pairs, overviewA, overviewB, []);
 * drifts.get('amount')   // { status: 'done', drift: { score: 0.31, psi: 0.42, ... }, kind: 'continuous' }
 * drifts.get('notes')    // { status: 'skip' }: string in A and int in B, and the user did not select "Compare as text"
 * drifts.get('region')   // undefined: the overview numbers of `region` are not here yet
 *
 * @param pairs  The columns that A and B have, from matchColumns() in core/match.ts.
 * @param overviewA  The overview numbers of A. The computation of a pair needs them to select how to compare the pair.
 * @param overviewB  The overview numbers of B.
 * @param asText  The names of the columns of A that the user chose to compare as text.
 * @returns Column name of A -> the state of its drift. A pair that did not start yet has no entry.
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

  const holds = useRef<DatasetHolds>(new DatasetHolds());
  useEffect(() => {
    let current = true;
    // Release the requests on a dataset that the board does not show any more.
    holds.current.show([a, b]);
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
      columnDrift(holds.current.ask, a, b, pair, kind, overviewA.rowCount, statsA, overviewB.rowCount, statsB).then(
        (drift) => set(pair.a.name, drift ? { status: 'done', drift, kind } : { status: 'skip' }),
        (error: RequestError) => set(pair.a.name, { status: 'error', error })
      );
    }
    return () => {
      current = false;
    };
  }, [base, ready]);
  // When the board leaves the page, release all requests. Their queries that still run stop.
  useEffect(() => () => holds.current.close(), []);
  return useMemo(() => (state.base === base ? state.values : asStale(state.values)), [state, base]);
}

/** The state of a value that an async function computes: not known yet, known, or failed. See useAsync(). */
export type AsyncState<T> = { status: 'loading' } | { status: 'done'; value: T } | { status: 'error'; error: RequestError };

/**
 * Run an async function and get its state. The function runs again when `key` changes or the user clicks "Refresh".
 *
 * The function gets an `ask` that sends its requests. When `key` changes or
 * the component leaves the page, the hook releases the requests of the last
 * run. The host then cancels a request that still runs and that the new
 * run does not need.
 *
 * @example
 * const frequency = useAsync(JSON.stringify([a, b, pair]), (ask) => comparedFrequency(ask, a, b, pair, 200));
 * if (frequency.status === 'done') frequency.value.a.values   // [{ value: 'web', count: 60352 }, ...]
 *
 * @param key  Text that identifies the inputs of `run`. The hook does not look at `run` itself to decide if it must run again.
 * @param run  The async function. It must send its requests with the `ask` that it gets.
 * @returns "loading" while the function runs, then "done" with its value, or "error".
 */
export function useAsync<T>(key: string, run: (ask: Ask) => Promise<T>): AsyncState<T> {
  const { generation } = useRequests();
  const full = `${key}#${generation}`;
  const [state, setState] = useState<{ key: string; value: AsyncState<T> }>({ key: full, value: { status: 'loading' } });
  // The scope of the last run. The next run sends its requests first and then closes this scope,
  // so a request that both runs need continues: the host does not cancel it.
  const last = useRef<Scope | undefined>(undefined);
  useEffect(() => {
    let current = true;
    const scope = new Scope();
    run(scope.ask).then(
      (value) => current && setState({ key: full, value: { status: 'done', value } }),
      (error: RequestError) => current && setState({ key: full, value: { status: 'error', error } })
    );
    last.current?.close();
    last.current = scope;
    return () => {
      current = false;
    };
  }, [full]);
  useEffect(
    () => () => {
      last.current?.close();
      last.current = undefined;
    },
    []
  );
  return state.key === full ? state.value : { status: 'loading' };
}
