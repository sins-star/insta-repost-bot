/**
 * Guards the crash that took the whole bot down.
 *
 * `queue.push()` starts the job immediately. If the caller awaits anything —
 * a Telegram status edit, say — before attaching a rejection handler, and the
 * job fails fast (yt-dlp missing, spawn ENOENT), Node sees an unhandled
 * rejection and terminates the process by default. The bot dies and every other
 * queued job dies with it.
 *
 * This has to run in a child process, because the failure mode IS process
 * death — it cannot be caught from inside the test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const queuePath = fileURLToPath(new URL('../src/queue.js', import.meta.url));

/** The exact shape of handleUrl: push, await a slow status edit, then handle. */
const script = `
import { Queue } from ${JSON.stringify(queuePath)};

const queue = new Queue();
const slowTelegramEdit = () => new Promise((r) => setTimeout(r, 50));

async function handleUrl(n) {
  const job = queue.push(async () => {
    throw new Error('yt-dlp is not installed (job ' + n + ')');
  });

  // The fix: attach the handler synchronously, before any await.
  const settled = job.promise.then(() => null, (err) => err);

  if (job.position > 0) await slowTelegramEdit();

  const err = await settled;
  if (!err) throw new Error('expected a failure');
}

// Two links in one message: the second one queues behind the first, which is
// what makes position > 0 and opens the window.
await Promise.all([handleUrl(1), handleUrl(2)]);
await slowTelegramEdit();
console.log('STILL ALIVE');
`;

test('a job that fails while a status edit is in flight does not kill the process', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unhandled-'));
  try {
    const file = path.join(dir, 'crash.mjs');
    await fs.writeFile(file, script);

    const { stdout } = await exec(process.execPath, [file], { timeout: 20000 });
    assert.match(stdout, /STILL ALIVE/, 'the process died on an unhandled rejection');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
