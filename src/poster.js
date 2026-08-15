import { InputFile } from 'grammy';
import { probe } from './media.js';
import { log } from './logger.js';

/** Telegram accepts at most 10 items in one album. */
export const ALBUM_LIMIT = 10;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

/**
 * Retry the transient Telegram failures.
 *
 * A 429 flood limit is routine rather than exceptional and arrives with a
 * `retry_after` saying exactly how long to wait; a 5xx is Telegram having a
 * moment. Neither means the post was wrong, and without this both lose a post
 * that would have succeeded seconds later.
 *
 * A 400 is never retried — that means the request itself is bad.
 *
 * @param retryNetwork Whether a dropped connection is worth retrying. False for
 * anything that SENDS: if the connection dies after Telegram accepted the
 * message but before the reply arrives, retrying posts it to the channel twice,
 * and the Delete button only knows about the second copy. A flood limit and a
 * 5xx both mean the message was not accepted, so those stay retriable.
 */
export async function withRetry(
  fn,
  { attempts = 4, label = 'telegram', baseDelayMs = 1000, maxWaitMs = 60000, retryNetwork = true } = {},
) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      const code = err.error_code;
      const retryAfter = err.parameters?.retry_after;

      const isNetwork = err.name === 'HttpError' || NETWORK_ERROR_CODES.has(err.code);
      // Deliberately NOT "anything without a Telegram error code" — that
      // retried genuine bugs, like a TypeError or a missing local file, four
      // times over with backoff before reporting the same failure.
      const transient =
        code === 429 ||
        (typeof code === 'number' && code >= 500 && code < 600) ||
        (isNetwork && retryNetwork);

      if (!transient || attempt >= attempts - 1) throw err;

      // retry_after is in SECONDS and is capped: Telegram can ask for an hour,
      // and the queue is serial, so an uncapped sleep here stalls every other
      // repost behind it for that whole time.
      const waitMs =
        retryAfter != null
          ? Math.min(retryAfter * 1000 + 1000, maxWaitMs)
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
        { label: 'sendVideo', retryNetwork: false },
      );
      return [sent.message_id];
    }
    const sent = await withRetry(
      () =>
        bot.api.sendPhoto(target, new InputFile(item.path), {
          caption: caption || undefined,
        }),
      { label: 'sendPhoto', retryNetwork: false },
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
        retryNetwork: false,
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
