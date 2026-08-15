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

const region = { x: 800, y: 1600, w: 200, h: 100 };

test('covering blurs the detected region back over the frame', () => {
  const graph = buildFilterGraph({ ...base, mode: 'none', cover: region });
  assert.match(graph, /crop=200:100:800:1600/);
  assert.match(graph, /boxblur=/);
  assert.match(graph, /\[covbase\]\[covblur\]overlay=800:1600/);
  // mode none still has to terminate at [v] so ffmpeg has something to map
  assert.match(graph, /\[v\]$/);
});

test('mode none with nothing to cover skips encoding entirely', () => {
  assert.equal(buildFilterGraph({ ...base, mode: 'none', cover: null }), null);
});

test('the cover logo is centred on the region it hides', () => {
  const graph = buildFilterGraph({ ...base, mode: 'none', cover: region, coverLogo: true });
  // 200 * 0.9 = 180 wide, 100 * 0.9 = 90 tall, fitted inside both
  assert.match(graph, /\[covlogo\]/);
  assert.match(graph, /scale=180:90:force_original_aspect_ratio=decrease/);
  assert.match(graph, /overlay=800\+\(200-w\)\/2:1600\+\(100-h\)\/2/);
});

test('the logo input is split when both the corner and the patch need it', () => {
  const graph = buildFilterGraph({ ...base, mode: 'logo', cover: region, coverLogo: true });
  // An ffmpeg filter output can only be consumed once; without the split this
  // graph is rejected outright.
  assert.match(graph, /\[1:v\]split=2\[logoa\]\[logob\]/);
});

test('the logo input is not split when only one consumer needs it', () => {
  const cornerOnly = buildFilterGraph({ ...base, mode: 'logo', cover: null });
  assert.doesNotMatch(cornerOnly, /split=2\[logoa\]/);

  const patchOnly = buildFilterGraph({ ...base, mode: 'text', cover: region, coverLogo: true });
  assert.doesNotMatch(patchOnly, /split=2\[logoa\]/);
});

test('covering composes with a text corner mark', () => {
  const graph = buildFilterGraph({ ...base, mode: 'text', cover: region });
  assert.match(graph, /boxblur=/);
  assert.match(graph, /drawtext=/);
  assert.match(graph, /\[covout\]drawtext/);
});

test('a chroma key is applied to the logo before it is split', () => {
  const graph = buildFilterGraph({
    ...base,
    mode: 'logo',
    cover: region,
    coverLogo: true,
    chromaKey: '0x000000',
  });
  assert.match(graph, /\[1:v\]colorkey=0x000000/);
  assert.match(graph, /\[logokey\]split=2/);
});

test('blur radius stays within the CHROMA plane limit, not the luma one', () => {
  // boxblur applies the same radius to chroma, which is half resolution in
  // yuv420p — so the real ceiling is a quarter of the patch. An earlier version
  // clamped to half and every cover encode failed above COVER_BLUR=0.25,
  // posting the video with no watermark at all.
  for (const blurStrength of [0.02, 0.16, 0.25, 0.3, 0.5]) {
    for (const size of [8, 20, 100, 333]) {
      const graph = buildFilterGraph({
        ...base,
        mode: 'none',
        cover: { x: 0, y: 0, w: size, h: size },
        blurStrength,
      });
      const radius = Number(graph.match(/boxblur=(\d+):/)[1]);
      assert.ok(
        radius <= Math.floor(size / 4),
        `radius ${radius} exceeds the chroma limit ${Math.floor(size / 4)} for a ${size}px patch`,
      );
      assert.ok(radius >= 1, 'radius must be at least 1');
    }
  }
});

test('a patch too small to blur is skipped rather than encoded badly', () => {
  // Below 8px there is no legal chroma radius at all.
  assert.equal(
    buildFilterGraph({ ...base, mode: 'none', cover: { x: 0, y: 0, w: 6, h: 6 } }),
    null,
  );
});

test('the cover logo is bounded on both axes so it cannot escape the patch', () => {
  // scale=W:-1 leaves the height unbounded, so a tall logo overflows the region
  // and paints over the video around it — silently, since the graph still runs.
  const graph = buildFilterGraph({
    ...base,
    mode: 'none',
    cover: { x: 100, y: 100, w: 300, h: 120 },
    coverLogo: true,
  });
  assert.match(graph, /scale=270:108:force_original_aspect_ratio=decrease/);
});

test('margin is measured against width, consistently', () => {
  const graph = buildFilterGraph({ ...base, mode: 'logo', margin: 0.05 });
  // 1080 * 0.05 = 54
  assert.match(graph, /overlay=W-w-54:H-h-54/);
});
