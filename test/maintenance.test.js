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

test('the sweeper removes abandoned work directories', async () => {
  const tmpDir = await workspace();
  try {
    const stale = path.join(tmpDir, 'stale-job');
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

test('the sweeper leaves a job that is still running alone', async () => {
  const tmpDir = await workspace();
  try {
    const active = path.join(tmpDir, 'active-job');
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
