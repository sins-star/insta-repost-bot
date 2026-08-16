# Instagram → Telegram reposter

Paste an Instagram link into a Telegram chat with this bot. It downloads the post,
burns a watermark into the video or photos, and posts it to your channel — then sends
you the confirmation with a **❌ Delete from channel** button in case you change your mind.

Carousels work: a 7-photo post goes out as one album.

---

## Setup — about 5 minutes

The bot configures itself. You need one value to start it; everything else it
learns from you using it.

### 1. Make the bot

In Telegram, message **[@BotFather](https://t.me/BotFather)** → `/newbot` → pick a name and a
username. It replies with a token like `8123456789:AAH...`. That's `BOT_TOKEN` — the only
thing you have to put in a config file.

```bash
cp .env.example .env      # paste the token into BOT_TOKEN
docker compose up -d --build
```

### 2. Claim it

Message your new bot and send `/claim`. You are now its owner, permanently.

Claiming only works while the bot has no owner, and only in the first hour after it starts.
Set `ALLOW_CLAIM=false` and fill in `ADMIN_IDS` by hand if you would rather not rely on that.

### 3. Add it to your channel

Your channel → **Manage channel** → **Administrators** → **Add admin** → your bot → turn on
**Post messages** → save.

Telegram tells the bot it was added, so it works out the channel id by itself and messages you
to confirm. Nothing to look up.

### 4. Send it your logo

Send the image to the bot **as a file**, not as a photo — Telegram re-encodes photos to JPEG
and throws away transparency. It saves it, switches the watermark on, and tells you the size.

Send a new one any time to replace it. If the image has no transparency, the bot notices and
switches on the setting that knocks its background out.

That's it. Paste an Instagram link.

### Checking it over

```bash
npm run doctor    # token, channel, ffmpeg, yt-dlp, fonts, disk
```

Send `/status` to the bot for the same picture from your phone.

---

## Where to run it

It long-polls by default, so it needs **no public URL and no open ports** — anywhere that
stays on will do.

| Option | Cost | Honest verdict |
|---|---|---|
| **A machine you already own** | free | Easiest by far. Spare laptop, old PC, Raspberry Pi, home server. `docker compose up -d`. Only posts while that machine is on. |
| **Oracle Cloud Always Free** | free forever | The only genuinely free always-on VM left. 2 ARM cores / 12GB. Needs a card for ID verification, and setup is a real sit-down-at-a-computer job, not a phone task. See the caveat below. |
| **Any small VPS** | ~$4/mo | Hetzner, Vultr, DigitalOcean. Zero drama, works the first time. |
| **Cloud Run / Render** | free tier | Needs `MODE=webhook`. Both sleep when idle, so the first link after a quiet spell takes ~1 minute. Cloud Run's filesystem is *in memory* — give it 2GB or video downloads will hit the memory ceiling. |

**The Oracle caveat, because it will bite otherwise:** Oracle reclaims idle Always Free ARM
instances when CPU, network *and* memory all sit below 20% across a 7-day window. A bot that
waits quietly between reels is exactly that profile. Oracle emails a warning first, and any
other small workload on the box avoids it — but don't put this somewhere and assume it's
permanent without watching for that email.

Fly.io, Railway and Hugging Face Spaces no longer have a free tier that fits this. Render's
free plan has no background workers, only web services, which is why it needs webhook mode.

---

## Watermarks

Set `WATERMARK_MODE` in `.env`:

| Mode | What you get |
|---|---|
| `text` | `WATERMARK_TEXT` in a corner, white with a dark outline so it reads on any footage. Needs no assets. |
| `logo` | Your PNG from `assets/watermark.png` in a corner. |
| `both` | Logo in one corner, text in the opposite one. |
| `tiled` | Text repeated across the whole frame. Near-impossible to crop out. |
| `none` | Repost untouched. |

Everything else is tunable: `WATERMARK_POSITION` (`tl` `tr` `bl` `br` `center`),
`WATERMARK_OPACITY`, `WATERMARK_SCALE` (logo width as a share of the video width),
`WATERMARK_TEXT_SCALE`, and `WATERMARK_MARGIN`.

**The easy way to set a logo is to send it to the bot in chat, as a file.** It saves it to the
data volume, switches `WATERMARK_MODE` to `logo`, and confirms with the dimensions. Send a new
one any time to replace it — no config edit, no restart, no rebuild.

Send it as a **file**, not a photo: Telegram re-encodes photos to JPEG, which throws away
transparency. The bot warns you if you do it the lossy way.

If the image has **no transparency** — an emblem exported on a solid black square, say — it
would land on the video as a black box. The bot detects that and switches on
`WATERMARK_CHROMA_KEY=0x000000` to knock the backdrop out. If the backdrop isn't black, set
that variable to whatever colour it is.

The file-on-disk route still works: put a transparent PNG at `assets/watermark.png` and set
`WATERMARK_MODE=logo`. That folder is mounted into the container.

---

## Covering the original uploader's watermark

On by default. Before watermarking, the bot looks for a burned-in watermark from whoever
posted it — a TikTok handle, an `@username`, a channel bug — blurs that patch, and stamps your
logo over it.

**How it finds one.** A watermark is the part of the frame that never changes while everything
else does. That alone isn't enough: an empty patch of sky is just as still. So it also has to
have *detail* — edges, lettering, contrast — and be small, and sit near an edge. All four
together is what a watermark looks like and ordinary footage doesn't.

**⚠️ It is a guess, and nothing asks you before posting.** It will miss some, and it can
occasionally blur something that was genuinely part of the video. Two things make that
survivable:

- Every post it acts on says **"🛡 Covered an existing watermark on N item(s)"** in the
  confirmation. If you didn't expect that line, look at the post.
- The ❌ Delete button is right underneath it.

When it isn't sure it does nothing, which is deliberate — covering the wrong part of somebody's
video is worse than leaving their watermark up. Video only: a single photo gives it no frames
to compare.

Turn it off with `COVER_EXISTING=false`. Blur without stamping the logo with
`COVER_WITH_LOGO=false`.

---

## Does it need looking after?

Mostly no — but here is the honest version, because "set it up and forget it" is
only true if you know what it does on its own.

**What it fixes without you:**

| | |
|---|---|
| **Instagram breaks the downloader** | Updates yt-dlp at boot and every 24h after. This is the big one — it's *the* reason a bot like this normally dies after a few weeks. |
| **A download fails** | Falls back to a second, independent downloader automatically. |
| **The disk fills up** | Sweeps files left behind by jobs killed mid-encode, hourly and before any download that finds space short. |
| **Telegram rate-limits or hiccups** | Waits out the flood limit and retries instead of losing the post. |
| **A watermark won't render** | Posts the clip anyway and tells you it went out unwatermarked. |
| **The process crashes** | Exits cleanly so Docker restarts it (`restart: unless-stopped`), rather than dying quietly. |
| **The video is too big** | Re-encodes smaller to fit Telegram's 50MB ceiling. |

**What it tells you about instead of fixing**, because these need a human:

- **It can't see the channel**, ffmpeg is missing, or the disk is genuinely full —
  you get a Telegram message at startup, not a log line nobody reads.
- **Instagram cookies expired** — it says so, in the reply to the link you sent.
- **Instagram is rate-limiting** — it says to wait, or to add cookies.

**What it does when it genuinely can't run:**

- **Telegram unreachable at startup** — waits 60 seconds, then exits so the
  container restarts and tries again. It will not sit there alive and silent.
- **Two copies running on one token** (an overlapping redeploy) — says exactly
  that, by name, instead of looping anonymously.
- **A bad `BOT_TOKEN`** — one readable line, not a stack trace.

**What will eventually need you anyway, honestly:**

- **Cookies, if you use them.** They expire every few weeks. Re-export, restart.
- **A rebuild every several months.** Auto-update keeps yt-dlp current, but not
  ffmpeg or Node. `docker compose up -d --build` when you think of it.
- **A really bad Instagram change.** Once in a while a change breaks yt-dlp for
  days, not hours. Nothing on your side can fix that — it's the same for everyone.

---

## When Instagram starts asking for a login

Instagram rate-limits anonymous downloads hard, and the bot will tell you when that's what
happened. Cookies from a logged-in account raise the ceiling enormously.

1. Use a **burner Instagram account**, not your real one. Heavy automated fetching is what
   gets accounts action-blocked, and the block lands on whichever account's cookies you used.
2. Log into that account in a browser and export cookies with any "Get cookies.txt"
   extension, in **Netscape format**.
3. Save it as `cookies/instagram.txt`, then set `COOKIES_FILE=/app/cookies/instagram.txt`
   in `.env` and restart.

Cookies expire every few weeks. When they do, the bot says *"The saved Instagram cookies have
expired"* rather than leaving you guessing.

---

## Troubleshooting

**"Not authorised. Your id is 12345"** — put that number in `ADMIN_IDS` and restart.

**Nothing happens when I paste a link** — check the logs (`docker compose logs -f`). If it
says it can't see the channel, the bot isn't an admin there yet.

**Downloads suddenly stopped working** — Instagram changes things every few weeks and yt-dlp
catches up within days. Set `YTDLP_AUTO_UPDATE=true` and restart, or rebuild the image. The
bot also falls back to a second downloader (gallery-dl) automatically, which usually covers
the gap.

**Video arrives as a grey file instead of playing** — that means the width/height/duration
metadata didn't reach Telegram. Check ffprobe is installed (`npm run doctor`).

**"That video is 54MB…"** — Telegram caps bot uploads at 50MB and there's no way around it
short of running your own Bot API server. The bot already tries a smaller re-encode first.

**`/status`** — shows the queue, uptime, and what watermark settings are actually live.

---

## How it works

```
message → admin check → link found → queue (one job at a time)
   → yt-dlp download  (falls back to gallery-dl if that fails)
   → detect existing watermark (video only; does nothing unless confident)
   → ffmpeg: blur that patch, stamp our logo on it, add the corner mark
             (falls back to posting the original if that fails)
   → size check       (re-encodes smaller if over Telegram's 50MB ceiling)
   → post to channel  → remember message ids → ❌ Delete button
```

The queue is deliberately serial — ffmpeg will happily eat every core, and two links pasted
back to back shouldn't fight each other on a small box. The second one just says how many are
ahead of it.

Failures degrade instead of stopping: a watermark that won't render still posts the clip, and
tells you it went out unwatermarked rather than pretending it worked.

### Layout

| File | Does |
|---|---|
| `src/index.js` | Bot wiring, commands, the job pipeline |
| `src/instagram.js` | Link detection, yt-dlp + gallery-dl, captions, error translation |
| `src/detect.js` | Finds an existing burned-in watermark, or honestly returns nothing |
| `src/watermark.js` | ffmpeg filter graphs, covering, the size-limit shrink pass |
| `src/poster.js` | Sending to the channel, albums, deletion |
| `src/queue.js` | Serial job queue |
| `src/store.js` | Remembers posted message ids so Delete survives a restart |
| `src/config.js` | Env parsing — every invalid value fails at boot with a readable reason |
| `scripts/doctor.js` | Pre-flight check |

```bash
npm test    # 117 tests; the ffmpeg ones build real media and run the real filter graphs
npm run doctor
```
