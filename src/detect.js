import fs from 'node:fs/promises';
import path from 'node:path';
import { run, probe } from './media.js';
import { log } from './logger.js';

/**
 * Finding a burned-in watermark on someone else's video.
 *
 * THE IDEA. A watermark is the part of the frame that does not change. Over a
 * few seconds the scene moves, people move, the camera moves — and the logo
 * sits perfectly still. So: sample frames, measure how much each pixel varies
 * over time, and the quietest patch is the watermark.
 *
 * THE CATCH, and it is the whole reason this is written defensively. A locked-off
 * camera pointed at a wall produces exactly the same signature: everything is
 * still. Nothing in the pixels distinguishes "static logo" from "static shot".
 * A semi-transparent watermark is also only *partly* still, because the moving
 * video shows through it.
 *
 * So this returns null far more readily than it returns a box. Covering the
 * wrong part of someone's video is worse than leaving their watermark visible,
 * and the caller reports what was covered so a bad guess is visible rather than
 * silent.
 */

/** Analysis resolution. Small on purpose — this is a shape question, not a detail one. */
const GRID = 96;
/** Cells across. 12×12 cells of 8×8 pixels each. */
const CELLS = 12;
const CELL_PX = GRID / CELLS;

/**
 * Minimum spatial detail, on a 0–255 scale, for a cell to be watermark-shaped.
 * See the note on `spatialScores` — this is the test that separates a logo from
 * an empty patch of sky.
 */
const MIN_DETAIL = 4;

/** Below this average variation the video is too still to judge. 0–255 scale. */
const MIN_GLOBAL_MOTION = 2.0;
/** The quiet cell must be this much quieter than typical to count. */
const MIN_CONFIDENCE = 0.65;
/** A "watermark" bigger than this share of the frame is a bad detection. */
const MAX_AREA_SHARE = 0.25;
/**
 * Shape and placement limits, from what watermarks actually look like: small,
 * and pushed out to an edge or corner. A tall blob in the middle of the frame
 * is part of the video.
 *
 * These exist because a clean video with any static detailed element — a sign,
 * a letterbox bar, a fixed piece of set dressing — otherwise reads as a
 * watermark. Stillness plus detail narrows it down; size and position are what
 * make it usable.
 */
const MAX_WIDTH_SHARE = 0.45;
const MAX_HEIGHT_SHARE = 0.3;
/** How far in from an edge a watermark can start, as a share of the frame. */
const EDGE_BAND = 0.25;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Per-pixel standard deviation across sampled frames, at GRID×GRID.
 * Frames are written to a file rather than piped: raw video down a pipe would
 * be read as text and corrupted.
 */
async function samplePixelVariance(filePath, config, workDir) {
  const rawPath = path.join(workDir, 'detect-frames.gray');
  await run(
    config.ffmpegPath,
    [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', filePath,
      '-vf', `fps=3,scale=${GRID}:${GRID}:flags=area,format=gray`,
      '-frames:v', '30',
      '-f', 'rawvideo', '-pix_fmt', 'gray',
      rawPath,
    ],
    { timeoutMs: Math.min(config.encodeTimeoutMs, 120000) },
  );

  const buffer = await fs.readFile(rawPath);
  await fs.rm(rawPath, { force: true });

  const pixels = GRID * GRID;
  const frames = Math.floor(buffer.length / pixels);
  // Fewer than this and "how much does it vary" is not a meaningful question.
  if (frames < 6) return null;

  const sum = new Float64Array(pixels);
  const sumSq = new Float64Array(pixels);
  for (let f = 0; f < frames; f += 1) {
    const offset = f * pixels;
    for (let i = 0; i < pixels; i += 1) {
      const value = buffer[offset + i];
      sum[i] += value;
      sumSq[i] += value * value;
    }
  }

  const std = new Float64Array(pixels);
  const mean = new Float64Array(pixels);
  for (let i = 0; i < pixels; i += 1) {
    mean[i] = sum[i] / frames;
    std[i] = Math.sqrt(Math.max(0, sumSq[i] / frames - mean[i] * mean[i]));
  }
  return { std, mean, frames };
}

/** Average temporal variation per cell — how much this patch changes over time. */
function cellScores(std) {
  const scores = new Float64Array(CELLS * CELLS);
  for (let cy = 0; cy < CELLS; cy += 1) {
    for (let cx = 0; cx < CELLS; cx += 1) {
      let total = 0;
      for (let y = 0; y < CELL_PX; y += 1) {
        for (let x = 0; x < CELL_PX; x += 1) {
          total += std[(cy * CELL_PX + y) * GRID + (cx * CELL_PX + x)];
        }
      }
      scores[cy * CELLS + cx] = total / (CELL_PX * CELL_PX);
    }
  }
  return scores;
}

/**
 * Spatial detail per cell — how much contrast there is *within* the patch,
 * measured on the time-averaged image.
 *
 * This is the test that makes detection usable. "Doesn't change over time" on
 * its own picks empty sky, a blurred background, a letterbox bar — all of which
 * are perfectly still and none of which are watermarks. A logo is still AND
 * busy: edges, lettering, contrast against whatever is behind it.
 *
 * Found the hard way — an early version confidently picked a flat quiet corner
 * of the frame and ignored the actual burned-in box.
 */
