import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { sweepTemp, freeSpaceMb, updateDownloader } from '../src/maintenance.js';
import { withRetry } from '../src/poster.js';

async function workspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'maint-test-'));
}

/** Work dirs are named with crypto.randomUUID(); only those are swept. */
const uuid = (n) => `0000000${n}-1111-2222-3333-444444444444`;

test('the sweeper removes abandoned work directories', async () => {
  const tmpDir = await workspace();
  try {
    const stale = path.join(tmpDir, uuid(1));
    await fs.mkdir(stale);
    await fs.writeFile(path.join(stale, 'video.mp4'), 'x'.repeat(1000));
    // Backdate it the way a container killed mid-encode would leave it.
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await fs.utimes(stale, old, old);

    const result = await sweepTemp({ tmpDir });
    assert.equal(result.removed, 1);
    await assert.rejects(fs.access(stale), 'the stale directory should be gone');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('the sweeper never touches anything it did not create', async () => {
  const tmpDir = await workspace();
  try {
    // The disk guard calls this with staleAfterMs: 0, which makes EVERY entry
    // eligible by age. If TMP_DIR is ever pointed somewhere shared — /tmp, say —
    // only the name check stands between this and deleting someone else's data.
    const foreign = path.join(tmpDir, 'someone-elses-database');
    await fs.mkdir(foreign);
    await fs.writeFile(path.join(foreign, 'data.db'), 'precious');
    const looseFile = path.join(tmpDir, 'notes.txt');
    await fs.writeFile(looseFile, 'also precious');

    const result = await sweepTemp({ tmpDir }, { staleAfterMs: 0 });
    assert.equal(result.removed, 0);
    await fs.access(path.join(foreign, 'data.db'));
    await fs.access(looseFile);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('the sweeper leaves a job that is still running alone', async () => {
  const tmpDir = await workspace();
  try {
    const active = path.join(tmpDir, uuid(2));
    await fs.mkdir(active);
    await fs.writeFile(path.join(active, 'downloading.mp4'), 'x');

    const result = await sweepTemp({ tmpDir });
    assert.equal(result.removed, 0);
    await fs.access(active);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('the sweeper is a no-op when the temp dir does not exist yet', async () => {
  const result = await sweepTemp({ tmpDir: '/nonexistent/path/for/a/test' });
  assert.deepEqual(result, { removed: 0, freedMb: 0 });
});

test('free space reports a real number', async () => {
  const free = await freeSpaceMb(os.tmpdir());
  assert.ok(free === null || (Number.isFinite(free) && free >= 0), `got ${free}`);
});

test('a failed update never throws — the bot keeps its current version', async () => {
  const result = await updateDownloader({
    ytdlpUpdateCmd: ['definitely-not-a-real-binary-xyz', 'install'],
    ytdlpPath: 'yt-dlp',
  });
  assert.equal(result.updated, false);
  assert.ok(result.reason);
});

test('an empty update command is handled rather than spawning nothing', async () => {
  const result = await updateDownloader({ ytdlpUpdateCmd: [], ytdlpPath: 'yt-dlp' });
  assert.equal(result.updated, false);
});

const telegramError = (code, retryAfter) => {
  const err = new Error(`telegram ${code}`);
  err.error_code = code;
  if (retryAfter !== undefined) err.parameters = { retry_after: retryAfter };
  return err;
};

test('a flood limit is waited out rather than losing the post', async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls += 1;
      if (calls === 1) throw telegramError(429, 0);
      return 'posted';
    },
    { baseDelayMs: 1 },
  );
  assert.equal(result, 'posted');
  assert.equal(calls, 2);
});

test('a server-side blip is retried', async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw telegramError(502);
      return 'posted';
    },
    { baseDelayMs: 1 },
  );
  assert.equal(result, 'posted');
  assert.equal(calls, 3);
});

test('a flood wait is capped so one post cannot stall the whole queue', async () => {
  // Telegram can ask for an hour. The queue is serial, so an uncapped sleep
  // here holds up every other repost behind it for that entire time.
  const started = Date.now();
  await assert.rejects(
    withRetry(async () => { throw telegramError(429, 3600); }, {
      attempts: 2,
      baseDelayMs: 1,
      maxWaitMs: 20,
    }),
    /telegram 429/,
  );
  assert.ok(Date.now() - started < 1000, 'the cap was not applied');
});

test('a local file error is not retried as if it were a network blip', async () => {
  // `!code` used to treat any error without a Telegram code as transient, so a
  // missing file or a TypeError was retried four times with backoff.
  let calls = 0;
  const missing = new Error('ENOENT: no such file');
  missing.code = 'ENOENT_NOT_NETWORK';
  await assert.rejects(
    withRetry(async () => { calls += 1; throw missing; }, { baseDelayMs: 1 }),
    /ENOENT/,
  );
  assert.equal(calls, 1);
});

test('a programmer error surfaces immediately instead of being retried', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls += 1; throw new TypeError('x is not a function'); }, {
      baseDelayMs: 1,
    }),
    /not a function/,
  );
  assert.equal(calls, 1);
});

test('sends do not retry a dropped connection — that risks double-posting', async () => {
  // If the connection dies after Telegram accepted the message, retrying posts
  // it twice and the Delete button only knows about the second copy.
  const dropped = new Error('socket hang up');
  dropped.code = 'ECONNRESET';

  let sendCalls = 0;
  await assert.rejects(
    withRetry(async () => { sendCalls += 1; throw dropped; }, {
      baseDelayMs: 1,
      retryNetwork: false,
    }),
    /socket hang up/,
  );
  assert.equal(sendCalls, 1);

  // Non-send calls still retry it.
  let otherCalls = 0;
  await assert.rejects(
    withRetry(async () => { otherCalls += 1; throw dropped; }, { attempts: 3, baseDelayMs: 1 }),
    /socket hang up/,
  );
  assert.equal(otherCalls, 3);
});

test('a bad request is NOT retried — repeating it cannot help', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        throw telegramError(400);
      },
      { baseDelayMs: 1 },
    ),
    /telegram 400/,
  );
  assert.equal(calls, 1);
});

test('retries give up eventually instead of looping forever', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        throw telegramError(500);
      },
      { attempts: 3, baseDelayMs: 1 },
    ),
    /telegram 500/,
  );
  assert.equal(calls, 3);
});

test('a call that works first time is not delayed at all', async () => {
  const started = process.hrtime.bigint();
  const result = await withRetry(async () => 'immediate', { baseDelayMs: 1000 });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(result, 'immediate');
  assert.ok(elapsedMs < 100, `took ${elapsedMs}ms`);
});
