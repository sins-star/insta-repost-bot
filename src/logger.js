const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

const configured = (process.env.LOG_LEVEL || 'info').toLowerCase();
const threshold = LEVELS[configured] ?? LEVELS.info;

/**
 * Values that must never reach the log, matched by substring. The bot token is
 * the obvious one: grammY puts it in request URLs, and an error object that
 * carries a URL is the normal way a token ends up in a log aggregator.
 */
const secrets = [];

export function redactSecret(value) {
  if (typeof value === 'string' && value.length >= 8) secrets.push(value);
}

function scrub(text) {
  let out = text;
  for (const secret of secrets) {
    if (secret && out.includes(secret)) out = out.split(secret).join('[REDACTED]');
  }
  return out;
}

function format(level, args) {
  const parts = args.map((arg) => {
    if (typeof arg === 'string') return arg;
    if (arg instanceof Error) return arg.stack || arg.message;
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  });
  return scrub(`${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${parts.join(' ')}`);
}

function emit(level, args) {
  if (LEVELS[level] > threshold) return;
  const line = format(level, args);
  if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export const log = {
  error: (...args) => emit('error', args),
  warn: (...args) => emit('warn', args),
  info: (...args) => emit('info', args),
  debug: (...args) => emit('debug', args),
};
