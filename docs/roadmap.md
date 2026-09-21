# Roadmap

This fork intentionally stays focused on core TeamSpeak management rather than absorbing every upstream feature.

## Implemented phases

### Security baseline

Delivered controls include encrypted stored credentials, authenticated sidecar calls, internal-only media networking, SSRF protections, required production encryption keys, and security/release hardening.

### Reliability

Completed work includes WebQuery and SSH reconnection improvements, safer connection refresh behavior, bot fixes, and better error handling.

### Core quality of life

The fork added media-library improvements, bot and permissions UI refinements, safer temporary-channel behavior, automation improvements, and controlled yt-dlp lifecycle management.

### Video and restart reliability — v1.4.0

v1.4 focused on video-sidecar reliability, A/V synchronization, encoder tuning, stream timeouts, and cleaner shutdown/restart behavior.

### Music transport and memory reliability — v1.5.0

v1.5 improved TeamSpeak voice target resolution, bounded-memory local/downloaded playback, FFmpeg pacing, and reconnect overlap protection.

### TeamSpeak beta13 and safer operations — v1.6.0

v1.6 adds:

- authenticated beta13 compatibility testing;
- explicit guest-Query guidance;
- deterministic admin-key documentation;
- persistent per-flow temporary-channel ownership;
- playlist, repeat, seek, and remove chat controls;
- bounded yt-dlp download progress;
- queue/shuffle correctness fixes;
- pruned production Node runtimes; and
- a four-image Trivy gate for fixable HIGH/CRITICAL findings.

## Follow-up direction

Planned work remains intentionally separated into dedicated changes.

### Observability and operations — v1.8 direction

A dedicated [v1.8 Observability & Operations tracker](https://github.com/uniskela/ts6-manager/issues/91) groups the next operator-focused improvements after the current UI/UX work.

The direction includes:

- optional use of TeamSpeak native metrics as a richer dashboard data source, with authenticated WebQuery fallback;
- staged connection diagnostics that distinguish reachability, authentication, usable permissions, and virtual-server access;
- a Server Logs 2.0 pass focused on context, time presentation, filtering, and mobile-safe operation;
- bounded admin audit and TeamSpeak activity history without recording secrets; and
- demand-driven health/diagnostic checks that avoid unnecessary permanent polling.

This work should preserve the existing security model: metrics and diagnostics remain backend-mediated, access-controlled, tightly scoped to configured TeamSpeak servers, and safe to disable without reducing normal management functionality. It is not intended to add a bundled monitoring stack or long-term time-series platform.

### Framework modernization

Future major upgrades may include newer React, Vite, Tailwind, React Router, TypeScript, Express, Prisma, Node, and pnpm generations. These should be upgraded deliberately rather than bundled into unrelated features.

### CI and dependency hygiene

Keep image scanning, base-image updates, dependency review, and dead-dependency cleanup current.

### Music and voice validation

Continue runtime testing for long-track memory use, seek/repeat/queue behavior, reconnects, and real-world media extraction changes.

### Streaming

Continue validating quality presets, source compatibility, and sidecar/media transport behavior against current TeamSpeak and browser versions.

## Explicit scope boundaries

The fork currently does not plan to adopt features that weaken the sidecar/encryption boundaries or turn TS6 Manager into a general container orchestrator.

Large unrelated suites such as Discord bridges, broad SSO absorption, or opportunistic framework migrations should remain separate decisions.
