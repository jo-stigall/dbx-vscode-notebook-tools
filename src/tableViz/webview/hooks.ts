/** React hooks that the board uses. */
import { useEffect, useRef, useState, type RefObject } from 'react';
import type { Request, ResultOf } from '../core/schema.ts';
import { request, RequestError } from './rpc.ts';

/** The state of one request: it runs, it has a result, or it failed. */
export type Loadable<T> = { status: 'loading' } | { status: 'done'; result: T } | { status: 'error'; error: RequestError };

/**
 * Send a request and get its state.
 *
 * @example
 * const details = useResult({ type: 'tableDetails', dataset });
 * if (details.status === 'done') details.result.columns
 *
 * @param req  The request. Pass undefined to send nothing; the state then stays "loading".
 */
export function useResult<T extends Request>(req: T | undefined): Loadable<ResultOf<T['type']>> {
  const key = req ? JSON.stringify(req) : '';
  const [state, setState] = useState<{ key: string; value: Loadable<ResultOf<T['type']>> }>({ key, value: { status: 'loading' } });
  useEffect(() => {
    if (!req) return;
    let current = true;
    request(req).then(
      (result) => current && setState({ key, value: { status: 'done', result } }),
      (error: RequestError) => current && setState({ key, value: { status: 'error', error } })
    );
    return () => {
      current = false;
    };
    // `key` is the request as text, so the effect runs again only when the request changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
