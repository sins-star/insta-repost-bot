import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanCaption } from '../src/clean.js';

const OURS = { keep: ['MyChannel', 'Bami_star_bot'] };

test('foreign channel tags are removed and ours is stamped on', () => {
  const { text, removed } = cleanCaption('Great clip! Follow @SomeOtherChannel for more', OURS);
  assert.ok(!text.includes('@SomeOtherChannel'));
  assert.ok(text.includes('@MyChannel'));
  assert.equal(removed, 1);
});

test('our own tag survives, in any case', () => {
  const { text } = cleanCaption('brought to you by @mychannel', OURS);
  assert.ok(text.includes('@mychannel'));
  // Not doubled up by the auto-append.
  assert.equal((text.match(/@mychannel/gi) || []).length, 1);
});

test('the bot own username is never scrubbed', () => {
  const { text } = cleanCaption('via @Bami_star_bot', OURS);
  assert.ok(text.includes('@Bami_star_bot'));
});

test('t.me links and full URLs are removed', () => {
  const { text, removed } = cleanCaption(
    'join t.me/othergang now\nmore at https://example.com/page?x=1',
    OURS,
  );
  assert.ok(!text.includes('t.me'));
  assert.ok(!text.includes('example.com'));
  assert.equal(removed, 2);
});

test('a line that was only a link disappears entirely, not into blank debris', () => {
  const { text } = cleanCaption('Line one\n\nhttps://t.me/junkchannel\n\nLine two', OURS);
  assert.ok(!/\n{3,}/.test(text), 'no stacked blank lines');
  assert.match(text, /Line one\n\nLine two/);
});

test('emails are not mistaken for mentions', () => {
  const { text, removed } = cleanCaption('contact me: someone@gmail.com', OURS);
  assert.ok(text.includes('someone@gmail.com'));
  assert.equal(removed, 0);
});

test('a caption that is nothing but junk becomes just our tag', () => {
  const { text } = cleanCaption('@spam1 t.me/spam2 https://spam.example', OURS);
  assert.equal(text, '@MyChannel');
});

test('an empty caption still gets branded', () => {
  assert.equal(cleanCaption('', OURS).text, '@MyChannel');
});

test('no username known: cleans but appends nothing', () => {
  const { text } = cleanCaption('follow @stranger for stuff', { keep: ['', undefined] });
  assert.ok(!text.includes('@stranger'));
  assert.ok(!text.includes('undefined'));
  assert.equal(text, 'follow for stuff');
});

test('hashtags and ordinary text are untouched', () => {
  const { text, removed } = cleanCaption('sunset #vibes #ocean', OURS);
  assert.match(text, /sunset #vibes #ocean/);
  assert.equal(removed, 0);
});

test('multiple foreign tags all counted', () => {
  const { removed } = cleanCaption('@one_chan @two_chan and t.me/three', OURS);
  assert.equal(removed, 3);
});
