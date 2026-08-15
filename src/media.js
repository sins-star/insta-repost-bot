import { spawn } from 'node:child_process';
import { log } from './logger.js';

export class CommandError extends Error {
  constructor(message, { code, stderr, timedOut }) {
    super(message);
    this.name = 'CommandError';
    this.code = code;
    this.stderr = stderr;
    this.timedOut = timedOut;
  }
}

/**
 * Run a binary and collect its output.
 *
 * Every external process here (yt-dlp fetching from Instagram, ffmpeg encoding
 * video) can hang indefinitely on a bad network or a pathological input, and a
 * hung child on a 512MB host takes the whole bot down with it. So the timeout
 * is mandatory, and SIGTERM is followed by SIGKILL — ffmpeg in particular can
 * ignore a polite request while it finishes a frame.
 */
export function run(command, args, { timeoutMs, cwd, maxOutputBytes = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    log.debug('exec', command, args.join(' '));
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killTimer = null;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
    }, timeoutMs);

    const cap = (buffer, chunk) =>
      buffer.length > maxOutputBytes ? buffer : buffer + chunk.toString('utf8');

    child.stdout.on('data', (chunk) => {
      stdout = cap(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = cap(stderr, chunk);
    });

    const done = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
    };

    child.on('error', (err) => {
      done();
      if (err.code === 'ENOENT') {
        reject(
          new CommandError(
            `${command} is not installed or not on PATH. ` +
              'Inside Docker this should never happen — check the image built correctly.',
            { code: 'ENOENT', stderr: '', timedOut: false },
          ),
        );
        return;
      }
      reject(err);
    });

    child.on('close', (code) => {
      done();
      if (timedOut) {
        reject(
          new CommandError(`${command} timed out after ${Math.round(timeoutMs / 1000)}s`, {
            code,
            stderr,
            timedOut: true,
          }),
        );
        return;
      }
      if (code !== 0) {
        reject(
          new CommandError(`${command} exited with code ${code}`, { code, stderr, timedOut: false }),
        );
        return;
      }
      resolve({ stdout, stderr, code });
    });
  });
}

/**
 * Read dimensions/duration off a media file.
 *
 * Telegram needs width, height and duration to render a video inline with a
 * scrubber instead of as a grey file attachment, so this is not optional
 * metadata — it is the difference between a post that looks native and one
 * that looks broken.
 */
export async function probe(filePath, { ffprobePath = 'ffprobe', timeoutMs = 30000 } = {}) {
  const { stdout } = await run(
    ffprobePath,
    [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      filePath,
    ],
    { timeoutMs },
  );

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`ffprobe returned unparseable JSON for ${filePath}`);
  }

  const streams = parsed.streams || [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');

  const duration = Number(parsed.format?.duration ?? video?.duration ?? 0);

  return {
    width: Number(video?.width) || 0,
    height: Number(video?.height) || 0,
    duration: Number.isFinite(duration) ? Math.round(duration) : 0,
    hasAudio: Boolean(audio),
    videoCodec: video?.codec_name || '',
    audioCodec: audio?.codec_name || '',
  };
}
