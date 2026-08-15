# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=8080 \
    TMP_DIR=/tmp/insta-repost \
    DATA_DIR=/app/data

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      ca-certificates \
      curl \
      fonts-dejavu-core \
      python3 \
      python3-pip \
      tini \
    && rm -rf /var/lib/apt/lists/*

# ⚠️ The curl-cffi extra is NOT optional.
#
# yt-dlp's Instagram extractor uses browser impersonation for logged-out access,
# and it checks for that capability with a cached property that simply reports
# false when curl_cffi is absent. It then takes a path that fails to extract —
# with no message saying impersonation was missing. The standalone release
# binaries do not all bundle it, so installing from PyPI with the extra is the
# only way to be sure, and it behaves identically on x86 and ARM.
#
# gallery-dl is a second, independently written Instagram extractor used as a
# fallback: the two almost never break on the same day.
RUN pip3 install --no-cache-dir --break-system-packages \
      "yt-dlp[default,curl-cffi]" \
      "gallery-dl" \
    && yt-dlp --version \
    && gallery-dl --version \
    && python3 -c "import curl_cffi; print('curl_cffi', curl_cffi.__version__)"

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

COPY . .

RUN useradd --create-home --uid 10001 bot \
    && mkdir -p /app/data /tmp/insta-repost \
    && chown -R bot:bot /app /tmp/insta-repost
USER bot

EXPOSE 8080

HEALTHCHECK --interval=60s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini reaps the ffmpeg and yt-dlp children; without it a killed encode leaves
# a zombie behind on every failure.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/index.js"]
