import test from 'node:test';
import assert from 'node:assert/strict';
import { Queue } from '../src/queue.js';

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

test('jobs run one at a time, never overlapping', async () => {
  const queue = new Queue();
  let active = 0;
  let maxActive = 0;

  const job = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await tick(10);
    active -= 1;
  };

  await Promise.all([queue.push(job).promise, queue.push(job).promise, queue.push(job).promise]);
  assert.equal(maxActive, 1, 'two encodes must never run at once');
  assert.equal(queue.completed, 3);
});

test('jobs run in the order they were pushed', async () => {
  const queue = new Queue();
  const order = [];
  const make = (n) => async () => {
    await tick(10 - n);
    order.push(n);
  };
  await Promise.all([1, 2, 3].map((n) => queue.push(make(n)).promise));
  assert.deepEqual(order, [1, 2, 3]);
});

test('position tells the caller how many are ahead', async () => {
  const queue = new Queue();
  const first = queue.push(() => tick(20));
  const second = queue.push(() => tick(1));
  assert.equal(first.position, 0);
  assert.equal(second.position, 1);
  await Promise.all([first.promise, second.promise]);
});

test('one failure does not stop the queue', async () => {
  const queue = new Queue();
  const failing = queue.push(async () => {
    throw new Error('boom');
  });
  await assert.rejects(failing.promise, /boom/);

  const after = await queue.push(async () => 'still working').promise;
  assert.equal(after, 'still working');
  assert.equal(queue.failed, 1);
  assert.equal(queue.completed, 1);
});

test('a full queue refuses new work instead of growing forever', async () => {
  const queue = new Queue({ limit: 2 });
  const jobs = [queue.push(() => tick(30)), queue.push(() => tick(30))];
  assert.throws(() => queue.push(() => tick(1)), /queue is full/);
  await Promise.all(jobs.map((j) => j.promise));
});

test('size counts the running job as well as those waiting', async () => {
  const queue = new Queue();
  const running = queue.push(() => tick(20));
  const waiting = queue.push(() => tick(1));
  assert.equal(queue.size, 2);
  await Promise.all([running.promise, waiting.promise]);
  assert.equal(queue.size, 0);
});
