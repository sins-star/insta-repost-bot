import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFilterGraph,
  escapeFilterPath,
  overlayPosition,
  textPosition,
  oppositeCorner,
} from '../src/watermark.js';

const base = {
  width: 1080,
  height: 1920,
  fontPath: '/fonts/DejaVuSans-Bold.ttf',
  textFilePath: '/tmp/wm-text.txt',
};

test('mode none draws nothing', () => {
  assert.equal(buildFilterGraph({ ...base, mode: 'none' }), null);
});

test('missing dimensions are an error, not a guess', () => {
  assert.throws(() => buildFilterGraph({ ...base, mode: 'text', width: 0 }), /width and height/);
});

test('an unknown mode is rejected loudly', () => {
  assert.throws(() => buildFilterGraph({ ...base, mode: 'sideways' }), /unknown watermark mode/);
});

test('logo mode scales the logo to a fraction of the real frame width', () => {
  const graph = buildFilterGraph({ ...base, mode: 'logo', scale: 0.2 });
  // 1080 * 0.2 = 216
  assert.match(graph, /\[1:v\]scale=216:-1/);
  assert.match(graph, /\[0:v\]\[wm\]overlay=/);
});

test('logo opacity becomes an alpha multiplier', () => {
  const graph = buildFilterGraph({ ...base, mode: 'logo', opacity: 0.5 });
  assert.match(graph, /colorchannelmixer=aa=0\.500/);
});

test('text mode uses textfile and disables % expansion', () => {
  const graph = buildFilterGraph({ ...base, mode: 'text' });
  assert.match(graph, /textfile='\/tmp\/wm-text\.txt'/);
  assert.match(graph, /expansion=none/);
  // A '%' in the watermark would otherwise be read as a strftime token.
});

test('text size follows the shorter side', () => {
  const portrait = buildFilterGraph({ ...base, mode: 'text', textScale: 0.05 });
  // min(1080, 1920) * 0.05 = 54
  assert.match(portrait, /fontsize=54/);
});

test('both mode puts the text in the opposite corner from the logo', () => {
  const graph = buildFilterGraph({ ...base, mode: 'both', position: 'br' });
  assert.match(graph, /overlay=W-w-32:H-h-32/);
  // opposite of br is tl, so the text sits at the fixed margin
  assert.match(graph, /:x=32:y=32/);
  assert.match(graph, /\[base\]/);
});

test('tiled mode draws one text per grid cell', () => {
  const graph = buildFilterGraph({ ...base, mode: 'tiled', tileRows: 3, tileCols: 4 });
  assert.equal(graph.match(/drawtext=/g).length, 12);
});

test('overlay and drawtext use their own coordinate variables', () => {
  // overlay: W/H are the frame, w/h the overlay. drawtext: w/h frame, tw/th text.
  assert.deepEqual(overlayPosition('tr', 10), { x: 'W-w-10', y: '10' });
  assert.deepEqual(textPosition('tr', 10), { x: 'w-tw-10', y: '10' });
  assert.deepEqual(overlayPosition('center', 10), { x: '(W-w)/2', y: '(H-h)/2' });
  assert.deepEqual(textPosition('bl', 10), { x: '10', y: 'h-th-10' });
});

test('every corner has an opposite', () => {
  assert.equal(oppositeCorner('br'), 'tl');
  assert.equal(oppositeCorner('tl'), 'br');
  assert.equal(oppositeCorner('tr'), 'bl');
  assert.equal(oppositeCorner('bl'), 'tr');
});

test('paths are escaped so the filtergraph parser keeps them whole', () => {
  // ':' separates filter options and would otherwise split the path in two.
  assert.equal(escapeFilterPath('C:/fonts/a.ttf'), 'C\\:/fonts/a.ttf');
  assert.equal(escapeFilterPath("/tmp/it's.txt"), "/tmp/it\\'s.txt");
  assert.equal(escapeFilterPath('a\\b'), 'a\\\\b');
});

test('margin is measured against width, consistently', () => {
  const graph = buildFilterGraph({ ...base, mode: 'logo', margin: 0.05 });
  // 1080 * 0.05 = 54
  assert.match(graph, /overlay=W-w-54:H-h-54/);
});
