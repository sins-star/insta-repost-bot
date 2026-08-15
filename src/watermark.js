import fs from 'node:fs/promises';
import path from 'node:path';
import { run, probe } from './media.js';
import { detectWatermark } from './detect.js';
import { log } from './logger.js';

/**
 * Escape a path so ffmpeg's filtergraph parser sees it as one literal value.
 *
 * The parser splits filter options on ':' and treats '\' and '\'' specially, so
 * an unescaped Windows-ish or spaced path silently becomes two broken options
 * rather than an error you can read.
 */
export function escapeFilterPath(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:');
}

/**
 * Corner expressions for the `overlay` filter, where W/H are the base frame and
 * w/h are the thing being laid on top.
 */
export function overlayPosition(position, marginPx) {
  const m = Math.round(marginPx);
  switch (position) {
    case 'tl':
      return { x: `${m}`, y: `${m}` };
    case 'tr':
      return { x: `W-w-${m}`, y: `${m}` };
    case 'bl':
      return { x: `${m}`, y: `H-h-${m}` };
    case 'center':
      return { x: '(W-w)/2', y: '(H-h)/2' };
    case 'br':
    default:
      return { x: `W-w-${m}`, y: `H-h-${m}` };
  }
}

/**
 * Corner expressions for `drawtext`, which uses a different variable set than
 * overlay: w/h are the frame, tw/th are the rendered text box.
 */
export function textPosition(position, marginPx) {
  const m = Math.round(marginPx);
  switch (position) {
    case 'tl':
      return { x: `${m}`, y: `${m}` };
    case 'tr':
      return { x: `w-tw-${m}`, y: `${m}` };
    case 'bl':
      return { x: `${m}`, y: `h-th-${m}` };
    case 'center':
      return { x: '(w-tw)/2', y: '(h-th)/2' };
    case 'br':
    default:
      return { x: `w-tw-${m}`, y: `h-th-${m}` };
  }
}

/** In `both` mode the text goes to the opposite corner so it never sits on the logo. */
export function oppositeCorner(position) {
  return { tl: 'br', tr: 'bl', bl: 'tr', br: 'tl', center: 'br' }[position] || 'tl';
}

function drawtext({ fontPath, textFilePath, fontSize, opacity, x, y }) {
  const borderWidth = Math.max(1, Math.round(fontSize * 0.06));
  return [
    'drawtext',
    `=fontfile='${escapeFilterPath(fontPath)}'`,
    `:textfile='${escapeFilterPath(textFilePath)}'`,
    // Without this, a '%' in the watermark text is read as a strftime token.
    ':expansion=none',
    `:fontcolor=white@${opacity}`,
    `:fontsize=${fontSize}`,
    `:borderw=${borderWidth}`,
    `:bordercolor=black@${Math.min(1, opacity * 0.8).toFixed(3)}`,
    `:shadowcolor=black@${Math.min(1, opacity * 0.5).toFixed(3)}`,
    ':shadowx=1:shadowy=1',
    `:x=${x}`,
    `:y=${y}`,
  ].join('');
}

const even = (n) => Math.max(2, Math.round(n) & ~1);

/**
 * Build the -filter_complex string for one piece of media.
 *
 * Pure and dimension-driven: sizes are resolved to pixels here from the real
 * frame size rather than left as ffmpeg expressions, which keeps the graph
 * readable in logs and lets the tests assert on exact output.
 *
 * The graph is assembled as a list of chains because two features can each need
 * the logo input, and an ffmpeg filter output may only be consumed once — so
 * the logo has to be explicitly split when it is used twice.
 *
 * Returns null when there is nothing to draw, which callers use to skip
 * re-encoding entirely.
 */
