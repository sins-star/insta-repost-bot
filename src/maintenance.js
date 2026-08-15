import fs from 'node:fs/promises';
import path from 'node:path';
import { run } from './media.js';
import { log } from './logger.js';

/**
 * The things that would otherwise turn into "the bot stopped working, go and
 * fix it" on a box nobody logs into.
 *
 * Three failure modes, all of which happen on a long enough timeline:
 *   1. Instagram changes something and the downloader breaks. Fixed upstream
 *      within days — but only if the container ever pulls a newer version.
 *   2. The disk fills with temp files from jobs killed mid-flight, and every
 *      later download fails with a confusing error.
 *   3. Something is misconfigured and the only evidence is a log line on a
 *      machine with nobody reading logs.
 */

const HOUR = 60 * 60 * 1000;

/** Work directories older than this were orphaned by a crash or a restart. */
const STALE_AFTER_MS = 6 * HOUR;

/** setInterval silently reinterprets anything above this as 1ms. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Work directories are named with crypto.randomUUID(), and ONLY those are ever
 * deleted.
 *
 * The sweeper runs with staleAfterMs=0 when disk is short, which makes every
 * entry eligible by age. Without this filter, pointing TMP_DIR at a shared
 * location — /tmp, say — would delete other programs' files. Matching our own
 * naming scheme means the worst case is that we skip something of ours.
 */
const WORK_DIR_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Delete abandoned work directories.
 *
 * Normal operation cleans up after itself in a `finally`, but a container
 * killed mid-encode (OOM, host reboot, `docker stop` during a job) leaves the
 * directory behind. Each one can be tens of megabytes, and nothing else would
 * ever remove them.
 */
export async function sweepTemp(config, { staleAfterMs = STALE_AFTER_MS } = {}) {
  let entries;
  try {
    entries = await fs.readdir(config.tmpDir, { withFileTypes: true });
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn('temp sweep could not read the temp dir —', err.message);
    return { removed: 0, freedMb: 0 };
  }

  const cutoff = Date.now() - staleAfterMs;
  let removed = 0;
  let freedBytes = 0;

  for (const entry of entries) {
    if (!WORK_DIR_PATTERN.test(entry.name)) continue;
    const full = path.join(config.tmpDir, entry.name);
    try {
      const info = await fs.lstat(full);
      if (info.mtimeMs > cutoff) continue;
      freedBytes += await directorySize(full);
      await fs.rm(full, { recursive: true, force: true });
      removed += 1;
    } catch (err) {
      log.warn(`temp sweep could not remove ${entry.name} —`, err.message);
    }
  }

  const freedMb = Math.round(freedBytes / 1024 / 1024);
  if (removed) log.info(`temp sweep: removed ${removed} stale item(s), freed ~${freedMb}MB`);
  return { removed, freedMb };
}

async function directorySize(target) {
  let total = 0;
  try {
    // lstat, not stat: following a symlink here would walk whatever it points
    // at — potentially the whole filesystem — while the disk guard waits.
    const info = await fs.lstat(target);
    if (info.isSymbolicLink()) return 0;
    if (!info.isDirectory()) return info.size;
    for (const entry of await fs.readdir(target)) {
      total += await directorySize(path.join(target, entry));
    }
  } catch {
    /* raced with a delete; size is best-effort */
  }
  return total;
}

/** Free space in MB on the filesystem holding `dir`, or null if unknowable. */
export async function freeSpaceMb(dir) {
  try {
    const stats = await fs.statfs(dir);
    return Math.floor((stats.bavail * stats.bsize) / 1024 / 1024);
  } catch (err) {
    log.debug('could not check free space —', err.message);
    return null;
  }
}

/**
 * Update the downloader in place.
 *
 * ⚠️ `yt-dlp -U` does NOT work here. It refuses to self-update any install that
 * came from a package manager, and the Docker image installs from PyPI —
 * deliberately, because the standalone binaries do not all bundle curl_cffi,
 * without which Instagram extraction silently fails. So the update has to go
 * back through pip, and `--user` is what makes it work as the non-root user the
 * container runs as.
 *
 * Never throws: a failed update must degrade to "carry on with the version we
 * have", never to a bot that will not start.
 */
