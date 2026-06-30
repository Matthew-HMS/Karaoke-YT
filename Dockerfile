# syntax=docker/dockerfile:1

# SingAlong production image. Multi-stage: a build stage with the full toolchain
# (better-sqlite3 compiles native bindings), then a slim runtime with python3 +
# the standalone yt-dlp binary. Build for the cluster's arch with:
#   docker buildx build --platform linux/arm64 ...   (Oracle Ampere is arm64)

# ---- deps: install all deps, including the native better-sqlite3 build ----
FROM node:20-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

# ---- build: compile the Next.js app ----
FROM node:20-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- runtime: slim, non-root, python3 + yt-dlp, dumb-init as PID 1 ----
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOST=0.0.0.0 \
    DB_PATH=/data/singalong.db \
    YTDLP_PATH=/usr/local/bin/yt-dlp

# python3: yt-dlp's runtime. ffmpeg: decodes downloaded audio to PCM for the
# pitch-reference contour generator (lib/reference.ts). dumb-init: forwards
# signals so SIGTERM reaches Node (graceful shutdown). The standalone yt-dlp
# binary is owned by `node` so the entrypoint can self-update it without root.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 ffmpeg ca-certificates dumb-init curl \
  && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
       -o /usr/local/bin/yt-dlp \
  && chmod a+rx /usr/local/bin/yt-dlp \
  && chown node:node /usr/local/bin/yt-dlp \
  && apt-get purge -y curl && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

# Whole built app (incl. node_modules with the compiled better-sqlite3 and tsx,
# since the server runs via `npm start` → tsx server.ts).
COPY --from=build /app ./
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
  && mkdir -p /data \
  && chown -R node:node /data /app

USER node
EXPOSE 3000
ENTRYPOINT ["dumb-init", "--", "docker-entrypoint.sh"]
CMD ["npm", "start"]
