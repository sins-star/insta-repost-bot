import { InputFile } from 'grammy';
import { probe } from './media.js';
import { log } from './logger.js';

/** Telegram accepts at most 10 items in one album. */
export const ALBUM_LIMIT = 10;

export function chunk(items, size = ALBUM_LIMIT) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
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
      const sent = await bot.api.sendVideo(target, new InputFile(item.path), {
        caption: caption || undefined,
        ...meta,
      });
      return [sent.message_id];
    }
    const sent = await bot.api.sendPhoto(target, new InputFile(item.path), {
      caption: caption || undefined,
    });
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
    const sent = await bot.api.sendMediaGroup(target, media);
    messageIds.push(...sent.map((message) => message.message_id));
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
