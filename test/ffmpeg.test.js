/**
 * Integration tests that run ffmpeg for real.
 *
 * A filter graph that looks right in a string assertion can still be rejected
 * by ffmpeg — wrong variable for the filter, an unescaped path, a chain that
 * does not connect. These build actual media and watermark it, which is the
 * only way to know the graph parses.
 *
 * Skipped automatically where ffmpeg is not installed, so the suite still runs
 * on a bare CI box.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { applyWatermark, ensureUnderLimit } from '../src/watermark.js';
import { detectWatermark } from '../src/detect.js';
import { probe, run } from '../src/media.js';

function has(binary) {
  try {
    execFileSync(binary, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const ffmpegAvailable = has('ffmpeg') && has('ffprobe');
const fontPath = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

let fontAvailable = false;
try {
  await fs.access(fontPath);
  fontAvailable = true;
} catch {
  fontAvailable = false;
}

const options = { skip: ffmpegAvailable ? false : 'ffmpeg not installed' };

function makeConfig(overrides = {}, coverOverrides = {}) {
  return {
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    encodeTimeoutMs: 120000,
    uploadLimitMb: 50,
    cover: { enabled: false, useLogo: false, blurStrength: 0.16, ...coverOverrides },
    watermark: {
      mode: 'text',
      text: '@testchannel',
      logoPath: '',
      fontPath,
      position: 'br',
      opacity: 0.75,
      scale: 0.18,
      textScale: 0.045,
      margin: 0.03,
      tileRows: 2,
      tileCols: 2,
      chromaKey: '',
      ...overrides,
    },
  };
}

/**
 * A moving scene with static text burned into the bottom-right — a faithful
 * stand-in for a TikTok/Instagram username watermark.
 *
 * It must be TEXT, not a filled box: the detector requires internal detail, and
 * a flat rectangle is correctly rejected as "still but featureless" the same way
 * an empty patch of sky is.
 */
async function makeVideoWithWatermark(dir, { size = '640x360', stamp = true } = {}) {
  const out = path.join(dir, stamp ? 'stamped.mp4' : 'clean.mp4');
  const vf = stamp
    ? `drawtext=fontfile=${fontPath}:text='@creator123':fontcolor=white:fontsize=26:` +
      'x=470:y=300:borderw=2:bordercolor=black'
    : 'null';
  await run(
    'ffmpeg',
    [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=15:duration=4`,
      '-vf', vf,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      out,
    ],
    { timeoutMs: 60000 },
  );
  return out;
}

async function workspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'wm-test-'));
}

async function makeVideo(dir, { seconds = 1, size = '640x360' } = {}) {
  const out = path.join(dir, 'clip.mp4');
  await run(
    'ffmpeg',
    [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=15:duration=${seconds}`,
      '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
      out,
    ],
    { timeoutMs: 60000 },
  );
  return out;
}

