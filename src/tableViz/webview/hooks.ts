/** React hooks that the board uses. */
import { useEffect, useRef, useState, type RefObject } from 'react';
import type { Request, ResultOf } from '../core/schema.ts';
import { acquire, release, useRequests, type Progress, type RequestError } from './rpc.ts';

/**
 * The state of one request: it runs, it has a result, it failed, or it was cancelled.
 * While it runs, `progress` tells if the query waits for a free place on Databricks or runs.
 */
export type Loadable<T> =
  | { status: 'loading'; progress?: Progress }
  | { status: 'done'; result: T }
  | { status: 'error'; error: RequestError }
  | { status: 'cancelled' };

/**
 * Send a request and get its state.
 *
 * When the component leaves the page or asks for a different thing, the
 * hook releases the request. A request that no component wants is cancelled.
 *
 * @example
 * const details = useResult({ type: 'tableDetails', dataset });
 * if (details.status === 'done') details.result.columns
 *
 * @param req  The request. Pass undefined to send nothing; the state then stays "loading".
 */
export function useResult<T extends Request>(req: T | undefined): Loadable<ResultOf<T['type']>> {
  const { generation } = useRequests();
  // The request as text, plus the number of the last refresh. The effect runs again only when one of them changes.
  const key = (req ? JSON.stringify(req) : '') + '#' + generation;
  const [state, setState] = useState<{ key: string; value: Loadable<ResultOf<T['type']>> }>({ key, value: { status: 'loading' } });
  useEffect(() => {
    if (!req) return;
    let current = true;
    const onProgress = (progress: Progress) => current && setState({ key, value: { status: 'loading', progress } });
    acquire(req, onProgress).then(
      (result) => current && setState({ key, value: { status: 'done', result } }),
      (error: RequestError) => current && setState({ key, value: error.cancelled ? { status: 'cancelled' } : { status: 'error', error } })
    );
    return () => {
      current = false;
      release(req, onProgress);
    };
  }, [key]);
  return state.key === key ? state.value : { status: 'loading' };
}

/**
 * Tell if an element was on the screen at some time.
 *
 * The overview uses this hook to ask for the thumbnail of a column only when
 * its row comes into view. A table with 500 columns then does not send 500
 * requests at the start.
 *
 * @returns A ref for the element, and true after the element was visible.
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
 */
export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}
