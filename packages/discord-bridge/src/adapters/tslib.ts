/**
 * The bridge reuses the repository's existing TS3 UDP implementation (packages/backend/src/voice/tslib)
 * as its protocol foundation. `scripts/sync-tslib.mjs` copies it into the git-ignored `.vendor/tslib`
 * so the isolated lab resolves its own pinned libsodium. The backend copy stays the source of
 * truth and the lab never edits it. D2 decides whether this becomes a shared package.
 */
export { Ts3Client, generateIdentity } from "../../.vendor/tslib/index.js";
export type { IdentityData } from "../../.vendor/tslib/index.js";