export async function updateDownloader(config) {
  const [command, ...args] = config.ytdlpUpdateCmd;
  if (!command) return { updated: false, reason: 'no update command configured' };

  try {
    const { stdout } = await run(command, args, { timeoutMs: 5 * 60 * 1000 });
    const line =
      stdout
        .split('\n')
        .reverse()
        .find((l) => l.trim()) || 'done';
    log.info('downloader update:', line.trim());

    try {
      const { stdout: version } = await run(config.ytdlpPath, ['--version'], { timeoutMs: 60000 });
      log.info('yt-dlp now at', version.trim());
      return { updated: true, version: version.trim() };
    } catch {
      return { updated: true };
    }
  } catch (err) {
    log.warn('downloader update failed (continuing on the current version) —', err.message);
    return { updated: false, reason: err.message };
  }
}

/**
 * Start the background upkeep timers.
 *
 * @returns {() => void} a stop function, so shutdown does not hang on pending
 * timers.
 */
export function startMaintenance(config, { exclusive = (fn) => fn() } = {}) {
  const timers = [];

  const sweep = () => {
    sweepTemp(config).catch((err) => log.warn('temp sweep failed —', err.message));
  };
  timers.push(setInterval(sweep, HOUR));

  if (config.ytdlpAutoUpdate) {
    // Two guards on one timer:
    //
    // `updating` stops a slow pip run from overlapping the next tick and
    // stacking concurrent installs on a small box.
    //
    // `exclusive` runs the update through the job queue, so it cannot replace
    // yt-dlp underneath a download that is already running — yt-dlp imports its
    // extractors lazily, and pip's uninstall step removing those files mid-run
    // surfaces as a baffling ImportError.
    let updating = false;
    const update = async () => {
      if (updating) {
        log.warn('skipping downloader update — the previous one is still running');
        return;
      }
      updating = true;
      try {
        await exclusive(() => updateDownloader(config));
      } catch (err) {
        log.warn('downloader update could not run —', err.message);
      } finally {
        updating = false;
      }
    };
    // Above 2^31-1 ms setInterval silently becomes 1ms — which would spawn pip
    // in a tight loop. The config caps the hours, and this is the backstop.
    const intervalMs = Math.min(config.updateIntervalHours * HOUR, MAX_TIMER_MS);
    timers.push(setInterval(update, intervalMs));
  }

  // Timers must not hold the event loop open on their own, or a shutdown waits
  // out the full interval.
  for (const timer of timers) timer.unref?.();

  return () => timers.forEach((timer) => clearInterval(timer));
}

/**
 * Everything worth knowing at boot, checked in one place.
 *
 * Returned rather than logged so the caller can put it in front of a human —
 * on an unattended box, a warning in the log is a warning nobody reads.
 */
export async function selfCheck(config, bot) {
  const problems = [];

  try {
    await bot.api.getChat(config.channelId);
  } catch (err) {
    problems.push(
      `Cannot see the channel ${config.channelId} — ${err.description || err.message}. ` +
        'Add the bot to the channel as an admin with "Post messages".',
    );
  }

  try {
    await run(config.ytdlpPath, ['--version'], { timeoutMs: 60000 });
  } catch {
    problems.push('yt-dlp is not available — downloads will fail.');
  }

  try {
    await run(config.ffmpegPath, ['-version'], { timeoutMs: 60000 });
  } catch {
    problems.push('ffmpeg is not available — watermarking will fail.');
  }

  if (['text', 'both', 'tiled'].includes(config.watermark.mode)) {
    try {
      await fs.access(config.watermark.fontPath);
    } catch {
      problems.push(`The watermark font is missing at ${config.watermark.fontPath}.`);
    }
  }

  const free = await freeSpaceMb(config.tmpDir);
  if (free !== null && free < config.minFreeSpaceMb) {
    problems.push(`Only ${free}MB of disk free — downloads may fail.`);
  }

  return problems;
}
