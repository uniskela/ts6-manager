# Voice Transport Reliability Implementation Plan

> **Goal:** Stop TeamSpeak voice playback from repeatedly resolving the server hostname for every UDP packet.

**Architecture:** Keep the low-level TeamSpeak protocol client unchanged. Resolve the configured host once at connection start in the `tslib` public wrapper, then pass the resolved IPv4 address to the existing client. A small injectable resolver helper keeps the behaviour unit-testable without real DNS.

**Tech stack:** TypeScript, Node.js `dns/promises`, Node.js `net`, Node test runner.

---

### Task 1: Pin UDP target resolution behaviour

**Files:**
- Create: `packages/backend/src/voice/tslib/udp-target.test.ts`
- Create: `packages/backend/src/voice/tslib/udp-target.ts`

1. Add a test showing an IPv4 literal does not invoke DNS.
2. Add a test showing a hostname invokes the supplied lookup exactly once and returns the resolved IPv4 address.
3. Implement `resolveUdpTarget()` with an injectable lookup function.

### Task 2: Resolve once at TeamSpeak connection start

**Files:**
- Modify: `packages/backend/src/voice/tslib/index.ts`

1. Wrap the existing protocol `Ts3Client` export rather than modifying protocol packet code.
2. Override `connect()` to resolve `options.host` once.
3. Delegate to the existing protocol client with the resolved IPv4 address.
4. Preserve all other `Ts3ClientOptions` unchanged.

### Task 3: Verification

1. Run `pnpm --filter @ts6/common build`.
2. Run `pnpm --filter @ts6/backend typecheck`.
3. Run `pnpm --filter @ts6/backend exec tsx --test src/voice/tslib/udp-target.test.ts`.
4. Compare the branch with `main` and confirm only the resolver helper/test, `tslib/index.ts`, and this plan changed.
5. Runtime smoke test on a hostname-backed TeamSpeak connection: start a music bot, play audio for several minutes, and confirm no DNS-resolution-related disconnect occurs.

**Environment note:** The ChatGPT execution sandbox could not resolve GitHub, so repository writes were made through the connected GitHub app. Local commands in step 3 must be treated as pending unless an external runner/maintainer executes them; do not claim them as passed without evidence.
