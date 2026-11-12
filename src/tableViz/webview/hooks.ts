/**
 * React hooks that the board uses.
 *
 * useResult() is the usual way for a component to get numbers from the host.
 * It calls acquire() and release() in rpc.ts. The other hooks keep old
 * numbers on the screen, delay a request, or start a request only when its
 * row is visible.
 */
import { useEffect, useRef, useState, type RefObject } from 'react';
import type { Request, ResultOf } from '../core/schema.ts';
import { acquire, release, useRequests, type Progress, type RequestError } from './rpc.ts';

/**
 * The state of one request: it runs, it has a result, it failed, or the user cancelled it.
 *
 * While it runs, `progress` tells if the query waits for a free place on
 * Databricks or runs.
 *
 * A result has the request that it answers. If `stale` is true, a newer
 * request runs now, and the result is the answer to the request before it.
 * The page shows the old numbers, dimmed, until the new numbers arrive. Thus
 * a chart does not go away and come back each time the user moves a slider
 * or adds a filter.
 */
export type Loadable<T, R = Request> =
  | { status: 'loading'; progress?: Progress }
  | { status: 'done'; result: T; request: R; stale?: boolean }
  | { status: 'error'; error: RequestError }
  | { status: 'cancelled' };

/**
 * Send a request and get its state.
 *
 * The hook sends the request when the component comes on the page, when
 * the request changes, and after a click on "Refresh". When the component
 * leaves the page or asks for a different thing, the hook releases the
 * request. If no other component wants that request and it still runs, the
 * host cancels it.
 *
 * While a new request runs, the hook gives the last result with
 * `stale: true`. Use `state.request` to know which request a result answers.
 *
 * @example
 * const details = useResult({ type: 'tableDetails', dataset });
 * if (details.status === 'done') details.result.columns   // [{ name: 'amount', typeText: 'decimal(10,2)' }, ...]
 *
 * @param req  The request. Pass undefined to send nothing; the state is then the last result (stale), or "loading" if there is none.
 * @returns The state of the request: "loading", "done" with the result, "error" or "cancelled".
 */
export function useResult<T extends Request>(req: T | undefined): Loadable<ResultOf<T['type']>, T> {
  type State = Loadable<ResultOf<T['type']>, T>;
  const { generation } = useRequests();
  // The request as text, plus the number of the last refresh. The effect runs again only when one of them changes.
  const key = (req ? JSON.stringify(req) : '') + '#' + generation;
  const [state, setState] = useState<{ key: string; value: State }>({ key, value: { status: 'loading' } });
  // The last result that arrived, to show while the next request runs.
  const last = useRef<{ result: ResultOf<T['type']>; request: T } | undefined>(undefined);
  useEffect(() => {
    if (!req) return;
    let current = true;
    const onProgress = (progress: Progress) => current && setState({ key, value: { status: 'loading', progress } });
    acquire(req, onProgress).then(
      (result) => {
        if (!current) return;
        last.current = { result, request: req };
        setState({ key, value: { status: 'done', result, request: req } });
      },
      (error: RequestError) => {
        if (!current) return;
        last.current = undefined; // Do not show old numbers below an error.
        setState({ key, value: error.cancelled ? { status: 'cancelled' } : { status: 'error', error } });
      }
    );
    return () => {
      current = false;
      release(req, onProgress);
    };
  }, [key]);

  const value: State = state.key === key ? state.value : { status: 'loading' };
  if (value.status === 'loading' && last.current) return { status: 'done', ...last.current, stale: true };
  return value;
}

/**
 * Get the result of a state only if it answers the newest request.
 *
 * Use it for a result from which a card makes its next request. Example: the
 * edges of a histogram come from the statistics of the column. While new
 * statistics load, the card must not ask for a histogram with the old edges.
 *
 * @example
 * const stats = useResult({ type: 'numericStats', dataset, columns: [amount] });
 * fresh(stats)   // the statistics; undefined while they load, also if `stats` shows the old numbers with `stale: true`
 *
 * @returns The result. undefined if the state has no result, or if the result is stale.
 */
export function fresh<T>(state: Loadable<T, unknown>): T | undefined {
  return state.status === 'done' && !state.stale ? state.result : undefined;
}

/**
 * Get the last value that was not undefined.
 *
 * A card uses it to keep its numbers on the screen while newer numbers load.
 *
 * @example
 * const numbers = useLast(stats);   // `stats` while it is set; the last `stats` while it is undefined
 */
export function useLast<T>(value: T | undefined): T | undefined {
  const last = useRef(value);
  if (value !== undefined) last.current = value;
  return last.current;
}

/**
 * Tell if an element was on the screen at some time.
 *
 * The overview uses this hook to ask for the thumbnail of a column only when
 * its row comes into view. A table with 500 columns then does not send 500
 * requests at the start.
 *
 * "On the screen" includes the 200 pixels above and below the visible part
 * of the page, so a thumbnail starts to load a moment before its row
 * arrives.
 *
 * @example
 * const [ref, seen] = useSeen<HTMLDivElement>();
 * return <div ref={ref}>{seen ? <HistogramThumb ... /> : null}</div>;
 *
 * @returns A ref for the element, and true after the element was visible. The value stays true.
 */
export function useSeen<T extends Element>(): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || seen) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setSeen(true);
      },
      { rootMargin: '200px' }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [seen]);
  return [ref, seen];
}

/**
 * Get a value that changes only after the input was stable for some time.
 *
 * The bins slider uses this hook. The card then asks for a new histogram
 * when the user stops, not for each step of the slider.
 *
 * @example
 * const [bins, setBins] = useState(30);
 * const settled = useDebounced(bins, 300);   // follows `bins` 300 ms later
 *
 * @param ms  How long the input must be stable, in milliseconds.
 */
export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}