export function buildFilterGraph({
  mode,
  position = 'br',
  opacity = 0.75,
  scale = 0.18,
  margin = 0.03,
  textScale = 0.045,
  tileRows = 3,
  tileCols = 3,
  fontPath,
  textFilePath,
  width,
  height,
  /** {x,y,w,h} of an existing watermark to blur out, or null. */
  cover = null,
  /** Stamp our logo on top of the blurred patch. */
  coverLogo = false,
  /** Knock a solid background colour out of the logo, e.g. '0x000000'. */
  chromaKey = '',
  blurStrength = 0.16,
}) {
  // boxblur needs at least a few pixels per plane to work with, and a patch this
  // small is not a watermark in the first place.
  const hasCover = Boolean(cover) && Math.min(cover.w, cover.h) >= 8;
  if (mode === 'none' && !hasCover) return null;
  if (!width || !height) throw new Error('buildFilterGraph needs the real frame width and height');

  const marginPx = Math.round(width * margin);
  const fontSize = Math.max(10, Math.round(Math.min(width, height) * textScale));
  const opacityStr = Number(opacity).toFixed(3);

  const cornerUsesLogo = ['logo', 'both'].includes(mode);
  const patchUsesLogo = hasCover && coverLogo;
  const logoUses = (cornerUsesLogo ? 1 : 0) + (patchUsesLogo ? 1 : 0);

  const chains = [];
  let current = '0:v';

  // ── logo input preparation ────────────────────────────────────────────────
  let logoSource = '1:v';
  let cornerLogoLabel = null;
  let patchLogoLabel = null;

  if (logoUses > 0) {
    if (chromaKey) {
      chains.push(`[${logoSource}]colorkey=${chromaKey}:0.12:0.06[logokey]`);
      logoSource = 'logokey';
    }
    if (logoUses === 2) {
      chains.push(`[${logoSource}]split=2[logoa][logob]`);
      patchLogoLabel = 'logoa';
      cornerLogoLabel = 'logob';
    } else if (patchUsesLogo) {
      patchLogoLabel = logoSource;
    } else {
      cornerLogoLabel = logoSource;
    }
  }

  // ── cover an existing watermark ───────────────────────────────────────────
  if (hasCover) {
    const { x, y, w, h } = cover;
    // Radius scales with the patch so a small logo is not over-blurred into a
    // grey smear and a large one is actually obliterated.
    //
    // The ceiling is a QUARTER of the patch, not a half. boxblur applies the
    // same radius to the chroma planes, and in yuv420p those are half
    // resolution — so a radius that is legal for luma is rejected for chroma
    // and the whole filtergraph dies. When that happened the video posted with
    // neither the cover nor our own watermark.
    const maxRadius = Math.floor(Math.min(w, h) / 4);
    const radius = Math.max(1, Math.min(maxRadius, Math.round(Math.min(w, h) * blurStrength)));

    chains.push(`[${current}]split=2[covbase][covsrc]`);
    chains.push(`[covsrc]crop=${w}:${h}:${x}:${y},boxblur=${radius}:2[covblur]`);
    chains.push(`[covbase][covblur]overlay=${x}:${y}[covout]`);
    current = 'covout';

    if (patchLogoLabel) {
      // Bound BOTH dimensions. `scale=W:-1` keeps the aspect ratio but leaves
      // the height free, so any logo taller than the patch's aspect ratio spills
      // out of the region it is meant to fill — silently, since the graph still
      // encodes. A square logo on a wide patch overflowed by 3.8× the intended
      // area in testing, painting over 500px of the actual video.
      const patchLogoWidth = even(w * 0.9);
      const patchLogoHeight = even(h * 0.9);
      chains.push(
        `[${patchLogoLabel}]scale=${patchLogoWidth}:${patchLogoHeight}:` +
          'force_original_aspect_ratio=decrease[covlogo]',
      );
      // `${w}` is this region's width in pixels; bare `w`/`h` are ffmpeg's
      // overlay-input dimensions. Mixing them centres the logo on the patch
      // without needing to know the logo's aspect ratio here.
      chains.push(`[${current}][covlogo]overlay=${x}+(${w}-w)/2:${y}+(${h}-h)/2[covlogoout]`);
      current = 'covlogoout';
    }
  }

  // ── the corner watermark ──────────────────────────────────────────────────
  if (mode === 'none') {
    chains.push(`[${current}]null[v]`);
    return chains.join(';');
  }

  if (mode === 'tiled') {
    const cells = [];
    for (let row = 0; row < tileRows; row += 1) {
      for (let col = 0; col < tileCols; col += 1) {
        cells.push(
          drawtext({
            fontPath,
            textFilePath,
            fontSize,
            opacity: opacityStr,
            x: `(w*${((col + 0.5) / tileCols).toFixed(4)})-(tw/2)`,
            y: `(h*${((row + 0.5) / tileRows).toFixed(4)})-(th/2)`,
          }),
        );
      }
    }
    chains.push(`[${current}]${cells.join(',')}[v]`);
    return chains.join(';');
  }

  if (mode === 'text') {
    const { x, y } = textPosition(position, marginPx);
    chains.push(
      `[${current}]${drawtext({ fontPath, textFilePath, fontSize, opacity: opacityStr, x, y })}[v]`,
    );
    return chains.join(';');
  }

  if (mode === 'logo' || mode === 'both') {
    const logoWidth = Math.max(1, Math.round(width * scale));
    const { x, y } = overlayPosition(position, marginPx);
    chains.push(
      `[${cornerLogoLabel}]scale=${logoWidth}:-1,format=rgba,colorchannelmixer=aa=${opacityStr}[wm]`,
    );

    if (mode === 'logo') {
      chains.push(`[${current}][wm]overlay=${x}:${y}[v]`);
      return chains.join(';');
    }

    const textCorner = textPosition(oppositeCorner(position), marginPx);
    chains.push(`[${current}][wm]overlay=${x}:${y}[base]`);
    chains.push(
      `[base]${drawtext({
        fontPath,
        textFilePath,
        fontSize,
        opacity: opacityStr,
        x: textCorner.x,
        y: textCorner.y,
      })}[v]`,
    );
    return chains.join(';');
  }

  throw new Error(`unknown watermark mode "${mode}"`);
}

