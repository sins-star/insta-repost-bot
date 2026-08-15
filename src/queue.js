import { log } from './logger.js';

/**
 * A strictly serial job queue.
 *
 * Concurrency is 1 on purpose. ffmpeg will happily eat every core and all the
 * RAM on a small free-tier box, so two links pasted back to back must not
 * encode at the same time — the second one waits, and says so.
 */
export class Queue {
  constructor({ limit = 20 } = {}) {
    this.limit = limit;
    this.pending = [];
    this.running = false;
    this.completed = 0;
    this.failed = 0;
  }

  get size() {
    return this.pending.length + (this.running ? 1 : 0);
  }

  /**
   * @returns {{position: number, promise: Promise<any>}} position is 0 when the
   * job starts immediately, so callers can tell the user they are waiting.
   */
  push(job) {
    // Counted against size, not pending: the job currently encoding is still
    // occupying the bot, so a limit of 2 must mean two jobs in the system.
    if (this.size >= this.limit) {
      throw new Error(`queue is full (${this.limit} in progress) — try again shortly`);
    }
    const position = this.size;
    const promise = new Promise((resolve, reject) => {
      this.pending.push({ job, resolve, reject });
      this.#drain();
    });
    return { position, promise };
  }

  async #drain() {
    if (this.running) return;
    const next = this.pending.shift();
    if (!next) return;

    this.running = true;
    try {
      next.resolve(await next.job());
      this.completed += 1;
    } catch (err) {
      this.failed += 1;
      log.error('job failed —', err);
      next.reject(err);
    } finally {
      this.running = false;
      // Yield so a long synchronous rejection handler cannot starve the loop.
      setImmediate(() => this.#drain());
    }
  }
}
