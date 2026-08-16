import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { RuntimeState } from '../src/runtime.js';
import { loadConfig } from '../src/config.js';

async function workspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'runtime-test-'));
}

test('the first claim wins and the second is refused', async () => {
  const dir = await workspace();
  try {
    const state = new RuntimeState(dir);
    await state.load();
    assert.equal(state.isClaimed, false);

    assert.equal(await state.claim(111), true);
    assert.deepEqual(state.adminIds, [111]);

    // Whoever else turns up, the answer is no.
    assert.equal(await state.claim(222), false);
    assert.deepEqual(state.adminIds, [111]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a claim survives a restart', async () => {
  const dir = await workspace();
  try {
    const first = new RuntimeState(dir);
    await first.load();
    await first.claim(4242);
    await first.setChannel(-1001234567890);

    const afterRestart = new RuntimeState(dir);
    await afterRestart.load();
    assert.deepEqual(afterRestart.adminIds, [4242]);
    assert.equal(afterRestart.channelId, -1001234567890);
    assert.equal(afterRestart.isClaimed, true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('the remembered logo path survives a restart', async () => {
  const dir = await workspace();
  try {
    const state = new RuntimeState(dir);
    await state.load();
    await state.setLogo('/app/data/watermark.png');

    const reloaded = new RuntimeState(dir);
    await reloaded.load();
    assert.equal(reloaded.logoPath, '/app/data/watermark.png');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a fresh install starts empty rather than failing', async () => {
  const dir = await workspace();
  try {
    const state = new RuntimeState(dir);
    await state.load();
    assert.deepEqual(state.adminIds, []);
    assert.equal(state.channelId, null);
    assert.equal(state.logoPath, null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('corrupt state does not stop the bot starting', async () => {
  const dir = await workspace();
  try {
    await fs.writeFile(path.join(dir, 'runtime.json'), '{ this is not json');
    const state = new RuntimeState(dir);
    await state.load();
    assert.deepEqual(state.adminIds, []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ── config now tolerates an unconfigured bot ────────────────────────────────

const minimal = { BOT_TOKEN: '123456:ABC', WATERMARK_MODE: 'text', WATERMARK_TEXT: '@x' };

test('the token alone is enough to boot', () => {
  const config = loadConfig(minimal);
  assert.equal(config.channelId, null);
  assert.deepEqual(config.adminIds, []);
  assert.equal(config.allowClaim, true);
});

test('a bot nobody can own or claim is refused at boot', () => {
  // Otherwise it would start, look healthy, and ignore every message forever.
  assert.throws(
    () => loadConfig({ ...minimal, ALLOW_CLAIM: 'false' }),
    /nobody could ever use this bot/,
  );
});

test('explicit values are still validated as strictly as before', () => {
  assert.throws(() => loadConfig({ ...minimal, CHANNEL_ID: '@' }), /CHANNEL_ID/);
  assert.throws(() => loadConfig({ ...minimal, ADMIN_IDS: '@sins' }), /numeric/);
  assert.equal(loadConfig({ ...minimal, ADMIN_IDS: '5,6' }).adminIds.length, 2);
});

test('the claim window is a whole number of minutes', () => {
  assert.throws(() => loadConfig({ ...minimal, CLAIM_WINDOW_MIN: '2.5' }), /whole number/);
  assert.equal(loadConfig({ ...minimal, CLAIM_WINDOW_MIN: '30' }).claimWindowMin, 30);
});
