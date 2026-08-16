import fs from 'node:fs/promises';
import path from 'node:path';
import { log } from './logger.js';

/**
 * Settings the bot works out for itself at runtime, rather than making someone
 * look them up before it can start.
 *
 * Three things used to have to be known in advance: who the owner is, which
 * channel to post to, and where the logo lives. All three are discoverable from
 * ordinary use — the first person to claim it, the channel it gets added to,
 * and a file sent in chat — so they are discovered and then remembered here.
 *
 * Stored beside the post history in the data volume, so it survives restarts
 * and image rebuilds.
 */
export class RuntimeState {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'runtime.json');
    this.state = {
      adminIds: [],
      channelId: null,
      logoPath: null,
      claimedAt: null,
      /** Every group and channel the owner has added the bot to. */
      destinations: [],
    };
    this.writing = Promise.resolve();
  }

  async load() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.state = { ...this.state, ...parsed };
      if (this.state.adminIds.length) {
        log.info(`runtime: owner claimed (${this.state.adminIds.join(', ')})`);
      }
      if (this.state.channelId) log.info(`runtime: channel remembered (${this.state.channelId})`);
    } catch (err) {
      if (err.code !== 'ENOENT') log.warn('could not read runtime state —', err.message);
    }
  }

  get adminIds() {
    return this.state.adminIds;
  }

  get channelId() {
    return this.state.channelId;
  }

  get logoPath() {
    return this.state.logoPath;
  }

  get isClaimed() {
    return this.state.adminIds.length > 0;
  }

  async claim(userId) {
    if (this.isClaimed) return false;
    this.state.adminIds = [userId];
    this.state.claimedAt = Date.now();
    await this.#persist();
    log.info(`runtime: claimed by ${userId}`);
    return true;
  }

  get destinations() {
    return this.state.destinations;
  }

  hasDestination(chatId) {
    return this.state.destinations.some((d) => String(d.id) === String(chatId));
  }

  /** @returns {boolean} false when this chat was already on the list. */
  async addDestination({ id, title, type, addedBy }) {
    if (this.hasDestination(id)) return false;
    this.state.destinations.push({ id, title, type, addedBy, addedAt: Date.now() });
    await this.#persist();
    log.info(`runtime: now posting to "${title}" (${id})`);
    return true;
  }

  async removeDestination(chatId) {
    const before = this.state.destinations.length;
    this.state.destinations = this.state.destinations.filter(
      (d) => String(d.id) !== String(chatId),
    );
    if (this.state.destinations.length === before) return false;
    await this.#persist();
    log.info(`runtime: no longer posting to ${chatId}`);
    return true;
  }

  async setChannel(channelId) {
    this.state.channelId = channelId;
    await this.#persist();
    log.info(`runtime: channel set to ${channelId}`);
  }

  async setLogo(logoPath) {
    this.state.logoPath = logoPath;
    await this.#persist();
    log.info(`runtime: logo set to ${logoPath}`);
  }

  #persist() {
    this.writing = this.writing.then(async () => {
      try {
        await fs.mkdir(this.dataDir, { recursive: true });
        const tmp = `${this.file}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(this.state, null, 2));
        await fs.rename(tmp, this.file);
      } catch (err) {
        // Losing this costs the remembered settings, never a post in flight.
        log.error('could not save runtime state —', err.message);
      }
    });
    return this.writing;
  }
}
