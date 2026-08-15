import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

class ConfigError extends Error {}

/**
 * The environment being read. Set once per loadConfig() call so the tests can
 * pass a plain object without reassigning the real process.env, which is a
 * special host object and does not survive being replaced.
 */
let env = process.env;

function req(name) {
  const value = (env[name] || '').trim();
  if (!value) throw new ConfigError(`${name} is required but not set`);
  return value;
}

function str(name, fallback) {
  const value = (env[name] || '').trim();
  return value || fallback;
}

function num(name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = (env[name] || '').trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new ConfigError(`${name} must be a number, got "${raw}"`);
  if (value < min || value > max) {
    throw new ConfigError(`${name} must be between ${min} and ${max}, got ${value}`);
  }
  return value;
}

function bool(name, fallback) {
  const raw = (env[name] || '').trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new ConfigError(`${name} must be true or false, got "${raw}"`);
}

function oneOf(name, fallback, allowed) {
  const value = str(name, fallback).toLowerCase();
  if (!allowed.includes(value)) {
    throw new ConfigError(`${name} must be one of ${allowed.join(', ')} — got "${value}"`);
  }
  return value;
}

/**
 * Admin ids are the only thing standing between "the owner reposts something"
 * and "anyone who finds the bot posts to the channel", so an unparseable entry
 * is a boot failure rather than a silently dropped id.
 */
function parseAdminIds(raw) {
  const ids = raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (!ids.length) throw new ConfigError('ADMIN_IDS is required but contained no ids');
  return ids.map((id) => {
    if (!/^-?\d+$/.test(id)) {
      throw new ConfigError(
        `ADMIN_IDS must be numeric Telegram user ids, got "${id}". ` +
          'Send /whoami to the bot to find yours — an @username will not work here.',
      );
    }
    return Number(id);
  });
}

/**
 * A channel is either @publicname or a numeric -100… id. Telegram silently
 * treats a bare unprefixed name as an unknown chat, so catch it at boot.
 */
function parseChannel(raw) {
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if (raw.startsWith('@')) return raw;
  throw new ConfigError(
    `CHANNEL_ID must be "@channelname" or a numeric id like -1001234567890 — got "${raw}"`,
  );
}