/**
 * Keep a file under Telegram's hard upload ceiling.
 *
 * Watermarking re-encodes, and an encode can come out LARGER than the source —
 * a 46MB download becoming a 53MB upload is a silent, confusing failure at the
 * very last step. One shrink pass (720p, higher CRF) recovers almost every real
 * case; if it still does not fit, the caller is told rather than surprised.
 */
export async function ensureUnderLimit(filePath, config, workDir) {
  const limitBytes = config.uploadLimitMb * 1024 * 1024;
  const { size } = await fs.stat(filePath);
  if (size <= limitBytes) return { path: filePath, shrunk: false, tooBig: false };

  const mb = (size / 1024 / 1024).toFixed(1);
  log.warn(`${path.basename(filePath)} is ${mb}MB — over the ${config.uploadLimitMb}MB limit, shrinking`);

  const outPath = path.join(workDir, `fit-${path.basename(filePath, path.extname(filePath))}.mp4`);
  try {
    await run(
      config.ffmpegPath,
      [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-i', filePath,
        // -2 keeps the width even, which H.264 requires.
        '-vf', 'scale=-2:min(720\\,ih)',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
        '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
        '-c:a', 'aac', '-b:a', '96k',
        outPath,
      ],
      { timeoutMs: config.encodeTimeoutMs },
    );
  } catch (err) {
    log.error('shrink pass failed —', err.stderr || err.message);
    return { path: filePath, shrunk: false, tooBig: true, sizeMb: Number(mb) };
  }

  const after = await fs.stat(outPath);
  if (after.size > limitBytes) {
    return {
      path: outPath,
      shrunk: true,
      tooBig: true,
      sizeMb: Number((after.size / 1024 / 1024).toFixed(1)),
    };
  }
  return { path: outPath, shrunk: true, tooBig: false };
}

async function writeTextFile(dir, text) {
  const file = path.join(dir, 'wm-text.txt');
  // drawtext renders the file's bytes verbatim; a trailing newline would be
  // rendered as a second, empty line and shift the text box off its corner.
  await fs.writeFile(file, text.replace(/\n+$/, ''), 'utf8');
  return file;
}

