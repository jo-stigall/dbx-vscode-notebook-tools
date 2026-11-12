/**
 * Run a limited number of tasks at the same time. The other tasks wait in a queue.
 *
 * The SQL profiler uses a limiter so that one board does not send 50
 * statements to a warehouse at the same time.
 */
import { CancelledError, type CancelSignal } from './profiler.ts';

interface Waiting {
  start: () => void;
  cancel: () => void;
}

export class Limiter {
  private running = 0;
  private readonly queue: Waiting[] = [];
  private readonly max: () => number;

  /**
   * @param max  The largest number of tasks that run at the same time. A function, so that a change to the setting applies at once.
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

  private next(): void {
    while (this.running < Math.max(1, this.max())) {
      const entry = this.queue.shift();
      if (!entry) return;
      entry.start();
    }
  }
}
