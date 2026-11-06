/// <reference types="vite/client" />

declare const __APP_VERSION__: string;
declare const __GIT_SHA__: string;

interface ImportMetaEnv {
  readonly VITE_E2E_AUTH_HOOKS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
