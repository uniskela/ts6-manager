/// <reference types="vite/client" />

declare const __APP_VERSION__: string;
declare const __GIT_SHA__: string;
/** True only in `pnpm build:e2e` (Vite define). False in ordinary production builds. */
declare const __TS6_E2E_AUTH_HOOKS__: boolean;
