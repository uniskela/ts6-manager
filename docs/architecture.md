# Architecture

TS6 Manager is a pnpm monorepo with a React frontend, Express backend, shared TypeScript package, SQLite database, and Go media sidecar.

~~~text
┌──────────────┐     ┌──────────────┐     ┌─────────────────┐
│   Frontend   │────▶│   Backend    │────▶│  TS Server      │
│  React SPA   │     │  Express API │     │  WebQuery HTTP  │
│  nginx :80   │     │  Node :3001  │     │  SSH (events)   │
└──────────────┘     └──────┬───────┘     └─────────────────┘
                            │
                     ┌──────┴───────┐
                     │   SQLite     │
                     │   Prisma     │
                     └──────────────┘
                            │
                     ┌──────┴───────┐
                     │   Sidecar    │
                     │  Go / Pion   │
                     │ WebRTC :9800 │
                     └──────────────┘
~~~

## Packages

| Package | Responsibility |
|---|---|
| `@ts6/common` | Shared types, constants, and utilities |
| `@ts6/backend` | Express API, WebQuery client, bot engine, voice bots, widgets |
| `@ts6/frontend` | React/Vite SPA, Tailwind, shadcn/ui |
| `sidecar` | Go/Pion WebRTC media relay |

## Trust boundaries

The frontend never receives or talks directly to stored TeamSpeak API keys. TeamSpeak management calls pass through the backend.

The backend:

- authenticates application users;
- enforces role and per-server access;
- decrypts stored credentials when needed;
- communicates with TeamSpeak WebQuery/SSH; and
- calls the authenticated media sidecar.

The sidecar is an internal media service and should not be exposed directly.

## Public widget path

Widget tokens allow unauthenticated access only to deliberately published widget output. They are separate from normal authenticated application APIs.

## Deployment shapes

### Split stack

nginx frontend, backend, and sidecar run as separate containers on an internal network.

### All-in-one

nginx, backend, and sidecar run in one image. nginx is the published service; backend and sidecar remain on loopback.

See [Installation](installation.md) for deployment commands and [Security](security.md) for the expected network boundaries.