export function loadConfig(source = process.env) {
  const previous = env;
  env = source;
  try {
    const mode = oneOf('MODE', 'polling', ['polling', 'webhook']);
    const watermarkMode = oneOf('WATERMARK_MODE', 'text', [
      'none',
      'text',
      'logo',
      'both',
      'tiled',
    ]);

    const config = {
      botToken: req('BOT_TOKEN'),
      channelId: parseChannel(req('CHANNEL_ID')),
      adminIds: parseAdminIds(req('ADMIN_IDS')),

      mode,
      port: num('PORT', 8080, { min: 1, max: 65535 }),
      webhookUrl: str('WEBHOOK_URL', ''),
      webhookSecret: str('WEBHOOK_SECRET', ''),

      watermark: {
        mode: watermarkMode,
        text: str('WATERMARK_TEXT', ''),
        logoPath: str('WATERMARK_LOGO', 'assets/watermark.png'),
        fontPath: str('WATERMARK_FONT', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'),
        position: oneOf('WATERMARK_POSITION', 'br', ['tl', 'tr', 'bl', 'br', 'center']),
        opacity: num('WATERMARK_OPACITY', 0.75, { min: 0, max: 1 }),
        scale: num('WATERMARK_SCALE', 0.18, { min: 0.01, max: 1 }),
        textScale: num('WATERMARK_TEXT_SCALE', 0.045, { min: 0.005, max: 0.5 }),
        margin: num('WATERMARK_MARGIN', 0.03, { min: 0, max: 0.45 }),
        tileRows: num('WATERMARK_TILE_ROWS', 3, { min: 1, max: 10 }),
        tileCols: num('WATERMARK_TILE_COLS', 3, { min: 1, max: 10 }),
        // Knocks a solid backdrop out of a logo that has no alpha channel —
        // otherwise a logo saved on black lands as a black box on the video.
        chromaKey: str('WATERMARK_CHROMA_KEY', ''),
      },

      cover: {
        enabled: bool('COVER_EXISTING', true),
        useLogo: bool('COVER_WITH_LOGO', true),
        blurStrength: num('COVER_BLUR', 0.16, { min: 0.02, max: 0.5 }),
      },

      caption: {
        mode: oneOf('CAPTION_MODE', 'original', ['original', 'none']),
        suffix: str('CAPTION_SUFFIX', '').replace(/\\n/g, '\n'),
        maxLength: num('CAPTION_MAX_LENGTH', 1024, { min: 0, max: 1024 }),
      },

      ytdlpPath: str('YTDLP_PATH', 'yt-dlp'),
      ytdlpExtraArgs: str('YTDLP_EXTRA_ARGS', '').split(/\s+/).filter(Boolean),
      galleryDlPath: str('GALLERYDL_PATH', 'gallery-dl'),
      fallbackEnabled: bool('FALLBACK_GALLERYDL', true),
      ffmpegPath: str('FFMPEG_PATH', 'ffmpeg'),
      ffprobePath: str('FFPROBE_PATH', 'ffprobe'),
      cookiesFile: str('COOKIES_FILE', ''),
      ytdlpAutoUpdate: bool('YTDLP_AUTO_UPDATE', false),

      // Telegram refuses any bot upload over 50MB. Watermarking re-encodes, so
      // a 48MB download can come out the other side above the ceiling — this is
      // the number the shrink pass targets, not the download limit.
      uploadLimitMb: num('UPLOAD_LIMIT_MB', 50, { min: 1, max: 2000 }),

      tmpDir: str('TMP_DIR', path.join(os.tmpdir(), 'insta-repost')),
      dataDir: str('DATA_DIR', 'data'),
      maxFilesizeMb: num('MAX_FILESIZE_MB', 48, { min: 1, max: 2000 }),
      downloadTimeoutMs: num('DOWNLOAD_TIMEOUT_SEC', 180, { min: 10, max: 3600 }) * 1000,
      encodeTimeoutMs: num('ENCODE_TIMEOUT_SEC', 600, { min: 10, max: 7200 }) * 1000,
      queueLimit: num('QUEUE_LIMIT', 20, { min: 1, max: 500 }),
    };

    if (config.mode === 'webhook' && !config.webhookUrl) {
      throw new ConfigError('MODE=webhook requires WEBHOOK_URL (the public https URL of this bot)');
    }
    if (needsText(config) && !config.watermark.text) {
      throw new ConfigError(
        `WATERMARK_MODE=${config.watermark.mode} requires WATERMARK_TEXT (e.g. "@yourchannel")`,
      );
    }
    if (needsLogo(config) && !fs.existsSync(config.watermark.logoPath)) {
      throw new ConfigError(
        `WATERMARK_MODE=${config.watermark.mode} needs a logo image at ` +
          `${config.watermark.logoPath} — put a transparent PNG there or set WATERMARK_LOGO`,
      );
    }
    if (config.cookiesFile && !fs.existsSync(config.cookiesFile)) {
      throw new ConfigError(`COOKIES_FILE is set but ${config.cookiesFile} does not exist`);
    }

    // Stamping the logo over a covered watermark wants the same file the corner
    // mark uses — but unlike the corner mark this one degrades. Covering still
    // works without a logo (the blur is what actually hides the old mark), so a
    // missing file drops to blur-only rather than refusing to start. Drop the
    // PNG in later and it upgrades itself on the next restart.
    if (config.cover.enabled && config.cover.useLogo && !fs.existsSync(config.watermark.logoPath)) {
      config.cover.useLogo = false;
      config.cover.logoMissing = true;
    }

    return config;
  } finally {
    env = previous;
  }
}

/** `tiled` repeats the TEXT across the frame, so it needs text like the others. */
function needsText(config) {
  return ['text', 'both', 'tiled'].includes(config.watermark.mode);
}

function needsLogo(config) {
  return ['logo', 'both'].includes(config.watermark.mode);
}

export { ConfigError };
