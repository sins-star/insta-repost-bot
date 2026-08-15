#!/usr/bin/env node
/**
 * Pre-flight check: `npm run doctor`.
 *
 * Every line here corresponds to something that otherwise fails silently or
 * fails late — the missing curl_cffi that makes Instagram "just stop working",
 * the bot that was never added to the channel, the font path that only breaks
 * once a watermark is actually drawn.
 */
import 'dotenv/config';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig, ConfigError } from '../src/config.js';

const exec = promisify(execFile);

let failures = 0;
let warnings = 0;

const pass = (label, detail = '') => console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
const warn = (label, detail = '') => {
  warnings += 1;
  console.log(`  ⚠ ${label}${detail ? ` — ${detail}` : ''}`);
};
const fail = (label, detail = '') => {
  failures += 1;
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
};

// ffmpeg and ffprobe take a SINGLE dash here and exit non-zero on `--version`,
// which would otherwise make a working install look like a missing one.
async function version(binary, args = ['-version']) {
  try {
    const { stdout } = await exec(binary, args, { timeout: 30000 });
    return stdout.trim().split('\n')[0];
  } catch {
    return null;
  }
}

console.log('\nInstagram → Telegram reposter — pre-flight check\n');

console.log('Configuration');
let config = null;
try {
  config = loadConfig();
  pass('.env loads');
  pass('channel', String(config.channelId));
  pass('admins', `${config.adminIds.length} id(s)`);
  pass('watermark', config.watermark.mode);
  pass('mode', config.mode);
} catch (err) {
  if (err instanceof ConfigError) fail('.env', err.message);
  else fail('.env', err.message);
}

console.log('\nExternal tools');
const ffmpeg = await version(config?.ffmpegPath || 'ffmpeg');
ffmpeg ? pass('ffmpeg', ffmpeg.replace('ffmpeg version ', '').split(' ')[0]) : fail('ffmpeg', 'not installed');

const ffprobe = await version(config?.ffprobePath || 'ffprobe');
ffprobe ? pass('ffprobe', 'ok') : fail('ffprobe', 'not installed');

// yt-dlp and gallery-dl are the other way round: they want the double dash.
const ytdlp = await version(config?.ytdlpPath || 'yt-dlp', ['--version']);
ytdlp ? pass('yt-dlp', ytdlp) : fail('yt-dlp', 'not installed');

// The one that matters most and is invisible otherwise: without curl_cffi,
// yt-dlp's logged-out Instagram path fails to extract and says nothing about
// why. See the note in the Dockerfile.
try {
  await exec('python3', ['-c', 'import curl_cffi'], { timeout: 20000 });
  pass('curl_cffi', 'browser impersonation available');
} catch {
  warn(
    'curl_cffi',
    'MISSING — anonymous Instagram downloads will fail with confusing errors. ' +
      'Fix: pip install "yt-dlp[default,curl-cffi]"',
  );
}

if (config?.fallbackEnabled) {
  const gallery = await version(config.galleryDlPath, ['--version']);
  gallery ? pass('gallery-dl', gallery) : warn('gallery-dl', 'not installed — fallback disabled in practice');
}

if (config) {
  console.log('\nFiles');
  try {
    await fs.access(config.watermark.fontPath);
    pass('font', config.watermark.fontPath);
  } catch {
    const needed = ['text', 'both', 'tiled'].includes(config.watermark.mode);
    (needed ? fail : warn)('font', `${config.watermark.fontPath} not found`);
  }

  if (['logo', 'both'].includes(config.watermark.mode)) {
    try {
      await fs.access(config.watermark.logoPath);
      pass('logo', config.watermark.logoPath);
    } catch {
      fail('logo', `${config.watermark.logoPath} not found`);
    }
  }

  if (config.cookiesFile) {
    try {
      await fs.access(config.cookiesFile);
      pass('cookies', config.cookiesFile);
    } catch {
      fail('cookies', `${config.cookiesFile} not found`);
    }
  } else {
    warn('cookies', 'none configured — fine until Instagram starts rate-limiting');
  }

  for (const dir of [config.tmpDir, config.dataDir]) {
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.access(dir);
      pass('writable', dir);
    } catch (err) {
      fail('writable', `${dir} — ${err.message}`);
    }
  }

  console.log('\nTelegram');
  try {
    const res = await fetch(`https://api.telegram.org/bot${config.botToken}/getMe`);
    const body = await res.json();
    if (body.ok) pass('token', `@${body.result.username}`);
    else fail('token', body.description || 'rejected by Telegram');
  } catch (err) {
    fail('token', `could not reach Telegram — ${err.message}`);
  }

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${config.botToken}/getChat?chat_id=${encodeURIComponent(
        config.channelId,
      )}`,
    );
    const body = await res.json();
    if (body.ok) pass('channel', body.result.title || body.result.username);
    else {
      fail(
        'channel',
        `${body.description} — add the bot to the channel as an admin with "Post messages"`,
      );
    }
  } catch (err) {
    fail('channel', err.message);
  }
}

console.log(
  `\n${failures ? '✗' : '✓'} ${failures} problem(s), ${warnings} warning(s)\n`,
);
process.exit(failures ? 1 : 0);
