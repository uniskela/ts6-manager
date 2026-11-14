# Same runtime family as Dockerfile.backend production: node:20-slim + Debian ffmpeg.
# Compile ll-wrap in-image (host glibc may be newer than bookworm).
FROM debian:bookworm-slim AS wrap
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends gcc libc6-dev \
  && rm -rf /var/lib/apt/lists/*
COPY ll-wrap.c /ll-wrap.c
RUN gcc -O2 -o /ll-wrap /ll-wrap.c

FROM node:20-slim
RUN apt-get update \
  && apt-get upgrade -y \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /jobs /ctl /app \
  && chown node:node /jobs /ctl /app
COPY --from=wrap /ll-wrap /usr/local/bin/ll-wrap
RUN chmod 755 /usr/local/bin/ll-wrap
COPY --chown=node:node fetcher.mjs proxy.mjs policy.mjs peer-pid.mjs landlock.mjs \
  socket-guards.mjs pending-job.mjs token.mjs ffmpeg-args.mjs response-headers.mjs \
  install-token.mjs reserved-networks.json /app/
USER node
WORKDIR /app
# Default command is the fetcher; compose overrides to proxy.mjs for the proxy service.
CMD ["node", "/app/fetcher.mjs"]
