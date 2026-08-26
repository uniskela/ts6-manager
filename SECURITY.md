# Security Policy

## Supported versions

This repository (`uniskela/ts6-manager`) is an opinionated continuation of the original `clusterzx/ts6-manager` project. Security fixes are applied on the default branch of this fork.

## Reporting a vulnerability

Please open a **private** security advisory on GitHub if available, or email the repository maintainers via the GitHub profile contact options. Do not open a public issue for unfixed vulnerabilities that enable remote code execution, credential theft, or unauthorized TeamSpeak control.

Include:

- Affected commit / Docker image tag
- Reproduction steps
- Impact assessment

## Hardening checklist for operators

- Set strong unique values for `JWT_SECRET`, `ENCRYPTION_KEY`, and `SIDECAR_SECRET` in production
- Do not publish sidecar port `9800` to the public internet (compose defaults keep it internal)
- Prefer reverse-proxy TLS termination in front of the frontend
- Treat YouTube cookie files as secrets
- Keep images and dependencies updated; run `pnpm audit` after upgrades

## Known design tradeoffs

- SPA auth tokens are stored in `localStorage` (XSS risk if the UI is compromised)
- WebSocket auth uses a JWT query parameter (may appear in access logs)
- Bot flow expressions are evaluated with a sandboxed expression library; keep flows admin-only
