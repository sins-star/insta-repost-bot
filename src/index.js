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
import { postToChannel, deletePost } from './poster.js';
import { Queue } from './queue.js';
import { PostStore } from './store.js';
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

  if (config.ytdlpAutoUpdate) await updateDownloader(config);

  if (config.cover.logoMissing) {
    log.warn(
      `cover: ${config.watermark.logoPath} not found — covering an existing watermark ` +
        'will blur it out but not stamp the logo. Add the file and restart to enable that.',
    );
  }

  const store = new PostStore(config.dataDir);
  await store.load();
  const queue = new Queue({ limit: config.queueLimit });

  const bot = new Bot(config.botToken);

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

  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (userId && config.adminIds.includes(userId)) return next();
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({ text: 'Not authorised.', show_alert: true });
      return;
    }
    if (ctx.message) {
      await ctx.reply(
        `Not authorised. Your id is ${userId} — it needs to be in ADMIN_IDS.`,
      );
    }
  });

  const help =
    '<b>Instagram → channel reposter</b>\n\n' +
    'Paste an Instagram reel or post link and I will download it, watermark it, ' +
    'and post it to the channel. Multiple links in one message all get queued.\n\n' +
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
        `Channel: ${config.channelId}`,
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

  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data || '';
    if (!data.startsWith('del:')) return ctx.answerCallbackQuery();

    const record = store.get(data.slice(4));
    if (!record) {
      return ctx.answerCallbackQuery({
        text: 'That post is no longer tracked — delete it in the channel.',
        show_alert: true,
      });
    }

    const { deleted, total, errors } = await deletePost(bot, record.chatId, record.messageIds);
    if (deleted === total) {
      await store.remove(data.slice(4));
      await ctx.answerCallbackQuery({ text: 'Deleted from the channel.' });
      await ctx.editMessageText('🗑 Deleted from the channel.');
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
      const caption = buildCaption(result, config);

      let messageIds;
      try {
        messageIds = await postToChannel(bot, config, { items: finished, caption });
      } catch (err) {
        // Part of a multi-group album may already be live. Record what did post
        // so the Delete button can still take it down.
        const partial = err.partialMessageIds || [];
        if (!partial.length) throw err;

        const partialId = await store.add({
          chatId: config.channelId,
          messageIds: partial,
          url,
          postedBy: ctx.from?.id,
        });
        await setStatus(
          ctx,
          statusId,
          `🚫 Posting failed part-way: ${err.message}\n\n` +
            `⚠️ ${partial.length} item(s) are already live in the channel.`,
          {
            reply_markup: new InlineKeyboard().text(
              '❌ Delete what posted',
              `del:${partialId}`,
            ),
          },
        );
        return;
      }

      const recordId = await store.add({
        chatId: config.channelId,
        messageIds,
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
      const warning = notes.length ? `\n${notes.join('\n')}` : '';
      await setStatus(
        ctx,
        statusId,
        `✅ Posted to the channel${label}.${warning}`,
        { reply_markup: new InlineKeyboard().text('❌ Delete from channel', `del:${recordId}`) },
      );
      log.info(`posted ${messageIds.length} message(s) for ${url}`);
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
      await ctx.reply("That doesn't look like an Instagram post link. Send a /reel/ or /p/ URL.");
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
      if (statusId) {
        handleUrl(ctx, url, statusId).catch((err) =>
          log.error('unhandled job failure —', err),
        );
      }
    }
  });

  // Check the token first, and say so in words. A rejected token otherwise
  // surfaces as a stack trace from whichever API call happened to run first,
  // which is the least useful possible way to learn you pasted it wrong.
  try {
    await bot.init();
    log.info(`authenticated as @${bot.botInfo.username}`);
  } catch (err) {
    if (err.error_code === 401) {
      process.stderr.write(
        '\n✖ Telegram rejected BOT_TOKEN (401 Unauthorized).\n' +
          '  Copy it again from @BotFather — it looks like 8123456789:AAH...\n\n',
      );
      process.exit(1);
    }
    throw err;
  }

  // Cosmetic: this only populates the "/" menu in Telegram's UI. A network
  // blip here must not take down an otherwise working bot at boot.
  await bot.api
    .setMyCommands([
      { command: 'help', description: 'How to use this bot' },
      { command: 'status', description: 'Queue, uptime and settings' },
      { command: 'whoami', description: 'Show my Telegram id' },
    ])
    .catch((err) => log.warn('could not set the command menu —', err.description || err.message));

  // Check everything at boot rather than discovering it on the first post, and
  // put any problems where a human will actually see them. On an unattended box
  // a warning in the log is a warning nobody reads — so it goes to Telegram.
  const problems = await selfCheck(config, bot);
  if (!problems.length) {
    log.info('self-check: all good');
  } else {
    for (const problem of problems) log.error('self-check:', problem);
    if (config.alertAdminsOnBoot) {
      const message =
        '⚠️ The reposter started with problems:\n\n' +
        problems.map((p) => `• ${p}`).join('\n') +
        '\n\nIt is running, but these need fixing.';
      for (const adminId of config.adminIds) {
        // A DM the admin has never opened will fail; that must not stop boot.
        await bot.api.sendMessage(adminId, message).catch((err) => {
          log.warn(`could not alert admin ${adminId} —`, err.description || err.message);
        });
      }
    }
  }

  const stopMaintenance = startMaintenance(config);

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

  const server = http.createServer((req, res) => {
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
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise((resolve) => server.listen(config.port, resolve));
  log.info(`health server listening on :${config.port}`);

  if (config.mode === 'webhook') {
    const url = `${config.webhookUrl.replace(/\/+$/, '')}${webhookPath}`;
    await bot.api.setWebhook(url, {
      secret_token: config.webhookSecret || undefined,
      drop_pending_updates: true,
    });
    log.info(`webhook registered (@${bot.botInfo.username})`);
  } else {
    await bot.api.deleteWebhook({ drop_pending_updates: true }).catch(() => {});
    bot.start({
      drop_pending_updates: true,
      onStart: (info) => log.info(`polling as @${info.username}`),
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
process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection — restarting:', reason);
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  log.error('uncaught exception — restarting:', err);
  process.exit(1);
});

main().catch((err) => {
  log.error('fatal —', err);
  process.exit(1);
});
