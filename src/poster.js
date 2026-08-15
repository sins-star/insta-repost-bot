import { InputFile } from 'grammy';
import { probe } from './media.js';
import { log } from './logger.js';

/** Telegram accepts at most 10 items in one album. */
export const ALBUM_LIMIT = 10;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retry the transient Telegram failures.
 *
 * Two of these are routine rather than exceptional and neither means the post
 * is wrong: 429 is Telegram's flood limit, which arrives with a `retry_after`
 * telling you exactly how long to wait, and a 5xx or a dropped connection is
 * Telegram having a moment. Without this, either one loses a post that would
 * have succeeded seconds later — and on an unattended bot that looks like a bug.
 *
 * A 400 is NOT retried: that means the request itself is wrong, and repeating
 * it just wastes time.
 */
export async function withRetry(fn, { attempts = 4, label = 'telegram', baseDelayMs = 1000 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      const code = err.error_code;
      const retryAfter = err.parameters?.retry_after;
      const transient =
        code === 429 || (code >= 500 && code < 600) || err.name === 'HttpError' || !code;

      if (!transient || attempt >= attempts - 1) throw err;

      const waitMs = retryAfter
        ? (retryAfter + 1) * baseDelayMs
        : Math.min(30 * baseDelayMs, 2 ** attempt * baseDelayMs);
      log.warn(
        `${label}: ${err.description || err.message} — retrying in ${Math.round(waitMs / 1000)}s ` +
          `(attempt ${attempt + 2}/${attempts})`,
      );
      await sleep(waitMs);
    }
  }
}

export function chunk(items, size = ALBUM_LIMIT) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));

  // Telegram accepts 2–10 items in an album, never 1. An 11-item carousel
  // splits naively into [10, 1] and that trailing single is rejected outright —
  // after the first ten are already live in the channel. Borrow one from the
  // previous group so the tail is always a legal album.
  const last = out[out.length - 1];
  if (out.length > 1 && last.length === 1) {
    last.unshift(out[out.length - 2].pop());
  }
  return out;
}

/**
 * Telegram renders a video inline — with a thumbnail and a scrubber — only when
 * it is told the dimensions and duration up front. Without them the same file
 * arrives as a grey document tile, which is the single most common way a
 * working repost bot still looks broken.
 */
async function videoMeta(item, config) {
  try {
    const info = item.info || (await probe(item.path, { ffprobePath: config.ffprobePath }));
    return {
      width: info.width || undefined,
      height: info.height || undefined,
      duration: info.duration || undefined,
      supports_streaming: true,
    };
  } catch (err) {
    log.warn('could not probe video for upload metadata —', err.message);
    return { supports_streaming: true };
  }
}

/**
 * Send the finished media to the channel.
 *
 * @returns {Promise<number[]>} the channel message ids, in order, so the
 * Delete button can take the whole post down including every album item.
 */
export async function postToChannel(bot, config, { items, caption }) {
  const target = config.channelId;

  if (items.length === 1) {
    const [item] = items;
    if (item.type === 'video') {
      const meta = await videoMeta(item, config);
      const sent = await withRetry(
        () =>
          bot.api.sendVideo(target, new InputFile(item.path), {
            caption: caption || undefined,
            ...meta,
          }),
        { label: 'sendVideo' },
      );
      return [sent.message_id];
    }
    const sent = await withRetry(
      () =>
        bot.api.sendPhoto(target, new InputFile(item.path), {
          caption: caption || undefined,
        }),
      { label: 'sendPhoto' },
    );
    return [sent.message_id];
  }

  const messageIds = [];
  const groups = chunk(items);
  for (const [groupIndex, group] of groups.entries()) {
    const media = [];
    for (const [index, item] of group.entries()) {
      // Only the very first item carries the caption; Telegram shows an album's
      // caption from its first element and repeating it looks like a bug.
      const isFirstOverall = groupIndex === 0 && index === 0;
      const shared = {
        media: new InputFile(item.path),
        caption: isFirstOverall && caption ? caption : undefined,
      };
      if (item.type === 'video') {
        media.push({ type: 'video', ...shared, ...(await videoMeta(item, config)) });
      } else {
        media.push({ type: 'photo', ...shared });
      }
    }
    try {
      const sent = await withRetry(() => bot.api.sendMediaGroup(target, media), {
        label: 'sendMediaGroup',
      });
      messageIds.push(...sent.map((message) => message.message_id));
    } catch (err) {
      // A multi-group album that fails half way has already put real messages
      // in the channel. Carry those ids out on the error so the caller can still
      // offer a Delete button instead of leaving a half-posted album behind with
      // no way to take it down.
      err.partialMessageIds = messageIds;
      throw err;
    }
  }
  return messageIds;
}

/**
 * Take a post back down. Reports per-message success because Telegram refuses
 * to delete a channel message older than 48 hours, and the admin needs to know
 * that is why the button did nothing.
 */
export async function deletePost(bot, chatId, messageIds) {
  let deleted = 0;
  const errors = [];
  for (const id of messageIds) {
    try {
      await bot.api.deleteMessage(chatId, id);
      deleted += 1;
    } catch (err) {
      errors.push(err.description || err.message);
    }
  }
  return { deleted, total: messageIds.length, errors };
}
