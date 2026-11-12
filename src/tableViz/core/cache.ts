/**
 * Keep results in memory, so that the same request does not run a second query.
 *
 * The cache holds results only. It holds no rows of a table, and it writes
 * nothing to the disk.
 */
import type { ProfileOptions, Profiler } from './profiler.ts';
import type { Request, Result } from './schema.ts';

export interface CacheOptions {
  /** The largest size of all results together, in characters of JSON. When the cache is larger, it deletes the results that were not used for the longest time. */
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
 *
 * @example
 * const profiler = new CachingProfiler(new SqlProfiler(...), { hostOf: () => 'https://adb-1.azuredatabricks.net' });
 * await profiler.profile(request);                      // runs a query
 * await profiler.profile(request);                      // no query
 * await profiler.profile(request, { refresh: true });   // runs a query and replaces the stored result
 */
export class CachingProfiler implements Profiler {
  /** A Map keeps the sequence in which keys were added. The first key is the one that was not used for the longest time. */
  private readonly entries = new Map<string, { result: Result; size: number }>();
  private size = 0;
  private readonly inner: Profiler;
  private readonly maxSize: number;
  private readonly hostOf: (profile: string) => string;
  /** The number of requests that the cache answered, and the number that went to the inner profiler. Tests read these. */
  hits = 0;
  misses = 0;

  constructor(inner: Profiler, options: CacheOptions) {
    this.inner = inner;
    this.maxSize = options.maxSize ?? DEFAULT_MAX_SIZE;
    this.hostOf = options.hostOf;
  }

  private key(request: Request): string {
    return JSON.stringify([this.hostOf(request.dataset.profile), request]);
  }

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
