import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { broadcast, deletePost } from '../src/poster.js';
import { RuntimeState } from '../src/runtime.js';

const config = { ffprobePath: 'ffprobe' };
const photo = [{ path: '/tmp/nope.jpg', type: 'photo' }];

/** A stand-in for grammY's api that records what it was asked to send. */
function fakeBot({ failOn = [] } = {}) {
  const calls = [];
  let nextId = 100;
  return {
    calls,
    api: {
      async sendPhoto(chatId) {
        calls.push({ chatId });
        if (failOn.includes(chatId)) {
          const err = new Error('CHAT_WRITE_FORBIDDEN');
          err.error_code = 403;
          throw err;
        }
        return { message_id: (nextId += 1) };
      },
      async deleteMessage(chatId, messageId) {
        calls.push({ deleted: { chatId, messageId } });
      },
    },
  };
}

const dests = [
  { id: -100111, title: 'Main channel' },
  { id: -100222, title: 'Backup channel' },
  { id: -100333, title: 'Team group' },
];

test('one link reaches every destination', async () => {
  const bot = fakeBot();
  const { sent, failed } = await broadcast(bot, config, { items: photo, caption: '' }, dests);

  assert.equal(sent.length, 3);
  assert.equal(failed.length, 0);
  assert.deepEqual(
    bot.calls.map((c) => c.chatId),
    [-100111, -100222, -100333],
  );
});

test('one dead destination does not cost you the others', async () => {
  // Demoted in one group is the common case, and it must not sink the post.
  const bot = fakeBot({ failOn: [-100222] });
  const { sent, failed } = await broadcast(bot, config, { items: photo, caption: '' }, dests);

  assert.equal(sent.length, 2, 'the healthy destinations should still receive it');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].title, 'Backup channel');
  assert.match(failed[0].reason, /FORBIDDEN/);
});

test('failing everywhere is reported, not swallowed', async () => {
  const bot = fakeBot({ failOn: [-100111, -100222, -100333] });
  const { sent, failed } = await broadcast(bot, config, { items: photo, caption: '' }, dests);
  assert.equal(sent.length, 0);
  assert.equal(failed.length, 3);
});

test('delete removes the post from every destination it reached', async () => {
  const bot = fakeBot();
  const targets = [
    { chatId: -100111, messageIds: [1, 2] },
    { chatId: -100222, messageIds: [7] },
  ];
  const { deleted, total, errors } = await deletePost(bot, targets);

  assert.equal(total, 3);
  assert.equal(deleted, 3);
  assert.equal(errors.length, 0);
  assert.deepEqual(
    bot.calls.map((c) => `${c.deleted.chatId}/${c.deleted.messageId}`),
    ['-100111/1', '-100111/2', '-100222/7'],
  );
});

// ── the destination list ────────────────────────────────────────────────────

async function workspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'dest-test-'));
}

test('destinations are remembered and never duplicated', async () => {
  const dir = await workspace();
  try {
    const state = new RuntimeState(dir);
    await state.load();

    assert.equal(await state.addDestination({ id: -100111, title: 'Main', type: 'channel', addedBy: 7 }), true);
    // Being re-added, or a status change arriving twice, must not double it up.
    assert.equal(await state.addDestination({ id: -100111, title: 'Main', type: 'channel', addedBy: 7 }), false);
    assert.equal(state.destinations.length, 1);

    await state.addDestination({ id: -100222, title: 'Second', type: 'supergroup', addedBy: 7 });
    assert.equal(state.destinations.length, 2);

    const reloaded = new RuntimeState(dir);
    await reloaded.load();
    assert.equal(reloaded.destinations.length, 2);
    assert.equal(reloaded.hasDestination(-100222), true);
    assert.equal(reloaded.hasDestination('-100222'), true, 'ids may arrive as strings');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('being removed from a chat drops it from the list', async () => {
  const dir = await workspace();
  try {
    const state = new RuntimeState(dir);
    await state.load();
    await state.addDestination({ id: -100111, title: 'Main', type: 'channel', addedBy: 7 });

    assert.equal(await state.removeDestination(-100111), true);
    assert.equal(state.destinations.length, 0);
    // Removing something that was never there is a no-op, not an error.
    assert.equal(await state.removeDestination(-100999), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('who added the bot is recorded, so an intruder is identifiable', async () => {
  const dir = await workspace();
  try {
    const state = new RuntimeState(dir);
    await state.load();
    await state.addDestination({ id: -100111, title: 'Main', type: 'channel', addedBy: 4242 });
    assert.equal(state.destinations[0].addedBy, 4242);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
