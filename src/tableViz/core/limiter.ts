/**
 * Run a limited number of tasks at the same time. The other tasks wait in a queue.
 *
 * The SQL profiler uses a limiter so that one board does not send 50
 * statements to a warehouse at the same time.
 */
import { CancelledError, type CancelSignal } from './profiler.ts';

/** One task that waits in the queue of a limiter. */
interface Waiting {
  /** Starts the task. The limiter calls it when a place is free. */
  start: () => void;
  /** Removes the task from the queue and makes its promise fail with a CancelledError. */
  cancel: () => void;
}

/**
 * Runs at most `max()` tasks at the same time. A task that finds no free place waits in a queue.
 *
 * The tasks start in the sequence in which they came. If `max()` returns
 * less than 1, the limiter uses 1.
 *
 * @example
 * const limiter = new Limiter(() => 2);
 * const jobs = statements.map((statement) => limiter.run(() => runner.run(statement)));
 * // Two statements run. limiter.waiting is statements.length - 2.
 * const results = await Promise.all(jobs);
 */
export class Limiter {
  /** The number of tasks that run now. */
  private running = 0;
  /** The tasks that wait, oldest first. */
  private readonly queue: Waiting[] = [];
  /** Returns the largest number of tasks that can run at the same time. */
  private readonly max: () => number;

  /**
   * Make a limiter with an empty queue.
   *
   * @param max  Returns the largest number of tasks that can run at the same time. The limiter calls it each time a task
   *   comes or ends. Thus a change to the setting applies at once.
   */
  constructor(max: () => number) {
    this.max = max;
  }

  /** The number of tasks that wait. */
  get waiting(): number {
    return this.queue.length;
  }

  /**
   * Run a task when a place is free.
   *
   * If the signal fires while the task waits, the task never starts, and the
   * returned promise fails with a CancelledError. A task that already runs
   * must watch the signal itself.
   *
   * @example
   * const limiter = new Limiter(() => 4);
   * const rows = await limiter.run(() => runner.run(statement, { signal }), signal);
   *
   * @param onQueued  The limiter calls this function if the task must wait.
   */
  run<T>(task: () => Promise<T>, signal?: CancelSignal, onQueued?: () => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.running++;
        task()
          .then(resolve, reject)
          .finally(() => {
            this.running--;
            this.next();
          });
      };
      if (signal?.aborted) {
        reject(new CancelledError());
        return;
      }
      if (this.running < Math.max(1, this.max())) {
        start();
        return;
      }
      const entry: Waiting = {
        start,
        cancel: () => {
          const i = this.queue.indexOf(entry);
          if (i >= 0) {
            this.queue.splice(i, 1);
            reject(new CancelledError());
          }
        },
      };
      this.queue.push(entry);
      signal?.addEventListener('abort', entry.cancel);
      onQueued?.();
    });
  }

  /** Start tasks from the queue until `max()` tasks run or the queue is empty. The limiter calls it each time a task ends. */
  private next(): void {
    while (this.running < Math.max(1, this.max())) {
      const entry = this.queue.shift();
      if (!entry) return;
      entry.start();
    }
  }
}
