# Development

Local development targets Node.js 20+ and pnpm 9.x. CI deliberately stays on pnpm 9 because newer pnpm majors change dependency build-script and override behavior.

## Setup

~~~bash
corepack enable
corepack prepare pnpm@9.15.9 --activate
pnpm install --frozen-lockfile
pnpm db:generate
pnpm dev
~~~

The backend runs on port 3001 and the Vite frontend runs on port 5173 by default.

## Useful workspace commands

| Command | Purpose |
|---|---|
| `pnpm dev` | Start workspace development servers |
| `pnpm dev:backend` | Start only the backend |
| `pnpm dev:frontend` | Start only the frontend |
| `pnpm build` | Build all packages |
| `pnpm typecheck` | Run workspace type checks |
| `pnpm audit` | Audit production dependencies |
| `pnpm db:generate` | Generate the Prisma client |

## Database

The backend uses Prisma with SQLite.

For local development:

~~~bash
cd packages/backend
npx prisma db push
npx prisma db seed
~~~

Docker production startup uses `docker-commands/apply-schema.sh` instead of requiring a manual migration step.

## Containers

To build the local compose stack from source:

~~~bash
docker compose -f docker-compose.local.yml up -d --build
~~~

Release images are published only from immutable releases, not ordinary pushes to `main`.
