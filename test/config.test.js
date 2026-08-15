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

test('each required variable is named when missing', () => {
  for (const key of ['BOT_TOKEN', 'CHANNEL_ID', 'ADMIN_IDS']) {
    const env = { ...valid };
    delete env[key];
    assert.throws(() => loadConfig(env), new RegExp(key), `${key} should be reported by name`);
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

test('webhook mode without a URL is refused', () => {
  assert.throws(() => loadConfig({ ...valid, MODE: 'webhook' }), /requires WEBHOOK_URL/);
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
