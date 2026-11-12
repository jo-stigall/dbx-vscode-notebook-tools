/**
 * Keep results in memory, so that the same request does not run a second query.
 *
 * The cache holds results only. It holds no rows of a table, and it writes
 * nothing to the disk.
 */
import type { ProfileOptions, Profiler } from './profiler.ts';
import type { Request, Result } from './schema.ts';

/** The size limit of a CachingProfiler, and how it finds the workspace of a profile. */
export interface CacheOptions {
  /**
   * The largest size of all results together, in characters of JSON. Default: 20 million.
   * When the cache is larger, it deletes the results that no request used for the longest time.
   */
  maxSize?: number;
  /**
   * Returns the workspace URL of a profile. The URL is part of the key, so
   * that two profiles for the same workspace share results, and one profile
   * name on two workspaces does not.
   */
  hostOf: (profile: string) => string;
}

/** 20 million characters: about 40 MB of memory. One result is some thousand characters. */
const DEFAULT_MAX_SIZE = 20_000_000;

/**
 * A profiler that answers from memory when it can.
 *
 * The key of a result is the workspace URL plus the full request: the table,
 * the version, the filter, the sample, the request type and its parameters.
 * Thus a request with a different filter or a different number of bins runs
 * a new query.
 *
 * @example
 * const profiler = new CachingProfiler(new SqlProfiler(...), { hostOf: () => 'https://adb-1.azuredatabricks.net' });
 * await profiler.profile(request);                      // runs a query
 * await profiler.profile(request);                      // no query
 * await profiler.profile(request, { refresh: true });   // runs a query and replaces the stored result
 */
export class CachingProfiler implements Profiler {
  /**
   * The stored results and the size of each, by key.
   * A Map keeps its keys in the sequence in which the code added them. Thus
   * the first key is the result that no request used for the longest time.
   */
  private readonly entries = new Map<string, { result: Result; size: number }>();
  /** The number of characters of all stored keys and results together. */
  private size = 0;
  /** The profiler that runs the query when the cache has no result. */
  private readonly inner: Profiler;
  /** The largest permitted `size`. See CacheOptions. */
  private readonly maxSize: number;
  /** Returns the workspace URL of a profile. See CacheOptions. */
  private readonly hostOf: (profile: string) => string;
  /** The number of requests that the cache answered, and the number that went to the inner profiler. Tests read these. */
  hits = 0;
  misses = 0;

  /**
   * Make an empty cache.
   *
   * @param inner  The profiler that runs the query when the cache has no result.
   */
  constructor(inner: Profiler, options: CacheOptions) {
    this.inner = inner;
    this.maxSize = options.maxSize ?? DEFAULT_MAX_SIZE;
    this.hostOf = options.hostOf;
  }

  /**
   * Make the key under which the cache stores the result of a request.
   *
   * @example
   * this.key(request)   // '["https://adb-1.azuredatabricks.net",{"type":"tableDetails","dataset":{...}}]'
   *
   * @returns The JSON text of the workspace URL and the request.
   */
  private key(request: Request): string {
    return JSON.stringify([this.hostOf(request.dataset.profile), request]);
  }

  /**
   * Return the stored result of a request. If the cache has none, ask the inner profiler and store its answer.
   *
   * A request that fails stores nothing, so the same request runs a query again.
   *
   * @param options.refresh  true: do not use the stored result. Ask the inner profiler and replace the stored result.
   */
  async profile(request: Request, options: ProfileOptions = {}): Promise<Result> {
    const key = this.key(request);
    const found = options.refresh ? undefined : this.entries.get(key);
    if (found) {
      // Move the entry to the end: it is now the most recently used.
      this.entries.delete(key);
      this.entries.set(key, found);
      this.hits++;
      return found.result;
    }
    this.misses++;
    const result = await this.inner.profile(request, options);
    this.store(key, result);
    return result;
  }

  /**
   * Store a result. Then delete the oldest results until the cache is not larger than `maxSize`.
   *
   * The method does not keep a result that alone is larger than `maxSize`.
   */
  private store(key: string, result: Result): void {
    const old = this.entries.get(key);
    if (old) {
      this.size -= old.size;
      this.entries.delete(key);
    }
    const size = key.length + JSON.stringify(result).length;
    if (size > this.maxSize) return; // One result that is larger than the full cache: do not keep it.
    this.entries.set(key, { result, size });
    this.size += size;
    for (const [oldest, entry] of this.entries) {
      if (this.size <= this.maxSize) break;
      this.entries.delete(oldest);
      this.size -= entry.size;
    }
  }

  /** Delete all results. */
  clear(): void {
    this.entries.clear();
    this.size = 0;
  }
}
