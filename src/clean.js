/**
 * Caption hygiene for a single-channel bot: nothing in a caption should point
 * anywhere but the owner's own channel.
 *
 * Removes URLs (http/https and bare t.me links) and @usernames that are not on
 * the keep-list, tidies the whitespace wreckage that leaves behind, and stamps
 * the owner's own @tag at the end — so a post lifted from elsewhere arrives
 * carrying only the owner's branding.
 */

const URL_PATTERN = /\bhttps?:\/\/\S+/gi;
const TME_PATTERN = /\b(?:t(?:elegram)?\.me|telegram\.dog)\/\S+/gi;
/** A leading word-char means it's an email or mid-word '@' — not a mention. */
const MENTION_PATTERN = /(^|[^\w@])@([A-Za-z0-9_]{4,32})\b/g;

/** Lines that are only decoration once their content was removed. */
const DEBRIS_LINE = /^[\s\-–—•|:~*.,_"'()[\]]*$/;

export function cleanCaption(text, { keep = [] } = {}) {
  const keepSet = new Set(keep.filter(Boolean).map((u) => u.toLowerCase().replace(/^@/, '')));
  let removed = 0;

  let out = String(text || '');

  out = out.replace(URL_PATTERN, () => {
    removed += 1;
    return '';
  });
  out = out.replace(TME_PATTERN, () => {
    removed += 1;
    return '';
  });
  out = out.replace(MENTION_PATTERN, (whole, prefix, name) => {
    if (keepSet.has(name.toLowerCase())) return whole;
    removed += 1;
    return prefix;
  });

  // Sweep up what the removals left behind: dangling separators, lines that
  // were nothing but a link, stacked blank lines.
  out = out
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').trimEnd())
    .map((line) => (DEBRIS_LINE.test(line) ? '' : line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // The owner's own tag goes on the end — once, and only when it is not
  // already in the text.
  const our = keep.filter(Boolean)[0];
  if (our) {
    const tag = `@${our.replace(/^@/, '')}`;
    if (!out.toLowerCase().includes(tag.toLowerCase())) {
      out = out ? `${out}\n\n${tag}` : tag;
    }
  }

  return { text: out, removed };
}
