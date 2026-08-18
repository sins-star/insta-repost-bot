import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { Bot, InlineKeyboard, webhookCallback, GrammyError, HttpError } from 'grammy';

import { loadConfig, ConfigError } from './config.js';
import { log, redactSecret } from './logger.js';
import { findInstagramUrls, download, buildCaption, DownloadError } from './instagram.js';
import { applyWatermark, ensureUnderLimit } from './watermark.js';
import { broadcast, deletePost } from './poster.js';
import { Queue } from './queue.js';
import { PostStore } from './store.js';
import { RuntimeState } from './runtime.js';
import { createDispatcher } from './dispatch.js';
import { cleanCaption } from './clean.js';
import { run } from './media.js';
import {
  sweepTemp,
  freeSpaceMb,
  updateDownloader,
  startMaintenance,
  selfCheck,
} from './maintenance.js';

const startedAt = Date.now();

function uptime() {
  const seconds = Math.floor((Date.now() - startedAt) / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * Edit a status message, swallowing failures.
 *
 * Progress updates are a courtesy; a failed edit (message deleted, identical
 * text, Telegram hiccup) must never abort a job that is otherwise fine.
 */
async function setStatus(ctx, messageId, text, extra = {}) {
  try {
    await ctx.api.editMessageText(ctx.chat.id, messageId, text, extra);
  } catch (err) {
    if (!String(err.description || '').includes('message is not modified')) {
      log.debug('status edit failed —', err.description || err.message);
    }
  }
}

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`\n✖ Configuration problem: ${err.message}\n\n`);
      process.stderr.write('Copy .env.example to .env and fill it in, then start again.\n');
      process.exit(1);
    }
    throw err;
  }

  redactSecret(config.botToken);
  await fs.mkdir(config.tmpDir, { recursive: true });
  await fs.mkdir(config.dataDir, { recursive: true });

  // Anything left behind by a container that died mid-job. Runs before the
  // first download so a full disk is fixed rather than merely reported.
  await sweepTemp(config).catch(() => {});

  // On serverless the filesystem — and any update written to it — evaporates
  // at scale-to-zero, and a multi-minute pip run inside a cold start would eat
  // the whole "first link after a quiet spell" budget. Updates there happen on
  // download failure instead, where they actually persist for the retry.
  if (config.ytdlpAutoUpdate && !config.serverless) await updateDownloader(config);

  if (config.watermark.defaultedToNone) {
    log.warn(
      'no watermark configured yet — send the bot a logo as a file, or set ' +
        'WATERMARK_TEXT. Posts go out unwatermarked until then.',
    );
  }

  if (config.cover.logoMissing) {
    log.warn(
      `cover: ${config.watermark.logoPath} not found — covering an existing watermark ` +
        'will blur it out but not stamp the logo. Add the file and restart to enable that.',
    );
  }

  // Anything the bot worked out for itself on a previous run — owner, channel,
  // logo — is folded into config here, so every other file keeps reading plain
  // config and knows nothing about how it got there.
  const runtime = new RuntimeState(config.dataDir);
  await runtime.load();
  if (!config.adminIds.length && runtime.adminIds.length) config.adminIds = runtime.adminIds;
  if (!config.channelId && runtime.channelId) config.channelId = runtime.channelId;
  if (runtime.logoPath) {
    config.watermark.logoPath = runtime.logoPath;
    config.cover.useLogo = true;
    config.cover.logoMissing = false;
    if (config.watermark.mode === 'text') config.watermark.mode = 'logo';
  }

  /**
   * Everywhere the bot posts. An explicit CHANNEL_ID from the environment is
   * treated as a permanent destination; the rest are ones the owner added the
   * bot to, remembered across restarts.
   */
  const destinations = () => {
    const list = runtime.destinations.map((d) => ({ id: d.id, title: d.title }));
    if (config.channelId && !runtime.hasDestination(config.channelId)) {
      list.unshift({ id: config.channelId, title: String(config.channelId) });
    }
    return list;
  };

  const store = new PostStore(config.dataDir);
  await store.load();
  // Forwarded posts staged behind a "Send to channel" button. Own file, small
  // cap: anything the owner never tapped is abandoned, not precious.
  const pendingStore = new PostStore(config.dataDir, { filename: 'pending.json', keep: 100 });
  await pendingStore.load();
  const queue = new Queue({ limit: config.queueLimit });

  const bot = new Bot(
    config.botToken,
    config.apiRoot ? { client: { apiRoot: config.apiRoot } } : undefined,
  );

  bot.catch((err) => {
    const e = err.error;
    if (e instanceof GrammyError) log.error('telegram api error —', e.description);
    else if (e instanceof HttpError) log.error('could not reach telegram —', e.message);
    else log.error('unhandled bot error —', e);
  });

  // Registered before the admin gate on purpose: finding your own numeric id is
  // the first thing setup needs, and you cannot be an admin until you have it.
  bot.command('whoami', (ctx) =>
    ctx.reply(
      `Your Telegram user id is <code>${ctx.from?.id}</code>\n\n` +
        'Put that in ADMIN_IDS to let this account post.',
      { parse_mode: 'HTML' },
    ),
  );

  /**
   * Ownership claim.
   *
   * Registered before the admin gate, because by definition nobody is an admin
   * when this runs. Three things keep it from being a way in: it only works
   * while the bot has no owner at all, only inside a window after startup, and
   * the first claim is final.
   */
  bot.command('claim', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    if (config.adminIds.length) {
      const alreadyYours = config.adminIds.includes(userId);
      await ctx.reply(
        alreadyYours
          ? 'You already own this bot. Paste an Instagram link to get going.'
          : 'This bot already has an owner.',
      );
      return;
    }
    if (!config.allowClaim) {
      await ctx.reply('Claiming is switched off. Set ADMIN_IDS and restart.');
      return;
    }

    const openForMs = config.claimWindowMin * 60 * 1000;
    if (Date.now() - startedAt > openForMs) {
      await ctx.reply(
        `The claim window closed ${config.claimWindowMin} minutes after startup. ` +
          'Restart the bot and send /claim again within that time.',
      );
      log.warn(`refused a late claim from ${userId}`);
      return;
    }

    await runtime.claim(userId);
    config.adminIds = runtime.adminIds;
    await ctx.reply(
      '✅ You own this bot now. Only you can add me anywhere.\n\n' +
        'Next: add me to any channel or group you want to post to — I notice ' +
        'automatically, and I post to all of them at once.\n\n' +
        'Then send me your logo as a FILE and I will use it as the watermark.',
    );
  });

  /**
   * Learn where to post by being added there.
   *
   * Telegram sends an update whenever the bot's own membership changes, and it
   * carries both the chat id and WHO changed it. That second part is what makes
   * "only I can add it" enforceable: anyone else who adds the bot gets it back
   * out again immediately.
   *
   * Registered ahead of the admin gate because this legitimately arrives before
   * anyone has claimed the bot.
   */
  bot.on('my_chat_member', async (ctx) => {
    const update = ctx.myChatMember;
    const chat = update.chat;
    const status = update.new_chat_member?.status;
    const actor = update.from?.id;
    const name = chat.title || chat.username || String(chat.id);

    if (!['channel', 'group', 'supergroup'].includes(chat.type)) return;

    // Removed, or demoted below what posting needs.
    if (['left', 'kicked', 'restricted'].includes(status)) {
      if (await runtime.removeDestination(chat.id)) {
        log.info(`removed from "${name}" — no longer posting there`);
      }
      return;
    }

    // A channel needs admin rights to post at all; in a group, membership is enough.
    const canPost = chat.type === 'channel' ? status === 'administrator' : ['administrator', 'member'].includes(status);
    if (!canPost) return;

    // The gate. Once the bot has an owner, only the owner may place it anywhere.
    if (config.adminIds.length && !config.adminIds.includes(actor)) {
      log.warn(`${actor} tried to add the bot to "${name}" — leaving`);
      try {
        await ctx.api.leaveChat(chat.id);
      } catch (err) {
        log.error(`could not leave "${name}" —`, err.description || err.message);
      }
      for (const adminId of config.adminIds) {
        await ctx.api
          .sendMessage(
            adminId,
            `🚫 Someone tried to add me to <b>${name}</b>. I left — only you can add me anywhere.`,
            { parse_mode: 'HTML' },
          )
          .catch(() => {});
      }
      return;
    }

    const added = await runtime.addDestination({
      id: chat.id,
      title: name,
      type: chat.type,
      addedBy: actor,
      username: chat.username || '',
    });
    if (!added) return;

    // Keep the legacy single-channel field in step, so anything still reading
    // config.channelId behaves.
    if (!config.channelId) config.channelId = chat.id;

    const total = destinations().length;
    const where = total === 1 ? '' : ` — that's ${total} places now`;
    for (const adminId of config.adminIds) {
      await ctx.api
        .sendMessage(adminId, `✅ I'll post to <b>${name}</b>${where}.`, { parse_mode: 'HTML' })
        .catch(() => {});
    }
  });

  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (userId && config.adminIds.includes(userId)) return next();
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({ text: 'Not authorised.', show_alert: true });
      return;
    }
    // Only answer strangers in PRIVATE chats. In a group or channel the bot
    // sees every message, and replying "not authorised" to each one would spam
    // the room within minutes.
    if (ctx.message && ctx.chat?.type === 'private') {
      await ctx.reply(
        config.adminIds.length
          ? `Not authorised. Your id is ${userId} — it needs to be in ADMIN_IDS.`
          : 'This bot has no owner yet. Send /claim to take it.',
      );
    }
  });

  const help =
    '<b>Instagram → channel reposter</b>\n\n' +
    'Paste an Instagram reel or post link and I will download it, watermark it, ' +
    'and post it to the channel. Multiple links in one message all get queued.\n\n' +
    '<b>Setting me up</b>\n' +
    '1. /claim — become my owner\n' +
    '2. Add me to any channel or group — I post to all of them at once\n' +
    '3. Send me your logo <i>as a file</i> and I will use it as the watermark\n\n' +
    'Send a new logo any time to replace it.\n\n' +
    '/status — queue, uptime and settings\n' +
    '/whoami — your Telegram id\n' +
    '/help — this message';

  bot.command(['start', 'help'], (ctx) => ctx.reply(help, { parse_mode: 'HTML' }));

  bot.command('status', (ctx) => {
    const wm = config.watermark;
    const detail =
      wm.mode === 'none'
        ? 'off'
        : `${wm.mode}${wm.text ? ` "${wm.text}"` : ''} @ ${wm.position}, ${Math.round(
            wm.opacity * 100,
          )}% opacity`;
    return ctx.reply(
      [
        `Up ${uptime()} · mode ${config.mode}`,
        destinations().length
          ? `Posting to: ${destinations().map((d) => d.title).join(', ')}`
          : 'Posting to: nowhere yet — add me to a channel or group',
        `Queue: ${queue.size} waiting · ${queue.completed} posted · ${queue.failed} failed`,
        `Watermark: ${detail}`,
        `Cover existing: ${
          config.cover.enabled
            ? `on (${config.cover.useLogo ? 'blur + logo' : 'blur only'})`
            : 'off'
        }`,
        `Cookies: ${config.cookiesFile ? 'configured' : 'none'}`,
      ].join('\n'),
    );
  });

  /**
   * The owner's channel @username — the one tag captions are allowed to carry.
   * Resolved once, then remembered on the destination record.
   */
  let cachedOurUsername = null;
  async function ourChannelUsername() {
    if (cachedOurUsername !== null) return cachedOurUsername;
    const stored = runtime.destinations.find((d) => d.username);
    if (stored) return (cachedOurUsername = stored.username);
    const first = destinations()[0];
    if (!first) return (cachedOurUsername = '');
    try {
      const chat = await bot.api.getChat(first.id);
      cachedOurUsername = chat.username || '';
      if (chat.username) await runtime.setDestinationUsername(first.id, chat.username);
    } catch {
      cachedOurUsername = '';
    }
    return cachedOurUsername;
  }

  async function cleanForChannel(text) {
    return cleanCaption(text, {
      keep: [await ourChannelUsername(), bot.botInfo?.username],
    });
  }

  /**
   * Forwarded posts: strip the "Forwarded from" header, scrub the caption,
   * preview, and post only when the owner taps Send.
   *
   * Re-sending by file_id is what removes the header — Telegram only renders
   * it on true forwards — and it needs no download, so any file size works and
   * the whole flow is a handful of API calls.
   */
  const pendingAlbums = new Map();

  async function makePending(items, caption, removed, chatId) {
    const id = await pendingStore.add({ items, caption });
    const what =
      items.length === 0 ? 'text post' : items.length === 1 ? items[0].type : `album of ${items.length}`;
    const notes = removed ? ` · ${removed} foreign link/tag(s) cleaned` : '';
    await bot.api.sendMessage(
      chatId,
      `📋 Ready to post (${what} · forwarded-from removed${notes})\n\n${caption || '(no caption)'}`,
      {
        reply_markup: new InlineKeyboard()
          .text('📤 Send to channel', `send:${id}`)
          .text('🗑 Discard', `x:${id}`),
      },
    );
  }

  async function flushAlbum(groupId) {
    const group = pendingAlbums.get(groupId);
    if (!group) return;
    pendingAlbums.delete(groupId);
    const { text, removed } = await cleanForChannel(group.caption);
    await makePending(group.items, text, removed, group.chatId);
  }

  bot.on('message', async (ctx, next) => {
    const m = ctx.message;
    if (!m.forward_origin) return next();

    const raw = m.text || m.caption || '';
    // A forwarded post carrying an Instagram link goes down the full
    // download-and-watermark pipeline instead.
    if (findInstagramUrls(raw).length) return next();

    const item = m.video
      ? { type: 'video', fileId: m.video.file_id }
      : m.photo
        ? { type: 'photo', fileId: m.photo[m.photo.length - 1].file_id }
        : m.animation
          ? { type: 'animation', fileId: m.animation.file_id }
          : m.document
            ? { type: 'document', fileId: m.document.file_id }
            : null;
    if (!item && !m.text) return; // stickers, polls, contacts: nothing to repost

    // Album items arrive as separate messages sharing a media_group_id; gather
    // them briefly so they preview — and post — as one album. On serverless the
    // wait runs inside a /work request, because a plain timer's CPU is frozen
    // the moment the webhook response goes out.
    if (m.media_group_id && item) {
      let group = pendingAlbums.get(m.media_group_id);
      if (!group) {
        group = { items: [], caption: '', chatId: ctx.chat.id, started: false, timer: null };
        pendingAlbums.set(m.media_group_id, group);
      }
      group.items.push(item);
      if (raw) group.caption = raw;

      if (dispatcher) {
        if (!group.started) {
          group.started = true;
          dispatcher
            .dispatch({ kind: 'album', groupId: m.media_group_id })
            .catch((err) => log.error('could not stage album —', err.message));
        }
      } else {
        clearTimeout(group.timer);
        group.timer = setTimeout(() => {
          flushAlbum(m.media_group_id).catch((err) =>
            log.error('could not stage album —', err.message),
          );
        }, 1500);
      }
      return;
    }

    const { text, removed } = await cleanForChannel(raw);
    await makePending(item ? [item] : [], text, removed, ctx.chat.id);
  });

  /** Post a staged forward to every destination, by file_id — no downloads. */
  async function sendPending(id, ref) {
    const edit = (text, extra = {}) =>
      bot.api.editMessageText(ref.chatId, ref.messageId, text, extra).catch(() => {});

    const rec = pendingStore.get(id);
    if (!rec) return edit('🚫 That one expired — forward it again.');

    const targets = destinations();
    if (!targets.length) {
      return edit('🚫 I have nowhere to post yet — add me to your channel first.');
    }

    const sent = [];
    const failed = [];
    for (const dest of targets) {
      try {
        const ids = [];
        if (!rec.items.length) {
          const msg = await bot.api.sendMessage(dest.id, rec.caption);
          ids.push(msg.message_id);
        } else if (rec.items.length === 1) {
          const item = rec.items[0];
          const method = { video: 'sendVideo', photo: 'sendPhoto', animation: 'sendAnimation', document: 'sendDocument' }[item.type];
          const msg = await bot.api[method](dest.id, item.fileId, {
            caption: rec.caption || undefined,
          });
          ids.push(msg.message_id);
        } else {
          const media = rec.items.slice(0, 10).map((item, index) => ({
            // Albums only ever mix photos and videos.
            type: item.type === 'photo' ? 'photo' : 'video',
            media: item.fileId,
            caption: index === 0 && rec.caption ? rec.caption : undefined,
          }));
          const msgs = await bot.api.sendMediaGroup(dest.id, media);
          ids.push(...msgs.map((msg) => msg.message_id));
        }
        sent.push({ chatId: dest.id, title: dest.title, messageIds: ids });
      } catch (err) {
        failed.push({ title: dest.title, reason: err.description || err.message });
        log.error(`forward-post to "${dest.title}" failed —`, err.description || err.message);
      }
    }

    if (!sent.length) {
      return edit(`🚫 Could not post: ${failed.map((f) => f.reason).join('; ')}`);
    }

    await pendingStore.remove(id);
    const recordId = await store.add({
      targets: sent.map((t) => ({ chatId: t.chatId, messageIds: t.messageIds })),
      postedBy: ref.fromId,
    });
    const where = sent.length === 1 ? sent[0].title : `${sent.length} places`;
    const warn = failed.length ? `\n⚠️ Failed: ${failed.map((f) => f.title).join(', ')}` : '';
    await edit(`✅ Sent to ${where}.${warn}`, {
      reply_markup: new InlineKeyboard().text(
        sent.length === 1 ? '❌ Delete from channel' : '❌ Delete everywhere',
        `del:${recordId}`,
      ),
    });
  }

  /**
   * Set the watermark logo by sending the image to the bot.
   *
   * Accepts a document (keeps transparency) or a photo (Telegram re-encodes
   * photos to JPEG and flattens the alpha channel, so that path warns). The file
   * lands in the data volume, which survives restarts and image rebuilds.
   */
  async function receiveLogo(ctx, { fileId, asPhoto, fileName }) {
    const status = await ctx.reply('⬇️ Saving your logo…');
    try {
      const file = await ctx.api.getFile(fileId);
      if ((file.file_size || 0) > 10 * 1024 * 1024) {
        throw new Error('that file is over 10MB — a watermark should be a few hundred KB');
      }

      // Downloaded by hand rather than with file.download(), which only exists
      // if the @grammyjs/files plugin is installed. This is two lines and one
      // fewer dependency.
      const base = (config.apiRoot || 'https://api.telegram.org').replace(/\/+$/, '');
      const res = await fetch(`${base}/file/bot${config.botToken}/${file.file_path}`);
      if (!res.ok) throw new Error(`Telegram returned ${res.status} for that file`);

      const dest = path.join(config.dataDir, 'watermark.png');
      await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));

      const info = await probeImage(dest);
      await runtime.setLogo(dest);
      config.watermark.logoPath = dest;
      config.cover.useLogo = true;
      config.cover.logoMissing = false;
      if (config.watermark.mode === 'text') config.watermark.mode = 'logo';

      const notes = [];
      if (asPhoto) {
        notes.push(
          '⚠️ Sent as a photo, so Telegram flattened it to JPEG and any ' +
            'transparency is gone. Send it again as a <b>file</b> to keep it.',
        );
      }
      if (info && !info.hasAlpha) {
        notes.push(
          'This image has no transparent background, so I have set ' +
            '<code>WATERMARK_CHROMA_KEY</code> to knock out its backdrop. If the ' +
            'backdrop is not black, tell me its colour.',
        );
        if (!config.watermark.chromaKey) config.watermark.chromaKey = '0x000000';
      }

      await ctx.api.editMessageText(
        ctx.chat.id,
        status.message_id,
        `✅ Logo set${info ? ` — ${info.width}×${info.height}` : ''}. ` +
          `It will appear in the ${config.watermark.position} corner of everything ` +
          `from now on.${notes.length ? `\n\n${notes.join('\n\n')}` : ''}`,
        { parse_mode: 'HTML' },
      );
      log.info(`logo updated from ${fileName || 'chat'}`);
    } catch (err) {
      log.error('could not save the logo —', err.message);
      await setStatus(ctx, status.message_id, `🚫 Could not save that: ${err.message}`);
    }
  }

  async function probeImage(filePath) {
    try {
      const { stdout } = await run(
        config.ffprobePath,
        ['-v', 'error', '-print_format', 'json', '-show_streams', filePath],
        { timeoutMs: 30000 },
      );
      const stream = (JSON.parse(stdout).streams || [])[0] || {};
      return {
        width: Number(stream.width) || 0,
        height: Number(stream.height) || 0,
        // yuva/rgba/argb pixel formats are the ones carrying transparency.
        hasAlpha: /a$|^(yuva|rgba|argb|bgra|abgr|pal8)/.test(stream.pix_fmt || ''),
      };
    } catch {
      return null;
    }
  }

  bot.on('message:document', async (ctx, next) => {
    const doc = ctx.message.document;
    if (!/^image\//.test(doc.mime_type || '') && !/\.(png|jpe?g|webp)$/i.test(doc.file_name || '')) {
      return next();
    }
    await receiveLogo(ctx, { fileId: doc.file_id, asPhoto: false, fileName: doc.file_name });
  });

  bot.on('message:photo', async (ctx, next) => {
    // A forwarded Instagram post arrives as a photo with the link in its
    // caption. That is a repost request, not a new logo.
    if (findInstagramUrls(ctx.message.caption || '').length) return next();
    // The last entry is the largest rendition Telegram kept.
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    await receiveLogo(ctx, { fileId: photo.file_id, asPhoto: true });
  });

  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data || '';

    if (data.startsWith('send:')) {
      await ctx.answerCallbackQuery({ text: 'Sending…' });
      const ref = {
        chatId: ctx.chat.id,
        messageId: ctx.callbackQuery.message.message_id,
        fromId: ctx.from?.id,
      };
      const pendingId = data.slice(5);
      if (dispatcher) {
        // The sends must run inside a /work request on serverless — a callback
        // handler's CPU is frozen the moment its response goes out.
        dispatcher
          .dispatch({ kind: 'pending', pendingId, ...ref })
          .catch((err) => log.error('could not dispatch send —', err.message));
      } else {
        sendPending(pendingId, ref).catch((err) => log.error('send failed —', err.message));
      }
      return;
    }

    if (data.startsWith('x:')) {
      await pendingStore.remove(data.slice(2));
      await ctx.answerCallbackQuery({ text: 'Discarded.' });
      await ctx.editMessageText('🗑 Discarded — nothing was posted.').catch(() => {});
      return;
    }

    if (!data.startsWith('del:')) return ctx.answerCallbackQuery();

    const record = store.get(data.slice(4));
    if (!record) {
      return ctx.answerCallbackQuery({
        text: 'That post is no longer tracked — delete it in the channel.',
        show_alert: true,
      });
    }

    // Posts recorded before multi-destination support used a single chatId.
    const targets = record.targets || [{ chatId: record.chatId, messageIds: record.messageIds }];

    const { deleted, total, errors } = await deletePost(bot, targets);
    if (deleted === total) {
      await store.remove(data.slice(4));
      const where = targets.length === 1 ? 'the channel' : `all ${targets.length} places`;
      await ctx.answerCallbackQuery({ text: 'Deleted.' });
      await ctx.editMessageText(`🗑 Deleted from ${where}.`);
      return;
    }
    log.warn('partial delete', errors.join('; '));
    await ctx.answerCallbackQuery({
      text:
        `Removed ${deleted}/${total}. Telegram will not let a bot delete a ` +
        'channel message older than 48 hours.',
      show_alert: true,
    });
  });

  async function runJob(ctx, url, statusId) {
    if (!destinations().length) {
      throw new Error(
        'I have nowhere to post yet. Add me to a channel or group and I will ' +
          'pick it up automatically — only you can add me.',
      );
    }

    // A full disk turns every download into a confusing failure. Try to fix it
    // first — the usual cause is debris from a job killed mid-encode — and only
    // then refuse, with a message that says what is actually wrong.
    let free = await freeSpaceMb(config.tmpDir);
    if (free !== null && free < config.minFreeSpaceMb) {
      log.warn(`only ${free}MB free, sweeping temp files`);
      await sweepTemp(config, { staleAfterMs: 0 }).catch(() => {});
      free = await freeSpaceMb(config.tmpDir);
      if (free !== null && free < config.minFreeSpaceMb) {
        throw new Error(
          `The disk is nearly full (${free}MB free) — nothing was downloaded. ` +
            'Free up space on the machine running the bot.',
        );
      }
    }

    const workDir = path.join(config.tmpDir, crypto.randomUUID());
    await fs.mkdir(workDir, { recursive: true });
    try {
      await setStatus(ctx, statusId, '⬇️ Downloading from Instagram…');
      const result = await download(url, workDir, config);

      const count = result.items.length;
      const label = count === 1 ? '' : ` (${count} items)`;
      await setStatus(ctx, statusId, `🎨 Adding watermark${label}…`);

      const finished = [];
      let unwatermarked = 0;
      let shrunk = 0;
      let covered = 0;
      for (const item of result.items) {
        const out = await applyWatermark(item, config, workDir);
        if (!out.watermarked && config.watermark.mode !== 'none') unwatermarked += 1;
        if (out.cover) covered += 1;

        const fitted = await ensureUnderLimit(out.path, config, workDir);
        if (fitted.shrunk) shrunk += 1;
        if (fitted.tooBig) {
          throw new Error(
            `That video is ${fitted.sizeMb}MB even after shrinking, and Telegram caps bot ` +
              `uploads at ${config.uploadLimitMb}MB. Nothing was posted.`,
          );
        }
        finished.push({ ...item, path: fitted.path, info: fitted.shrunk ? undefined : out.info });
      }

      await setStatus(ctx, statusId, '📤 Posting to the channel…');
      // Same hygiene as forwarded posts: no foreign links or tags survive, and
      // the channel's own @tag goes on the end.
      const { text: caption } = await cleanForChannel(buildCaption(result, config));

      const targets = destinations();
      const { sent, failed } = await broadcast(bot, config, { items: finished, caption }, targets);

      if (!sent.length) {
        throw new Error(
          `Could not post anywhere. ${failed.map((f) => `${f.title}: ${f.reason}`).join('; ')}`,
        );
      }

      const recordId = await store.add({
        targets: sent.map((t) => ({ chatId: t.chatId, messageIds: t.messageIds })),
        url,
        postedBy: ctx.from?.id,
      });

      const notes = [];
      // Detection is a guess and it is not confirmed with you before posting, so
      // it always says when it acted — a wrong guess should be visible here
      // rather than discovered on the channel later.
      if (covered) {
        notes.push(`🛡 Covered an existing watermark on ${covered} item(s).`);
      }
      if (unwatermarked) {
        notes.push(`⚠️ ${unwatermarked} item(s) posted WITHOUT a watermark — check the logs.`);
      }
      if (shrunk) {
        notes.push(`ℹ️ ${shrunk} item(s) re-encoded smaller to fit Telegram's ${config.uploadLimitMb}MB limit.`);
      }
      if (failed.length) {
        notes.push(
          `⚠️ Could not post to ${failed.map((f) => f.title).join(', ')}.`,
        );
      }
      const warningText = notes.length ? `\n${notes.join('\n')}` : '';
      const where =
        sent.length === 1 ? sent[0].title : `${sent.length} places`;

      await setStatus(ctx, statusId, `✅ Posted to ${where}${label}.${warningText}`, {
        reply_markup: new InlineKeyboard().text(
          sent.length === 1 ? '❌ Delete from channel' : '❌ Delete everywhere',
          `del:${recordId}`,
        ),
      });
      log.info(`posted to ${sent.length} destination(s) for ${url}`);
    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch((err) => {
        log.warn('temp cleanup failed —', err.message);
      });
    }
  }

  /** Post the placeholder that every later update edits. */
  async function announce(ctx) {
    try {
      const sent = await ctx.reply('⏳ Queued…', {
        reply_parameters: { message_id: ctx.message.message_id, allow_sending_without_reply: true },
      });
      return sent.message_id;
    } catch (err) {
      log.error('could not send status message —', err.message);
      return null;
    }
  }

  async function handleUrl(ctx, url, statusId) {
    let job;
    try {
      job = queue.push(() => runJob(ctx, url, statusId));
    } catch (err) {
      await setStatus(ctx, statusId, `🚫 ${err.message}`);
      return;
    }

    // Attach the rejection handler SYNCHRONOUSLY, before anything is awaited.
    //
    // queue.push() starts the job immediately, so a fast failure — yt-dlp
    // missing, spawn ENOENT, which land in about a millisecond — can reject
    // while the "waiting in queue" edit below is still in flight to Telegram.
    // A rejected promise with no handler yet attached is an unhandled rejection,
    // and Node's default for those is to terminate the process: the bot dies and
    // every other queued job dies with it.
    const settled = job.promise.then(
      () => null,
      (err) => err,
    );

    if (job.position > 0) {
      await setStatus(ctx, statusId, `⏳ Waiting — ${job.position} ahead in the queue…`);
    }

    const err = await settled;
    if (!err) return;

    if (err instanceof DownloadError) {
      await setStatus(ctx, statusId, `🚫 ${err.message}\n\n${err.hint}`);
    } else {
      log.error('job error —', err);
      await setStatus(ctx, statusId, `🚫 Something went wrong: ${err.message}`);
    }
  }

  bot.on('message', async (ctx) => {
    const text = ctx.message.text || ctx.message.caption || '';
    const urls = findInstagramUrls(text);

    if (!urls.length) {
      if (text.startsWith('/')) return;
      // Only nag in the private chat. In a group the bot sees every message,
      // and correcting each one would drown the room.
      if (ctx.chat?.type === 'private') {
        await ctx.reply("That doesn't look like an Instagram post link. Send a /reel/ or /p/ URL.");
      }
      return;
    }

    // The status replies are awaited so they stay in the order the links were
    // pasted, but the JOBS are deliberately not awaited here.
    //
    // In webhook mode this handler's completion is what sends Telegram its HTTP
    // response. Waiting for a two-minute encode would blow past Telegram's
    // webhook timeout, and Telegram answers a timeout by redelivering the same
    // update — which posts the reel to the channel twice.
    for (const url of urls) {
      const statusId = await announce(ctx);
      if (!statusId) continue;
      if (dispatcher) {
        // Awaiting this is safe AND required: it resolves on the first byte
        // from /work (milliseconds), which proves the job's request is live
        // before we hand Telegram its response and lose the CPU.
        try {
          await dispatcher.dispatch({ kind: 'url', chatId: ctx.chat.id, fromId: ctx.from?.id, statusId, url });
        } catch (err) {
          log.error('could not dispatch job —', err.message);
          await setStatus(ctx, statusId, `🚫 Could not start the job: ${err.message}`);
        }
      } else {
        handleUrl(ctx, url, statusId).catch((err) =>
          log.error('unhandled job failure —', err),
        );
      }
    }
  });


  /**
   * Serverless job runner. The payload carries just enough to rebuild the
   * pieces of a grammY context the job pipeline actually touches — api calls,
   * the admin chat id, and who asked.
   */
  const dispatcher = config.serverless
    ? createDispatcher({
        baseUrl: config.webhookUrl,
        runJob: async (payload) => {
          if (payload.kind === 'pending') {
            await sendPending(payload.pendingId, payload);
            return;
          }
          if (payload.kind === 'album') {
            // Hold this request open while the album's sibling messages arrive
            // on their own webhook requests, then stage the lot as one.
            await new Promise((resolve) => setTimeout(resolve, 2500));
            await flushAlbum(payload.groupId);
            return;
          }
          const { chatId, fromId, statusId, url } = payload;
          const ctxLike = {
            api: bot.api,
            chat: { id: chatId },
            from: fromId ? { id: fromId } : undefined,
            reply: (text, extra) => bot.api.sendMessage(chatId, text, extra),
          };
          await handleUrl(ctxLike, url, statusId);
        },
      })
    : null;

  const webhookPath = `/telegram/${crypto
    .createHash('sha256')
    .update(config.botToken)
    .digest('hex')
    .slice(0, 32)}`;
  const handleWebhook =
    config.mode === 'webhook'
      ? webhookCallback(bot, 'http', {
          secretToken: config.webhookSecret || undefined,
        })
      : null;

  // What this build can actually do, served on /health.
  //
  // Exists because "the merge succeeded" is not evidence the code is live, and
  // proving otherwise has repeatedly meant opening a console that is hostile on
  // a phone. Anyone can now curl /health and see whether a feature shipped: if
  // its name is absent, the running container predates it.
  //
  // Add a name here in the same commit that adds the capability, and never
  // before it works — a flag that lies is worse than no flag.
  const FEATURES = ['strip-forward', 'clean-captions', 'send-button', 'cover-watermark'];

  const server = http.createServer((req, res) => {
    if (dispatcher && req.method === 'POST' && req.url === dispatcher.workPath) {
      dispatcher.handle(req, res).catch((err) => {
        log.error('work handler —', err.message);
        res.destroy();
      });
      return;
    }
    if (handleWebhook && req.method === 'POST' && req.url === webhookPath) {
      handleWebhook(req, res).catch((err) => log.error('webhook handler —', err.message));
      return;
    }
    if (req.url === '/health' || req.url === '/') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          mode: config.mode,
          uptime: uptime(),
          queued: queue.size,
          posted: queue.completed,
          failed: queue.failed,
          features: FEATURES,
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise((resolve) => server.listen(config.port, resolve));
  log.info(`health server listening on :${config.port}`);

  // Check the token first, and say so in words. A rejected token otherwise
  // surfaces as a stack trace from whichever API call happened to run first,
  // which is the least useful possible way to learn you pasted it wrong.
  //
  // The timeout is not decoration. grammY retries a network failure here
  // FOREVER, with backoff up to 20 minutes, and never rejects — so with
  // Telegram unreachable at startup this call simply never returns. Everything
  // below it would never run, the process would sit alive and silent, and
  // because `restart: unless-stopped` does not act on an unhealthy container,
  // nothing would ever recover it. Bounding it turns that into a clean restart.
  try {
    await bot.init(AbortSignal.timeout(60000));
    log.info(`authenticated as @${bot.botInfo.username}`);
  } catch (err) {
    if (err.error_code === 401) {
      process.stderr.write(
        '\n✖ Telegram rejected BOT_TOKEN (401 Unauthorized).\n' +
          '  Copy it again from @BotFather — it looks like 8123456789:AAH...\n\n',
      );
      process.exit(1);
    }
    log.error('could not reach Telegram within 60s at startup — restarting:', err.message);
    process.exit(1);
  }

  // Cosmetic: this only populates the "/" menu in Telegram's UI. A network
  // blip here must not take down an otherwise working bot at boot.
  bot.api
    .setMyCommands([
      { command: 'help', description: 'How to use this bot' },
      { command: 'claim', description: 'Become the owner of this bot' },
      { command: 'status', description: 'Queue, uptime and settings' },
      { command: 'whoami', description: 'Show my Telegram id' },
    ])
    .catch((err) => log.warn('could not set the command menu —', err.description || err.message));

  // Check everything at boot rather than discovering it on the first post, and
  // put any problems where a human will actually see them. On an unattended box
  // a warning in the log is a warning nobody reads — so it goes to Telegram.
  //
  // Deliberately NOT awaited. Every call inside is bounded but slow when
  // Telegram is unwell — getChat, then one sendMessage per admin, all serial —
  // and blocking the start of polling on a diagnostic would mean the bot is not
  // accepting links while it works out how to tell you something is wrong.
  const reportProblems = async () => {
    const problems = await selfCheck(config, bot, destinations());
    if (!problems.length) {
      log.info('self-check: all good');
      return;
    }
    for (const problem of problems) log.error('self-check:', problem);
    if (!config.alertAdminsOnBoot) return;

    const message =
      '\u26a0\ufe0f The reposter started with problems:\n\n' +
      problems.map((p) => `\u2022 ${p}`).join('\n') +
      '\n\nIt is running, but these need fixing.';
    for (const adminId of config.adminIds) {
      // A DM the admin has never opened will fail; that must not stop anything.
      await bot.api.sendMessage(adminId, message).catch((err) => {
        log.warn(`could not alert admin ${adminId} \u2014`, err.description || err.message);
      });
    }
  };
  reportProblems().catch((err) => log.warn('self-check failed \u2014', err.message));

  const stopMaintenance = startMaintenance({ ...config, ytdlpAutoUpdate: config.ytdlpAutoUpdate && !config.serverless }, {
    // Run the periodic downloader update THROUGH the job queue. pip's upgrade
    // uninstalls before it reinstalls, and yt-dlp imports its extractors
    // lazily — so replacing it underneath a download in progress surfaces as a
    // baffling ImportError on a post that should have worked.
    exclusive: (fn) => {
      try {
        return queue.push(fn).promise;
      } catch (err) {
        log.warn('could not queue the downloader update \u2014', err.message);
        return Promise.resolve();
      }
    },
  });

  if (config.mode === 'webhook') {
    const url = `${config.webhookUrl.replace(/\/+$/, '')}${webhookPath}`;
    log.info(`registering webhook at ${url}`);
    try {
      await bot.api.setWebhook(url, {
        secret_token: config.webhookSecret || undefined,
        drop_pending_updates: true,
      });
    } catch (err) {
      // Without a webhook the bot is unreachable and LOOKS deployed — the
      // single worst silent failure this service has. Say exactly what was
      // attempted and die loudly so the logs carry the whole story.
      log.error(
        `could not register the webhook at ${url} — ${err.description || err.message}`,
      );
      process.exit(1);
    }
    log.info(`webhook registered (@${bot.botInfo.username})`);
  } else {
    await bot.api.deleteWebhook({ drop_pending_updates: true }).catch(() => {});
    // bot.start() rejects on 401 and 409 — grammY rethrows those rather than
    // routing them to bot.catch(). 409 means a second copy of this bot is
    // polling the same token, which is what an overlapping redeploy looks like,
    // and it is by far the most common operational error here. Without this it
    // surfaced as an anonymous unhandled rejection and a restart loop with no
    // explanation of the cause.
    bot
      .start({
        drop_pending_updates: true,
        onStart: (info) => log.info(`polling as @${info.username}`),
      })
      .catch((err) => {
        if (err.error_code === 409) {
          log.error(
            'another instance of this bot is already running with the same token ' +
              '(409 Conflict). Stop the other one — restarting will not help.',
          );
        } else {
          log.error('polling stopped —', err.description || err.message);
        }
        process.exit(1);
      });
  }

  const shutdown = async (signal) => {
    log.info(`${signal} — shutting down`);
    stopMaintenance();
    server.close();
    try {
      await bot.stop();
    } catch {
      /* already stopped */
    }
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

/**
 * Last line of defence.
 *
 * These should never fire — every known path handles its own errors — but an
 * unhandled rejection or an uncaught throw would otherwise kill the process
 * with a bare stack trace and no explanation. Log it clearly and exit non-zero
 * so the container's restart policy brings the bot straight back, rather than
 * leaving it dead until somebody notices.
 */
const exitAfterLogging = () => {
  // stderr to a pipe — which is what Docker gives you — is asynchronous above
  // 64KB, so exiting in the same tick truncates the very message explaining the
  // crash. A short delay lets it flush.
  setTimeout(() => process.exit(1), 250);
};

process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection — restarting:', reason);
  exitAfterLogging();
});
process.on('uncaughtException', (err) => {
  log.error('uncaught exception — restarting:', err);
  exitAfterLogging();
});

main().catch((err) => {
  log.error('fatal —', err);
  process.exit(1);
});
