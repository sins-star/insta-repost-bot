import fs from 'node:fs/promises';
import path from 'node:path';
import { run, CommandError } from './media.js';
import { log } from './logger.js';

const URL_PATTERN = /https?:\/\/(?:www\.)?(?:instagram\.com|instagr\.am)\/[^\s<>"')]+/gi;

/** Post types yt-dlp can actually fetch. `/share/` links redirect to one of these. */
const SUPPORTED_PATHS = /^\/(?:reel|reels|p|tv|share|stories)\//i;

const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.webm']);
const PHOTO_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic']);

export class DownloadError extends Error {
  constructor(message, { hint = '', cause } = {}) {
    super(message);
    this.name = 'DownloadError';
    this.hint = hint;
    this.cause = cause;
  }
}

/**
 * Pull every Instagram post link out of a message.
 *
 * Deliberately tolerant about what follows the host — Instagram links arrive
 * with tracking params, trailing punctuation from a sentence, and share-sheet
 * wrappers — and strict about the path, so a link to a profile or the app store
 * is not queued as a download that will fail two minutes later.
 */
export function findInstagramUrls(text) {
  if (!text) return [];
  const found = new Set();
  for (const raw of text.match(URL_PATTERN) || []) {
    const cleaned = raw.replace(/[.,;!?]+$/, '');
    let parsed;
    try {
      parsed = new URL(cleaned);
    } catch {
      continue;
    }
    if (!SUPPORTED_PATHS.test(parsed.pathname)) continue;
    // Strip tracking params so the same post pasted from two places dedupes.
    parsed.search = '';
    parsed.hash = '';
    found.add(parsed.toString());
  }
  return [...found];
}

/**
 * Turn a yt-dlp failure into something the admin can act on.
 *
 * Instagram's extractor breaks often and its errors are verbose, so the raw
 * stderr is kept for the log while the chat gets one line and a next step.
 */
export function explainFailure(stderr = '', message = '') {
  const haystack = `${stderr}\n${message}`.toLowerCase();

  // yt-dlp's exact wording when the anonymous path is exhausted. It reads like a
  // login problem but it is a rate limit, and the fix is different.
  if (
    haystack.includes('exceeded the rate-limit for accessing posts anonymously') ||
    haystack.includes('redirected to the login page')
  ) {
    return {
      reason: 'Instagram rate-limited this server for anonymous downloads.',
      hint: 'Wait ~15 minutes, or add a cookies file (README → "When Instagram starts asking for a login") to raise the limit a lot.',
    };
  }
  if (haystack.includes('cookies are no longer valid')) {
    return {
      reason: 'The saved Instagram cookies have expired.',
      hint: 'Export a fresh cookies.txt from a logged-in browser and replace the file, then restart the bot.',
    };
  }
  if (
    haystack.includes('login required') ||
    haystack.includes('requires authentication') ||
    haystack.includes('empty media response') ||
    haystack.includes('only available for registered users')
  ) {
    return {
      reason: 'Instagram asked this download to log in.',
      hint: 'Add a cookies file (see README → "When Instagram starts asking for a login") and set COOKIES_FILE.',
    };
  }
  if (haystack.includes('rate-limit') || haystack.includes('429') || haystack.includes('please wait a few minutes')) {
    return {
      reason: 'Instagram is rate-limiting this server.',
      hint: 'Wait a few minutes and try again. If it keeps happening, a cookies file makes limits much looser.',
    };
  }
  if (haystack.includes('private') || haystack.includes('not available') || haystack.includes('404')) {
    return {
      reason: 'That post is private, deleted, or region-blocked.',
      hint: 'Check the link opens in a logged-out browser.',
    };
  }
  if (haystack.includes('unsupported url')) {
    return {
      reason: "yt-dlp doesn't recognise that as an Instagram post.",
      hint: 'Send a link to a reel or post, not a profile or a story highlight.',
    };
  }
  if (haystack.includes('file is larger than max-filesize')) {
    return {
      reason: 'The video is larger than the limit.',
      hint: 'Raise MAX_FILESIZE_MB — but Telegram bots cannot upload above 50MB anyway.',
    };
  }
  return {
    reason: 'The download failed.',
    hint: 'Usually this means Instagram changed something. Try again, and if it persists update yt-dlp.',
  };
}

function classify(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (VIDEO_EXT.has(ext)) return 'video';
  if (PHOTO_EXT.has(ext)) return 'photo';
  return null;
}

/**
 * Download one Instagram post into `workDir`.
 *
 * A post can be a single reel or a carousel of up to 10 items, so this always
 * returns an array. Metadata comes from the .info.json files yt-dlp writes
 * alongside the media rather than from a second network round-trip.
 */
async function runYtDlp(url, workDir, config) {
  const args = [
    '--ignore-config',
    '--no-progress',
    '--no-mtime',
    '--no-part',
    '--retries',
    '5',
    '--extractor-retries',
    '3',
    // Instagram rate-limits aggressively; a couple of seconds between requests
    // is cheap next to a 15-minute lockout.
    '--sleep-requests',
    '2',
    '--socket-timeout',
    '30',
    '--max-filesize',
    `${config.maxFilesizeMb}M`,
    '-f',
    'bv*+ba/b',
    '--merge-output-format',
    'mp4',
    '--write-info-json',
    '-o',
    path.join(workDir, '%(autonumber)03d.%(ext)s'),
  ];
  if (config.cookiesFile) args.push('--cookies', config.cookiesFile);
  if (config.ytdlpExtraArgs.length) args.push(...config.ytdlpExtraArgs);
  args.push(url);

  await run(config.ytdlpPath, args, { timeoutMs: config.downloadTimeoutMs, cwd: workDir });
}

/**
 * Second extractor, tried only when yt-dlp fails.
 *
 * gallery-dl is an independent implementation of Instagram scraping, so the two
 * rarely break in the same week — which is the single most useful property a
 * fallback can have for a site that changes as often as this one.
 */
async function runGalleryDl(url, workDir, config) {
  const args = [
    // -D is "exact location": without it gallery-dl builds its own
    // instagram/<user>/ tree underneath the destination and collect() finds
    // nothing in the directory it was told to look in.
    '--directory',
    workDir,
    '--filename',
    '{num:>03}.{extension}',
    '--write-metadata',
    '--no-part',
    '--retries',
    '3',
  ];
  if (config.cookiesFile) args.push('--cookies', config.cookiesFile);
  args.push(url);

  await run(config.galleryDlPath, args, { timeoutMs: config.downloadTimeoutMs, cwd: workDir });
}

/**
 * Read whatever landed in the work directory.
 *
 * Handles both writers: yt-dlp leaves `<n>.info.json`, gallery-dl leaves
 * `<file>.json`. Both expose the post text as `description`.
 */
async function collect(workDir) {
  const entries = (await fs.readdir(workDir)).sort();
  const items = [];
  let caption = '';
  let uploader = '';

  for (const name of entries) {
    if (name.endsWith('.json')) {
      if (caption) continue;
      try {
        const meta = JSON.parse(await fs.readFile(path.join(workDir, name), 'utf8'));
        caption = (meta.description || meta.title || '').trim();
        uploader = (meta.uploader_id || meta.uploader || meta.username || meta.owner_id || '')
          .toString()
          .trim();
      } catch (err) {
        log.warn('could not read metadata', name, err.message);
      }
      continue;
    }
    const type = classify(name);
    if (type) items.push({ path: path.join(workDir, name), type, name });
  }

  return { items, caption, uploader };
}

export async function download(url, workDir, config) {
  let primaryError;
  try {
    await runYtDlp(url, workDir, config);
  } catch (err) {
    primaryError = err;
    const stderr = err instanceof CommandError ? err.stderr : '';
    log.error('yt-dlp failed for', url, '—', stderr || err.message);

    if (!config.fallbackEnabled) {
      const { reason, hint } = explainFailure(stderr, err.message);
      throw new DownloadError(reason, { hint, cause: err });
    }

    log.info('trying gallery-dl as a fallback…');
    try {
      await runGalleryDl(url, workDir, config);
      log.info('gallery-dl succeeded where yt-dlp failed');
    } catch (fallbackErr) {
      const fallbackStderr = fallbackErr instanceof CommandError ? fallbackErr.stderr : '';
      log.error('gallery-dl also failed —', fallbackStderr || fallbackErr.message);
      // Report the primary tool's diagnosis: it is the better-maintained
      // extractor and its messages are the ones the hints are written for.
      const { reason, hint } = explainFailure(stderr, err.message);
      throw new DownloadError(reason, { hint, cause: err });
    }
  }

  const { items, caption, uploader } = await collect(workDir);

  if (!items.length) {
    throw new DownloadError('The download produced no media.', {
      hint:
        `Most often this means the file was over the ${config.maxFilesizeMb}MB limit, ` +
        'or Instagram served an empty response. Try again in a minute.',
      cause: primaryError,
    });
  }

  log.info(`downloaded ${items.length} item(s) from ${url}`);
  return { items, caption, uploader, url };
}

/**
 * Build the channel caption.
 *
 * Telegram hard-caps a media caption at 1024 characters and rejects the whole
 * send if it is exceeded, so truncation happens here rather than as a surprise
 * API error after the file has already been uploaded.
 */
export function buildCaption({ caption, uploader, url }, config) {
  const parts = [];
  if (config.caption.mode === 'original' && caption) parts.push(caption);
  if (config.caption.suffix) {
    parts.push(
      config.caption.suffix
        .replace(/\{uploader\}/g, uploader ? `@${uploader.replace(/^@/, '')}` : '')
        .replace(/\{url\}/g, url || '')
        .trim(),
    );
  }

  let text = parts.join('\n\n').trim();
  const limit = config.caption.maxLength;
  if (limit === 0) return '';
  if (text.length > limit) {
    let cut = text.slice(0, Math.max(0, limit - 1));
    // An emoji is two UTF-16 units. Slicing between them leaves a lone
    // surrogate, which is encoded on the wire as the replacement character —
    // so the caption ends in a stray "�".
    if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
    text = `${cut.trimEnd()}…`;
  }
  return text;
}