async function makeImage(dir, { size = '640x360', name = 'shot.jpg' } = {}) {
  const out = path.join(dir, name);
  await run(
    'ffmpeg',
    ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc=size=${size}`, '-frames:v', '1', out],
    { timeoutMs: 60000 },
  );
  return out;
}

async function makeLogo(dir) {
  const out = path.join(dir, 'logo.png');
  await run(
    'ffmpeg',
    [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=red@0.8:s=200x100,format=rgba',
      '-frames:v', '1', out,
    ],
    { timeoutMs: 60000 },
  );
  return out;
}

test('text watermark produces a playable video', options, async (t) => {
  if (!fontAvailable) return t.skip('DejaVu font not installed');
  const dir = await workspace();
  try {
    const source = await makeVideo(dir);
    const result = await applyWatermark({ path: source, type: 'video' }, makeConfig(), dir);

    assert.equal(result.watermarked, true, 'ffmpeg rejected the filter graph');
    assert.notEqual(result.path, source, 'should have produced a new file');

    const info = await probe(result.path);
    assert.equal(info.width, 640);
    assert.equal(info.height, 360);
    assert.equal(info.videoCodec, 'h264', 'Telegram only plays H.264 inline');
    assert.ok(info.hasAudio, 'the audio track must survive watermarking');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('logo watermark composites without errors', options, async () => {
  const dir = await workspace();
  try {
    const source = await makeVideo(dir);
    const logoPath = await makeLogo(dir);
    const config = makeConfig({ mode: 'logo', logoPath });
    const result = await applyWatermark({ path: source, type: 'video' }, config, dir);
    assert.equal(result.watermarked, true);
    assert.equal((await probe(result.path)).videoCodec, 'h264');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('both mode chains overlay into drawtext', options, async (t) => {
  if (!fontAvailable) return t.skip('DejaVu font not installed');
  const dir = await workspace();
  try {
    const source = await makeVideo(dir);
    const logoPath = await makeLogo(dir);
    const result = await applyWatermark(
      { path: source, type: 'video' },
      makeConfig({ mode: 'both', logoPath }),
      dir,
    );
    assert.equal(result.watermarked, true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('tiled mode parses with a full grid of drawtext filters', options, async (t) => {
  if (!fontAvailable) return t.skip('DejaVu font not installed');
  const dir = await workspace();
  try {
    const source = await makeImage(dir);
    const result = await applyWatermark(
      { path: source, type: 'photo' },
      makeConfig({ mode: 'tiled', tileRows: 3, tileCols: 3 }),
      dir,
    );
    assert.equal(result.watermarked, true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('photos are watermarked and stay photos', options, async (t) => {
  if (!fontAvailable) return t.skip('DejaVu font not installed');
  const dir = await workspace();
  try {
    const source = await makeImage(dir);
    const result = await applyWatermark({ path: source, type: 'photo' }, makeConfig(), dir);
    assert.equal(result.watermarked, true);
    assert.match(result.path, /\.jpg$/);
    const info = await probe(result.path);
    assert.equal(info.width, 640);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('text containing % and quotes does not break the graph', options, async (t) => {
  if (!fontAvailable) return t.skip('DejaVu font not installed');
  const dir = await workspace();
  try {
    const source = await makeImage(dir);
    // Every one of these is a filtergraph metacharacter or a strftime token.
    const result = await applyWatermark(
      { path: source, type: 'photo' },
      makeConfig({ text: "100% off: it's @sins" }),
      dir,
    );
    assert.equal(result.watermarked, true, 'special characters broke drawtext');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('watermark mode none leaves the file untouched', options, async () => {
  const dir = await workspace();
  try {
    const source = await makeImage(dir);
    const result = await applyWatermark({ path: source, type: 'photo' }, makeConfig({ mode: 'none' }), dir);
    assert.equal(result.path, source);
    assert.equal(result.watermarked, false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a file already under the limit is passed through untouched', options, async () => {
  const dir = await workspace();
  try {
    const source = await makeVideo(dir);
    const result = await ensureUnderLimit(source, { ...makeConfig(), uploadLimitMb: 50 }, dir);
    assert.equal(result.path, source);
    assert.equal(result.shrunk, false);
    assert.equal(result.tooBig, false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('an oversized file is re-encoded smaller rather than failing the post', options, async () => {
  const dir = await workspace();
  try {
    const source = await makeVideo(dir, { seconds: 2, size: '1280x720' });
    // A limit this small forces the shrink path on any real file.
    const config = { ...makeConfig(), uploadLimitMb: 0.02 };
    const result = await ensureUnderLimit(source, config, dir);

    assert.equal(result.shrunk, true, 'should have attempted a shrink pass');
    assert.notEqual(result.path, source);
    const info = await probe(result.path);
    assert.ok(info.height <= 720);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('finds a burned-in watermark on a moving scene', options, async (t) => {
  if (!fontAvailable) return t.skip('DejaVu font not installed');
  const dir = await workspace();
  try {
    const source = await makeVideoWithWatermark(dir);
    const found = await detectWatermark(source, makeConfig(), dir);

    assert.ok(found, 'should have detected the static text');
    // Text is drawn from 470,300 and runs ~150×26px. The detector works on a
    // 12×12 grid and pads, so assert overlap rather than exact coordinates.
    assert.ok(found.x < 620 && found.x + found.w > 470, `x range ${found.x}..${found.x + found.w}`);
    assert.ok(found.y < 326 && found.y + found.h > 300, `y range ${found.y}..${found.y + found.h}`);
    assert.ok(found.confidence >= 0.65);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('does not invent a watermark on the same video without one', options, async () => {
  const dir = await workspace();
  try {
    // Same source, no stamp. A false positive here means covering part of
    // somebody's actual video, which is worse than leaving a watermark visible.
    const clean = await makeVideoWithWatermark(dir, { stamp: false });
    assert.equal(await detectWatermark(clean, makeConfig(), dir), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('refuses to guess on a video that barely moves', options, async () => {
  const dir = await workspace();
  try {
    // A static shot has the same "nothing changes" signature as a watermark, so
    // the honest answer is no answer.
    const out = path.join(dir, 'still.mp4');
    await run(
      'ffmpeg',
      [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'color=c=blue:size=320x240:rate=15:duration=3',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out,
      ],
      { timeoutMs: 60000 },
    );
    assert.equal(await detectWatermark(out, makeConfig(), dir), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('covering blurs the detected patch and still encodes', options, async (t) => {
  if (!fontAvailable) return t.skip('DejaVu font not installed');
  const dir = await workspace();
  try {
    const source = await makeVideoWithWatermark(dir);
    const logoPath = await makeLogo(dir);
    const config = makeConfig({ mode: 'text', logoPath }, { enabled: true, useLogo: true });

    const result = await applyWatermark({ path: source, type: 'video' }, config, dir);
    assert.equal(result.watermarked, true, 'ffmpeg rejected the cover graph');
    assert.ok(result.cover, 'should report what it covered');

    const info = await probe(result.path);
    assert.equal(info.videoCodec, 'h264');
    assert.equal(info.width, 640);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('covering works with a logo corner mark too, splitting the logo input', options, async () => {
  const dir = await workspace();
  try {
    const source = await makeVideoWithWatermark(dir);
    const logoPath = await makeLogo(dir);
    // Both the corner mark and the cover patch consume the logo input here,
    // which is the case that needs an explicit split in the graph.
    const config = makeConfig({ mode: 'logo', logoPath }, { enabled: true, useLogo: true });
    const result = await applyWatermark({ path: source, type: 'video' }, config, dir);
    assert.equal(result.watermarked, true, 'the logo input was not split correctly');
    assert.ok(result.cover);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a logo with a solid backdrop can be keyed out', options, async () => {
  const dir = await workspace();
  try {
    const source = await makeVideo(dir);
    // A logo on solid black, like an emblem exported without transparency.
    const logoPath = path.join(dir, 'boxed-logo.png');
    await run(
      'ffmpeg',
      [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'color=c=black:s=200x200',
        '-vf', 'drawbox=x=50:y=50:w=100:h=100:color=red@1:t=fill',
        '-frames:v', '1', logoPath,
      ],
      { timeoutMs: 60000 },
    );
    const config = makeConfig({ mode: 'logo', logoPath, chromaKey: '0x000000' });
    const result = await applyWatermark({ path: source, type: 'video' }, config, dir);
    assert.equal(result.watermarked, true, 'colorkey broke the graph');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a corrupt file degrades to posting the original, not to a crash', options, async () => {
  const dir = await workspace();
  try {
    const broken = path.join(dir, 'broken.mp4');
    await fs.writeFile(broken, 'this is not a video');
    const result = await applyWatermark({ path: broken, type: 'video' }, makeConfig(), dir);
    assert.equal(result.watermarked, false);
    assert.equal(result.path, broken);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
