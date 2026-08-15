import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { log } from './logger.js';

/**
 * Remembers which channel messages a post produced, so the ❌ Delete button
 * still works after a restart.
 *
 * Telegram callback_data is capped at 64 bytes, which is not enough to carry a
 * chat id plus ten message ids — hence a short key here and the real payload on
 * disk. A JSON file is the right size of tool for this: a few hundred rows,
 * written once per post, read once per button tap.
 */
export class PostStore {
  constructor(dataDir, { keep = 500 } = {}) {
    this.file = path.join(dataDir, 'posts.json');
    this.dataDir = dataDir;
    this.keep = keep;
    this.records = new Map();
    this.writing = Promise.resolve();
  }

  async load() {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      for (const [key, value] of Object.entries(parsed)) this.records.set(key, value);
      // A file grown past the cap otherwise stays fully in memory until the
      // next add() happens to trim it.
      this.#prune();
      log.info(`loaded ${this.records.size} post record(s)`);
    } catch (err) {
      if (err.code !== 'ENOENT') log.warn('could not read post store —', err.message);
    }
  }

  async add(record) {
    const id = crypto.randomBytes(6).toString('base64url');
    this.records.set(id, { ...record, createdAt: Date.now() });
    this.#prune();
    await this.#persist();
    return id;
  }

  get(id) {
    return this.records.get(id);
  }

  async remove(id) {
    if (!this.records.delete(id)) return false;
    await this.#persist();
    return true;
  }

  #prune() {
    if (this.records.size <= this.keep) return;
    const sorted = [...this.records.entries()].sort(
      (a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0),
    );
    for (const [key] of sorted.slice(0, this.records.size - this.keep)) this.records.delete(key);
  }

  /** Writes are serialised so two fast posts cannot interleave into one file. */
  #persist() {
    this.writing = this.writing.then(async () => {
      try {
        await fs.mkdir(this.dataDir, { recursive: true });
        const tmp = `${this.file}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(Object.fromEntries(this.records), null, 2));
        await fs.rename(tmp, this.file);
      } catch (err) {
        // Losing the store costs the Delete button, not the post. Never fatal.
        log.warn('could not persist post store —', err.message);
      }
    });
    return this.writing;
  }
}
