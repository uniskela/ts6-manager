# Bridge-D1 lab image. NOT a production image and not wired into any default compose file.
# Build context is the repository root (the worker reuses packages/backend/src/voice/tslib):
#   docker build -f packages/discord-bridge/lab/Dockerfile -t ts6-discord-bridge-lab:d1 .
#
# Base is pinned by digest so the Node 24 + glibc toolchain is reproducible. The build installs the
# lockfile exactly, compiles the native Opus addon, then gates on typecheck, unit tests and the
# native Opus/DAVE smoke. A failing gate fails the build.
FROM node:24-bookworm@sha256:6449e19d8184d84062525b6a7524def03146c2cb04a7f08b076680d0e8e4240a

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

WORKDIR /app/packages/discord-bridge
COPY packages/discord-bridge/package.json packages/discord-bridge/pnpm-lock.yaml packages/discord-bridge/.npmrc ./
RUN pnpm install --frozen-lockfile --ignore-workspace

# Source of truth for the TS3 UDP client stays in the backend package.
COPY packages/backend/src/voice/tslib /app/packages/backend/src/voice/tslib
COPY packages/discord-bridge/tsconfig.json ./
COPY packages/discord-bridge/scripts ./scripts
COPY packages/discord-bridge/src ./src
COPY tsconfig.base.json /app/tsconfig.base.json

RUN node scripts/sync-tslib.mjs \
 && pnpm run typecheck \
 && pnpm test \
 && pnpm run smoke:deps

RUN mkdir -p evidence && chown -R node:node /app/packages/discord-bridge/evidence
USER node
# The lab never listens on a port. Control is stdin/stdout only.
CMD ["pnpm", "run", "smoke:deps"]
