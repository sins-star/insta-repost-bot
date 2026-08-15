# Watermark assets

Drop your logo here as **`watermark.png`** and set `WATERMARK_MODE=logo` (or `both`) in `.env`.

What works best:

- **Transparent PNG.** A JPEG has no alpha channel, so it lands as a solid rectangle.
- **Wide rather than tall.** It is scaled to a fraction of the video's *width*
  (`WATERMARK_SCALE`, default 18%), and the height follows the aspect ratio.
- **Roughly 400–800px wide.** Bigger is wasted; smaller looks soft on a 1080p reel.
- **Light-coloured with its own soft shadow or outline**, since Instagram video is
  usually busy and often dark.

The file is mounted into the container read-only by `docker-compose.yml`, so you can
replace it and restart — no rebuild needed.
