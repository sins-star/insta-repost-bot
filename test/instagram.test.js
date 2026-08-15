import test from 'node:test';
import assert from 'node:assert/strict';
import { findInstagramUrls, explainFailure, buildCaption } from '../src/instagram.js';

test('finds a plain reel link', () => {
  assert.deepEqual(findInstagramUrls('https://www.instagram.com/reel/ABC123/'), [
    'https://www.instagram.com/reel/ABC123/',
  ]);
});

test('strips tracking params so the same post dedupes', () => {
  const found = findInstagramUrls(
    'https://www.instagram.com/reel/ABC123/?igsh=xyz https://www.instagram.com/reel/ABC123/?utm_source=ig',
  );
  assert.equal(found.length, 1);
  assert.equal(found[0], 'https://www.instagram.com/reel/ABC123/');
});

test('drops trailing sentence punctuation', () => {
  assert.deepEqual(findInstagramUrls('look at https://www.instagram.com/p/XYZ/.'), [
    'https://www.instagram.com/p/XYZ/',
  ]);
});

test('accepts every post path Instagram uses', () => {
  for (const path of ['reel', 'reels', 'p', 'tv', 'share']) {
    assert.equal(
      findInstagramUrls(`https://www.instagram.com/${path}/ABC/`).length,
      1,
      `expected /${path}/ to be recognised`,
    );
  }
});

test('ignores profiles, the homepage and other hosts', () => {
  assert.deepEqual(findInstagramUrls('https://www.instagram.com/someprofile/'), []);
  assert.deepEqual(findInstagramUrls('https://www.instagram.com/'), []);
  assert.deepEqual(findInstagramUrls('https://tiktok.com/reel/ABC/'), []);
  assert.deepEqual(findInstagramUrls(''), []);
  assert.deepEqual(findInstagramUrls(undefined), []);
});

test('finds several links in one message', () => {
  const found = findInstagramUrls(
    'https://instagram.com/reel/AAA/ and also https://www.instagram.com/p/BBB/',
  );
  assert.equal(found.length, 2);
});

test('rate-limit wording is not mistaken for a login problem', () => {
  const { reason, hint } = explainFailure(
    'ERROR: You have exceeded the rate-limit for accessing posts anonymously',
  );
  assert.match(reason, /rate-limited/i);
  assert.match(hint, /15 minutes/);
});

test('expired cookies get their own advice', () => {
  const { reason } = explainFailure('WARNING: The provided Instagram account cookies are no longer valid');
  assert.match(reason, /expired/i);
});

test('unknown failures still return something actionable', () => {
  const { reason, hint } = explainFailure('something nobody has seen before');
  assert.ok(reason.length > 0);
  assert.ok(hint.length > 0);
});

const captionConfig = (overrides = {}) => ({
  caption: { mode: 'original', suffix: '', maxLength: 1024, ...overrides },
});

test('uses the original caption', () => {
  const text = buildCaption({ caption: 'hello world', uploader: 'someone', url: 'u' }, captionConfig());
  assert.equal(text, 'hello world');
});

test('caption mode none drops the original', () => {
  const text = buildCaption(
    { caption: 'hello', uploader: '', url: '' },
    captionConfig({ mode: 'none' }),
  );
  assert.equal(text, '');
});

test('suffix placeholders are filled in', () => {
  const text = buildCaption(
    { caption: 'clip', uploader: 'creator', url: 'https://instagram.com/reel/A/' },
    captionConfig({ suffix: 'via {uploader} — {url}' }),
  );
  assert.equal(text, 'clip\n\nvia @creator — https://instagram.com/reel/A/');
});

test('an already-@ uploader is not doubled up', () => {
  const text = buildCaption(
    { caption: '', uploader: '@creator', url: '' },
    captionConfig({ suffix: '{uploader}' }),
  );
  assert.equal(text, '@creator');
});

test('captions are truncated below Telegram hard limit', () => {
  const text = buildCaption(
    { caption: 'x'.repeat(3000), uploader: '', url: '' },
    captionConfig({ maxLength: 1024 }),
  );
  assert.ok(text.length <= 1024, `caption was ${text.length} chars`);
  assert.ok(text.endsWith('…'));
});

test('maxLength 0 means no caption at all', () => {
  const text = buildCaption({ caption: 'hello', uploader: '', url: '' }, captionConfig({ maxLength: 0 }));
  assert.equal(text, '');
});
