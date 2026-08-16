import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, ConfigError } from '../src/config.js';

const valid = {
  BOT_TOKEN: '123456:ABC',
  CHANNEL_ID: '@mychannel',
  ADMIN_IDS: '111,222',
  WATERMARK_MODE: 'text',
  WATERMARK_TEXT: '@mychannel',
};

test('a minimal valid environment loads', () => {
  const config = loadConfig(valid);
  assert.equal(config.channelId, '@mychannel');
  assert.deepEqual(config.adminIds, [111, 222]);
  assert.equal(config.mode, 'polling');
});

test('the token is the only thing that must be set', () => {
  const env = { ...valid };
  delete env.BOT_TOKEN;
  assert.throws(() => loadConfig(env), /BOT_TOKEN/, 'BOT_TOKEN should be reported by name');
});

test('channel and admins may be left for the bot to discover', () => {
  // Both are learned at runtime — the owner by /claim, the channel by being
  // added to one — so neither is required up front.
  for (const key of ['CHANNEL_ID', 'ADMIN_IDS']) {
    const env = { ...valid };
    delete env[key];
    assert.doesNotThrow(() => loadConfig(env), `${key} should be optional`);
  }
});

test('a username in ADMIN_IDS is caught at boot, not at post time', () => {
  assert.throws(() => loadConfig({ ...valid, ADMIN_IDS: '@sins' }), /numeric Telegram user ids/);
});

test('a channel name without @ is rejected', () => {
  assert.throws(() => loadConfig({ ...valid, CHANNEL_ID: 'mychannel' }), /@channelname/);
});

test('a numeric channel id is kept as a number', () => {
  assert.equal(loadConfig({ ...valid, CHANNEL_ID: '-1001234567890' }).channelId, -1001234567890);
});

test('text watermark without any text is refused', () => {
  const env = { ...valid };
  delete env.WATERMARK_TEXT;
  assert.throws(() => loadConfig(env), /requires WATERMARK_TEXT/);
});

test('tiled mode needs text too', () => {
  const env = { ...valid, WATERMARK_MODE: 'tiled' };
  delete env.WATERMARK_TEXT;
  assert.throws(() => loadConfig(env), /requires WATERMARK_TEXT/);
});

test('logo mode refuses to start without the logo file', () => {
  assert.throws(
    () => loadConfig({ ...valid, WATERMARK_MODE: 'logo', WATERMARK_LOGO: '/nope/missing.png' }),
    /needs a logo image/,
  );
});

test('watermark none needs neither text nor logo', () => {
  const env = { ...valid, WATERMARK_MODE: 'none' };
  delete env.WATERMARK_TEXT;
  assert.equal(loadConfig(env).watermark.mode, 'none');
});

test('a missing logo downgrades covering instead of blocking startup', () => {
  // Covering still works without a logo — the blur is what hides the old mark —
  // so this must not be a boot failure the way a logo corner watermark is.
  const config = loadConfig({ ...valid, COVER_EXISTING: 'true', COVER_WITH_LOGO: 'true' });
  assert.equal(config.cover.enabled, true);
  assert.equal(config.cover.useLogo, false);
  assert.equal(config.cover.logoMissing, true);
});

test('covering can be switched off entirely', () => {
  assert.equal(loadConfig({ ...valid, COVER_EXISTING: 'false' }).cover.enabled, false);
});

test('webhook mode without a URL is refused', () => {
  assert.throws(() => loadConfig({ ...valid, MODE: 'webhook' }), /requires WEBHOOK_URL/);
});

test('a bare @ or a spaced name is not a channel', () => {
  for (const bad of ['@', '@ my chan', '@ab', 'mychannel', '@has-a-dash']) {
    assert.throws(() => loadConfig({ ...valid, CHANNEL_ID: bad }), /CHANNEL_ID/, `accepted "${bad}"`);
  }
});

test('a positive numeric id is refused — that is a user, not a channel', () => {
  assert.throws(() => loadConfig({ ...valid, CHANNEL_ID: '123456' }), /negative numeric id/);
});

test('counts must be whole numbers', () => {
  // `for (row = 0; row < 3.7; row++)` silently drew 4 rows spaced for 3.7.
  assert.throws(() => loadConfig({ ...valid, WATERMARK_TILE_ROWS: '3.7' }), /whole number/);
  assert.throws(() => loadConfig({ ...valid, QUEUE_LIMIT: '2.5' }), /whole number/);
  assert.throws(() => loadConfig({ ...valid, PORT: '8080.7' }), /whole number/);
});

test('numbers that are not plain decimals are rejected', () => {
  // Number('0x1f90') is 8080 — a typo that silently becomes a valid port.
  assert.throws(() => loadConfig({ ...valid, PORT: '0x1f90' }), /must be a number/);
  assert.throws(() => loadConfig({ ...valid, PORT: '1e3' }), /must be a number/);
});

test('the chroma key cannot smuggle extra filters into the graph', () => {
  // This value is concatenated raw into the ffmpeg filtergraph.
  assert.throws(
    () => loadConfig({ ...valid, WATERMARK_CHROMA_KEY: '0x000000:1:1,drawbox=x=0' }),
    /must be a colour/,
  );
  assert.equal(
    loadConfig({ ...valid, WATERMARK_CHROMA_KEY: '0x000000' }).watermark.chromaKey,
    '0x000000',
  );
  assert.equal(loadConfig({ ...valid, WATERMARK_CHROMA_KEY: 'black' }).watermark.chromaKey, 'black');
});

test('out-of-range numbers are rejected with their bounds', () => {
  assert.throws(() => loadConfig({ ...valid, WATERMARK_OPACITY: '5' }), /between 0 and 1/);
  assert.throws(() => loadConfig({ ...valid, WATERMARK_OPACITY: 'quite' }), /must be a number/);
});

test('booleans accept the usual spellings and reject nonsense', () => {
  assert.equal(loadConfig({ ...valid, FALLBACK_GALLERYDL: 'no' }).fallbackEnabled, false);
  assert.equal(loadConfig({ ...valid, FALLBACK_GALLERYDL: 'TRUE' }).fallbackEnabled, true);
  assert.throws(() => loadConfig({ ...valid, FALLBACK_GALLERYDL: 'maybe' }), /must be true or false/);
});

test('an unknown enum value lists the valid ones', () => {
  assert.throws(() => loadConfig({ ...valid, WATERMARK_POSITION: 'middleish' }), /tl, tr, bl, br/);
});

test('escaped newlines in the caption suffix become real ones', () => {
  const config = loadConfig({ ...valid, CAPTION_SUFFIX: 'line one\\nline two' });
  assert.equal(config.caption.suffix, 'line one\nline two');
});

test('config errors are ConfigError so main() can print them kindly', () => {
  try {
    loadConfig({});
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof ConfigError);
  }
});

test('reading a custom env does not disturb the real process.env', () => {
  const before = process.env.BOT_TOKEN;
  loadConfig(valid);
  assert.equal(process.env.BOT_TOKEN, before);
});
