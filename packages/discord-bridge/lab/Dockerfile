# Bridge-D1 lab image. NOT a production image and not wired into any default compose file.
# Build context is the repository root (the worker reuses packages/backend/src/voice/tslib):
#   docker build -f packages/discord-bridge/lab/Dockerfile -t ts6-discord-bridge-lab:d1 .
#
# Two stages. Everything that needs a registry (corepack/pnpm, the lockfile install, the native Opus
# addon compile) happens in `build`, which also gates on typecheck, unit tests and the native
# Opus/DAVE smoke. `runtime` receives the finished tree and runs preinstalled executables directly:
# it contains no package manager, never resolves or downloads a package, and nothing it runs writes
# to a root-owned path (node_modules, .vendor and src stay root-owned and read-only to the user).
#
# Base is pinned by digest so the Node 24 + glibc toolchain is reproducible. Both stages use the same
# digest, so the addon built in `build` loads against the same glibc in `runtime`.
# node:24-bookworm (v24.22.1) at this digest; the digest alone fixes the image.
ARG NODE_IMAGE=node@sha256:6449e19d8184d84062525b6a7524def03146c2cb04a7f08b076680d0e8e4240a

FROM ${NODE_IMAGE} AS build
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

# Gates. Executables are called directly so the build exercises the same entry points as runtime.
RUN node scripts/sync-tslib.mjs \
 && ./node_modules/.bin/tsc --noEmit \
 && ./node_modules/.bin/tsx --test --test-force-exit --test-timeout=120000 $(find src -name '*.test.ts' | sort) \
 && ./node_modules/.bin/tsx src/lab/smoke-deps.ts \
 && rm -rf evidence \
 && mkdir evidence

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app/packages/discord-bridge
# Root-owned and read-only to the node user: the runtime cannot install, sync or patch anything.
COPY --from=build /app/packages/discord-bridge/node_modules ./node_modules
COPY --from=build /app/packages/discord-bridge/.vendor ./.vendor
COPY --from=build /app/packages/discord-bridge/src ./src
COPY --from=build /app/packages/discord-bridge/package.json /app/packages/discord-bridge/tsconfig.json ./
COPY --from=build /app/tsconfig.base.json /app/tsconfig.base.json
# The one writable place: smoke and lab runs write their evidence JSON here.
COPY --from=build --chown=node:node /app/packages/discord-bridge/evidence ./evidence
USER node
# The lab never listens on a port. Control is stdin/stdout only.
ENTRYPOINT ["./node_modules/.bin/tsx"]
CMD ["src/lab/smoke-deps.ts"]