/**
 * Watermark one file, returning the path to the result.
 *
 * On any ffmpeg failure this returns the ORIGINAL path rather than throwing:
 * a post that goes out unwatermarked is a smaller failure than a post that
 * never goes out, and the caller reports which happened.
 */
export async function applyWatermark(item, config, workDir) {
  const wm = config.watermark;
  const isVideo = item.type === 'video';

  let info;
  try {
    info = await probe(item.path, { ffprobePath: config.ffprobePath });
  } catch (err) {
    log.warn('watermark: could not read the file, posting it as-is —', err.message);
    return { path: item.path, watermarked: false, reason: 'unreadable' };
  }
  if (!info.width || !info.height) {
    log.warn('watermark: could not read dimensions, posting original', item.path);
    return { path: item.path, watermarked: false, reason: 'no-dimensions' };
  }

  // Detection is temporal — it needs frames to compare, so it can only run on
  // video. A still image gives no signal to work with.
  let cover = null;
  if (config.cover.enabled && isVideo) {
    cover = await detectWatermark(item.path, config, workDir);
  }

  if (wm.mode === 'none' && !cover) return { path: item.path, watermarked: false, info };

  const textFilePath = wm.text ? await writeTextFile(workDir, wm.text) : '';
  const filter = buildFilterGraph({
    mode: wm.mode,
    position: wm.position,
    opacity: wm.opacity,
    scale: wm.scale,
    margin: wm.margin,
    textScale: wm.textScale,
    tileRows: wm.tileRows,
    tileCols: wm.tileCols,
    fontPath: wm.fontPath,
    textFilePath,
    width: info.width,
    height: info.height,
    cover,
    coverLogo: config.cover.useLogo && Boolean(wm.logoPath),
    chromaKey: wm.chromaKey,
    blurStrength: config.cover.blurStrength,
  });
  if (!filter) return { path: item.path, watermarked: false, info };

  const needsLogo =
    ['logo', 'both'].includes(wm.mode) || (cover && config.cover.useLogo && Boolean(wm.logoPath));
  const outPath = path.join(
    workDir,
    `wm-${path.basename(item.path, path.extname(item.path))}.${isVideo ? 'mp4' : 'jpg'}`,
  );

  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', item.path];
  if (needsLogo) args.push('-i', wm.logoPath);
  args.push('-filter_complex', filter, '-map', '[v]');

  if (isVideo) {
    // Audio is copied rather than re-encoded: the filter graph never touches it,
    // and Instagram audio is already AAC. `?` makes a silent clip not an error.
    args.push(
      '-map', '0:a?',
      '-c:a', 'copy',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '23',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
    );
  } else {
    args.push('-frames:v', '1', '-q:v', '2');
  }
  args.push(outPath);

  try {
    await run(config.ffmpegPath, args, { timeoutMs: config.encodeTimeoutMs });
    return { path: outPath, watermarked: true, info, cover };
  } catch (err) {
    // The one failure worth a second attempt: a container whose audio codec
    // cannot be copied into mp4. Re-encoding audio fixes it and costs seconds.
    if (isVideo) {
      log.warn('watermark: stream copy failed, retrying with re-encoded audio —', err.message);
      try {
        const retry = [...args];
        const codecIndex = retry.indexOf('copy');
        if (codecIndex !== -1) retry.splice(codecIndex, 1, 'aac', '-b:a', '128k');
        await run(config.ffmpegPath, retry, { timeoutMs: config.encodeTimeoutMs });
        return { path: outPath, watermarked: true, info, cover };
      } catch (retryErr) {
        log.error('watermark failed twice, posting original —', retryErr.stderr || retryErr.message);
        return { path: item.path, watermarked: false, reason: 'ffmpeg-failed', info };
      }
    }
    log.error('watermark failed, posting original —', err.stderr || err.message);
    return { path: item.path, watermarked: false, reason: 'ffmpeg-failed', info };
  }
}
