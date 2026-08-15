import test from 'node:test';
import assert from 'node:assert/strict';
import { chunk, ALBUM_LIMIT } from '../src/poster.js';

test('albums never exceed Telegram limit of 10', () => {
  for (const count of [1, 2, 9, 10, 11, 12, 19, 20, 21, 30]) {
    const items = Array.from({ length: count }, (_, i) => i);
    for (const group of chunk(items)) {
      assert.ok(group.length <= ALBUM_LIMIT, `group of ${group.length} for ${count} items`);
    }
  }
});

test('a trailing group is never left with a single item', () => {
  // sendMediaGroup requires 2-10. An 11-item carousel used to split into
  // [10, 1] — and that trailing single was rejected by Telegram AFTER the
  // first ten were already live in the channel, with no Delete button.
  for (let count = 2; count <= 40; count += 1) {
    const groups = chunk(Array.from({ length: count }, (_, i) => i));
    for (const group of groups) {
      assert.ok(group.length >= 2, `${count} items produced a group of ${group.length}`);
    }
  }
});

test('11 items rebalance to 9 and 2', () => {
  const groups = chunk(Array.from({ length: 11 }, (_, i) => i));
  assert.deepEqual(groups.map((g) => g.length), [9, 2]);
});

test('21 items rebalance the tail only', () => {
  const groups = chunk(Array.from({ length: 21 }, (_, i) => i));
  assert.deepEqual(groups.map((g) => g.length), [10, 9, 2]);
});

test('no item is lost or duplicated by rebalancing', () => {
  for (const count of [1, 2, 10, 11, 20, 21, 33]) {
    const items = Array.from({ length: count }, (_, i) => i);
    const flat = chunk(items).flat();
    assert.deepEqual(flat, items, `order or contents changed for ${count} items`);
  }
});

test('a single item is left alone for the caller to send directly', () => {
  assert.deepEqual(chunk([1]), [[1]]);
});