function spatialScores(mean) {
  const scores = new Float64Array(CELLS * CELLS);
  for (let cy = 0; cy < CELLS; cy += 1) {
    for (let cx = 0; cx < CELLS; cx += 1) {
      let sum = 0;
      let sumSq = 0;
      for (let y = 0; y < CELL_PX; y += 1) {
        for (let x = 0; x < CELL_PX; x += 1) {
          const value = mean[(cy * CELL_PX + y) * GRID + (cx * CELL_PX + x)];
          sum += value;
          sumSq += value * value;
        }
      }
      const n = CELL_PX * CELL_PX;
      const avg = sum / n;
      scores[cy * CELLS + cx] = Math.sqrt(Math.max(0, sumSq / n - avg * avg));
    }
  }
  return scores;
}

/**
 * Grow the quiet cell into the contiguous quiet region around it, so a logo
 * spanning several cells is covered whole rather than clipped.
 */
function growRegion(scores, startIndex, cutoff, eligible) {
  const seen = new Set([startIndex]);
  const stack = [startIndex];
  let minX = startIndex % CELLS;
  let maxX = minX;
  let minY = Math.floor(startIndex / CELLS);
  let maxY = minY;

  while (stack.length) {
    const index = stack.pop();
    const cx = index % CELLS;
    const cy = Math.floor(index / CELLS);
    minX = Math.min(minX, cx);
    maxX = Math.max(maxX, cx);
    minY = Math.min(minY, cy);
    maxY = Math.max(maxY, cy);

    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= CELLS || ny >= CELLS) continue;
      const next = ny * CELLS + nx;
      // Grow only into cells that are themselves watermark-shaped, so the
      // region cannot bleed out into the flat background beside a logo.
      if (seen.has(next) || scores[next] > cutoff || !eligible(next)) continue;
      seen.add(next);
      stack.push(next);
    }
  }
  return { minX, maxX, minY, maxY };
}

/**
 * @returns {Promise<{x,y,w,h,confidence}|null>} a box in real pixel coordinates,
 * or null when there is no confident answer — which is the common case.
 */
export async function detectWatermark(filePath, config, workDir) {
  let info;
  try {
    info = await probe(filePath, { ffprobePath: config.ffprobePath });
  } catch {
    return null;
  }
  if (!info.width || !info.height) return null;

  let sampled;
  try {
    sampled = await samplePixelVariance(filePath, config, workDir);
  } catch (err) {
    log.warn('watermark detection failed, leaving the video alone —', err.message);
    return null;
  }
  if (!sampled) {
    log.info('detection: too few frames to judge');
    return null;
  }

  const scores = cellScores(sampled.std);
  const detail = spatialScores(sampled.mean);
  const typical = median(Array.from(scores));

  if (typical < MIN_GLOBAL_MOTION) {
    log.info(`detection: video is too static to tell (median variation ${typical.toFixed(2)})`);
    return null;
  }

  // Only cells with real internal contrast can be a watermark. Without this the
  // quietest cell is almost always flat background.
  const detailFloor = Math.max(MIN_DETAIL, median(Array.from(detail)) * 0.8);
  const eligible = (index) => detail[index] >= detailFloor;

  let bestIndex = -1;
  for (let i = 0; i < scores.length; i += 1) {
    if (!eligible(i)) continue;
    if (bestIndex === -1 || scores[i] < scores[bestIndex]) bestIndex = i;
  }
  if (bestIndex === -1) {
    log.info('detection: no cell has both stillness and detail');
    return null;
  }

  const confidence = (typical - scores[bestIndex]) / typical;
  if (confidence < MIN_CONFIDENCE) {
    log.info(`detection: nothing stands out (best confidence ${confidence.toFixed(2)})`);
    return null;
  }

  const cutoff = scores[bestIndex] + (typical - scores[bestIndex]) * 0.35;
  const { minX, maxX, minY, maxY } = growRegion(scores, bestIndex, cutoff, eligible);

  const cellsWide = maxX - minX + 1;
  const cellsTall = maxY - minY + 1;
  if ((cellsWide * cellsTall) / (CELLS * CELLS) > MAX_AREA_SHARE) {
    log.info('detection: quiet area covers too much of the frame to be a watermark');
    return null;
  }
  if (cellsWide / CELLS > MAX_WIDTH_SHARE || cellsTall / CELLS > MAX_HEIGHT_SHARE) {
    log.info(`detection: region is the wrong shape for a watermark (${cellsWide}×${cellsTall} cells)`);
    return null;
  }

  // Must reach into the outer band on at least one side. Anything living
  // entirely in the middle of the frame is content, not an overlay.
  const band = Math.max(1, Math.round(CELLS * EDGE_BAND));
  const touchesEdge =
    minX < band || minY < band || maxX >= CELLS - band || maxY >= CELLS - band;
  if (!touchesEdge) {
    log.info('detection: region sits in the middle of the frame, treating it as content');
    return null;
  }

  const scaleX = info.width / CELLS;
  const scaleY = info.height / CELLS;
  const padX = info.width * 0.02;
  const padY = info.height * 0.02;

  const x = Math.max(0, Math.round(minX * scaleX - padX));
  const y = Math.max(0, Math.round(minY * scaleY - padY));
  const right = Math.min(info.width, Math.round((maxX + 1) * scaleX + padX));
  const bottom = Math.min(info.height, Math.round((maxY + 1) * scaleY + padY));

  // Even dimensions: H.264 chroma planes are half resolution, and an odd crop
  // is rejected by the encoder.
  const w = Math.max(2, (right - x) & ~1);
  const h = Math.max(2, (bottom - y) & ~1);

  log.info(
    `detection: watermark at ${w}×${h} +${x}+${y} (confidence ${confidence.toFixed(2)})`,
  );
  return { x, y, w, h, confidence };
}
