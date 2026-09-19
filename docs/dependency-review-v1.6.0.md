# Dependency review for v1.6.0

Reviewed 2026-09-19 against the lockfile, `pnpm audit --prod`, GitHub Dependabot
alerts and Trivy's repository vulnerability scanner. Upstream #80 is context,
not evidence that this fork has the same dependency graph.

The starting production audit had one high and three moderate advisories, with
no critical advisories. Prisma/client were updated together from 6.19.2 to 6.19.3.
Prisma 6 still pins `deepmerge-ts` 7.1.5, affected by CVE-2026-40345 (recursive
merge stack exhaustion). The narrow `@prisma/config>deepmerge-ts` override selects
patched 8.x, retaining Node 20 and the existing Prisma major. Its `deepmerge`
export remains available in both ESM and CommonJS. Prisma generation, workspace
builds and tests validate this combination. Remove this override when a compatible
Prisma release uses patched deepmerge itself. No advisory ignore was added.

The resulting production audit has **zero high/critical and three moderate**
advisories. Trivy's repository scan likewise has no high/critical findings.

Remaining production advisories:

- `uuid` through `node-cron` 3: GHSA-w5hq-g745-h8pq concerns v3/v5/v6 with
  caller-provided buffers/offsets. node-cron uses v4 without an external buffer.
  Updating this indirect dependency across majors merely to suppress that report
  is not necessary for this release; revisit with a tested scheduler upgrade.
- `react-router` 6: GHSA-337j-9hxr-rhxg concerns SSR hydration deserialization;
  this application is a client-rendered Vite SPA, not a React Router SSR server.
- `react-router` 6: GHSA-wrjc-x8rr-h8h6 concerns backslash open redirects in Link
  and navigate. Application navigation uses internal application routes; untrusted
  media URLs are not navigation destinations. Patched versions require Router 7;
  defer that framework migration and continue avoiding user-controlled destinations.

GitHub also reports low-severity esbuild Windows development-server exposure.
Production serves static frontend assets through nginx, not esbuild's development
server. The production audit does not include this development-only path.

Existing rollup/lodash/path-to-regexp/picomatch/defu/qs/browserslist/Babel/effect/
PostCSS/body-parser overrides were checked in the resolved graph. They were not
broadened, ignored or rolled back to older vulnerable versions. Frozen installs
now apply to all JavaScript image builds. Image-specific OS findings and media-tool
versions are recorded in the PR's validation section, separately from the npm audit.

## Container OS findings — release review required

The freshly built sidecar on Debian 12.15 has **249 high/critical package findings**
(the same FFmpeg advisories are repeated for each binary package); the Go binary has
none. The static nginx frontend image has none. These are distinct from the clean
high/critical npm/repository result. All sidecar findings below are actually installed;
Trivy provides **no fixed Bookworm package version** for any of them at scan time.
The image already installs current packages from the configured Debian repositories.
No ignores, severity downgrades or untested cross-suite package replacements were added.

FFmpeg and linked media parsers process supplied media, so their findings are **not
blanket-dismissed as unreachable**. A dedicated base-image/media-runtime update and
playback/codec validation is recommended before publishing this release. This PR
should remain a draft until those residual image risks receive a maintainer release
decision or remediation. Application-level changes do not resolve these OS advisories.

The inventory below deduplicates identical advisory sets across installed packages.
“Not directly invoked” is narrower than “not vulnerable”: transitive reachability
has not been disproved unless explicitly stated.

| Installed packages (version) | High/critical advisory IDs | Assessment |
|---|---|---|
| `bsdutils` 1:2.38.1-5+deb12u3, `libblkid1` 2.38.1-5+deb12u3, `libmount1` 2.38.1-5+deb12u3, `libsmartcols1` 2.38.1-5+deb12u3, `libuuid1` 2.38.1-5+deb12u3, `mount` 2.38.1-5+deb12u3, `util-linux` 2.38.1-5+deb12u3, `util-linux-extra` 2.38.1-5+deb12u3 | CVE-2026-53613, CVE-2026-76642, CVE-2026-78408, CVE-2026-78409, CVE-2026-78410 | Mount/nsenter/cgroup privilege paths are not invoked by the app; ordinary unprivileged container use does not grant host mount authority. No distro fix reported. |
| `ffmpeg` 7:5.1.9-0+deb12u1, `libavcodec59` 7:5.1.9-0+deb12u1, `libavdevice59` 7:5.1.9-0+deb12u1, `libavfilter8` 7:5.1.9-0+deb12u1, `libavformat59` 7:5.1.9-0+deb12u1, `libavutil57` 7:5.1.9-0+deb12u1, `libpostproc56` 7:5.1.9-0+deb12u1, `libswresample4` 7:5.1.9-0+deb12u1, `libswscale6` 7:5.1.9-0+deb12u1 | CVE-2026-58049, CVE-2026-64830, CVE-2026-64832, CVE-2026-64833, CVE-2026-64834, CVE-2026-64835, CVE-2026-66036, CVE-2026-66039, CVE-2026-66040, CVE-2026-70628, CVE-2026-70632, CVE-2026-75142, CVE-2026-75143, CVE-2026-75144, CVE-2026-75146, CVE-2026-8461 | Media dependency; potentially reachable with crafted input. No compatible distro fix reported; release risk remains. |
| `gzip` 1.12-1 | CVE-2026-41992 | Runtime app does not invoke Perl/archive or terminal tooling on user input. Package-level finding remains; no distro fix reported. |
| `libacl1` 2.3.1-3 | CVE-2026-54369 | Installed transitive library; full exploit-path reachability not established. No distro fix reported; retained as an unresolved image finding. |
| `libaom3` 3.6.0-1+deb12u3 | CVE-2023-39616, CVE-2023-6879 | Media dependency; potentially reachable with crafted input. No compatible distro fix reported; release risk remains. |
| `libcjson1` 1.7.15-1+deb12u4 | CVE-2026-16554, CVE-2026-29036, CVE-2026-67215, CVE-2026-67216, CVE-2026-87933 | Installed transitive library; full exploit-path reachability not established. No distro fix reported; retained as an unresolved image finding. |
| `libexpat1` 2.5.0-1+deb12u3 | CVE-2025-59375, CVE-2026-25210, CVE-2026-45186, CVE-2026-66046 | Installed transitive library; full exploit-path reachability not established. No distro fix reported; retained as an unresolved image finding. |
| `libglib2.0-0` 2.74.6-2+deb12u9 | CVE-2026-58010, CVE-2026-58011, CVE-2026-58012, CVE-2026-58013, CVE-2026-58014, CVE-2026-58015, CVE-2026-58016 | Installed transitive library; full exploit-path reachability not established. No distro fix reported; retained as an unresolved image finding. |
| `libharfbuzz0b` 6.0.0+dfsg-3 | CVE-2023-25193 | Installed transitive library; full exploit-path reachability not established. No distro fix reported; retained as an unresolved image finding. |
| `libjxl0.7` 0.7.0-10+deb12u1 | CVE-2025-70103 | Media dependency; potentially reachable with crafted input. No compatible distro fix reported; release risk remains. |
| `libmbedcrypto7` 2.28.3-1 | CVE-2024-23775, CVE-2025-47917, CVE-2025-48965, CVE-2025-52496, CVE-2026-25835, CVE-2026-34872, CVE-2026-34873, CVE-2026-34875 | Installed transitive library; full exploit-path reachability not established. No distro fix reported; retained as an unresolved image finding. |
| `libmfx1` 22.5.4-1 | CVE-2023-45221 | Media dependency; potentially reachable with crafted input. No compatible distro fix reported; release risk remains. |
| `libncursesw6` 6.4-4, `libtinfo6` 6.4-4, `ncurses-base` 6.4-4, `ncurses-bin` 6.4-4 | CVE-2025-69720 | Runtime app does not invoke Perl/archive or terminal tooling on user input. Package-level finding remains; no distro fix reported. |
| `libsndfile1` 1.2.0-1+deb12u1 | CVE-2026-37555 | Media dependency; potentially reachable with crafted input. No compatible distro fix reported; release risk remains. |
| `libssh-gcrypt-4` 0.10.6-0+deb12u2 | CVE-2026-0966, CVE-2026-15370, CVE-2026-3731, CVE-2026-59847, CVE-2026-59849, CVE-2026-59850 | Installed transitive library; full exploit-path reachability not established. No distro fix reported; retained as an unresolved image finding. |
| `libsystemd0` 252.39-1~deb12u2, `libudev1` 252.39-1~deb12u2 | CVE-2026-16742 | Finding concerns systemd-homed, not app behavior; no homed service is configured. Library package remains flagged; no distro fix reported. |
| `libtiff6` 4.5.0-6+deb12u4 | CVE-2023-52355, CVE-2026-12912, CVE-2026-36849, CVE-2026-52490 | Media dependency; potentially reachable with crafted input. No compatible distro fix reported; release risk remains. |
| `libxml2` 2.9.14+dfsg-1.3~deb12u6 | CVE-2026-6653, CVE-2026-74860, CVE-2026-86138, CVE-2026-86139, CVE-2026-86140, CVE-2026-86142, CVE-2026-86143, CVE-2026-86144 | Installed transitive library; full exploit-path reachability not established. No distro fix reported; retained as an unresolved image finding. |
| `perl-base` 5.36.0-7+deb12u3 | CVE-2026-13221, CVE-2026-42496, CVE-2026-42497, CVE-2026-48962, CVE-2026-57432, CVE-2026-57433, CVE-2026-8376, CVE-2026-9538 | Runtime app does not invoke Perl/archive or terminal tooling on user input. Package-level finding remains; no distro fix reported. |
| `zlib1g` 1:1.2.13.dfsg-1 | CVE-2023-45853 | CVE concerns contrib/minizip; Debian marks will_not_fix. No app zip writer uses this path; keep vendor finding visible. |


## Final container security workflow result

PR #55 includes `.github/workflows/container-security.yml`, which builds the same
four final Dockerfiles used for release and scans each image with Trivy 0.70.0.
The workflow uploads a full JSON inventory, prints all HIGH/CRITICAL findings, and
fails only when Trivy reports a HIGH/CRITICAL finding with an available fix
(`ignore-unfixed=true` for the gate). No vulnerability ignores are used.

The first release-gate run correctly failed backend and all-in-one because their
runtime images inherited build tooling (Corepack/pnpm/npm and workspace
`node_modules`, including esbuild) plus several Debian packages with available
security updates. The remediation:

- builds with pnpm only in a dedicated build stage;
- deploys a self-contained backend with production dependencies only;
- keeps Prisma CLI as an explicit runtime dependency because startup uses
  `prisma db push`;
- runs the seed with plain Node instead of tsx;
- starts production from a fresh Node image and removes npm/Corepack package-manager
  tooling from that runtime;
- upgrades Debian packages before installing runtime media dependencies; and
- validates inside the finished backend/all-in-one images that npm/npx/pnpm/Corepack
  and esbuild are absent while Prisma schema apply and seeding still succeed.

Workflow run **35447241210** then passed all four image gates:

| Image | Full HIGH/CRITICAL inventory | Fixable HIGH/CRITICAL gate | Result |
|---|---:|---:|---|
| frontend | none reported | 0 | PASS |
| sidecar | 249 (239 high, 10 critical) | 0 | PASS |
| backend | 276 (265 high, 11 critical) | 0 | PASS |
| all-in-one | 287 (276 high, 11 critical) | 0 | PASS |

Compared with the failing run, the backend's 9 fixable OS findings and the 49
bundled Node-tooling + 22 esbuild Go-runtime findings no longer appear as fixable
runtime findings. The all-in-one image likewise removed its 8 fixable OS findings
and the same bundled Node/esbuild categories. Build logs confirm the available
Debian updates for `libcap2`, `libgnutls30`, and `libpcre2-8-0` were installed.

The remaining HIGH/CRITICAL counts are still retained in the full Trivy artifacts.
They are primarily Debian/media/Python/SQLite findings for which this scan reports
no available Bookworm fix, so they do not pass silently: they remain visible for
future base-image/package updates and reachability review. The sidecar has the same
policy. No advisory was ignored or severity-downgraded to make the gate pass.

Current runtime versions validated during the final backend build are yt-dlp
2026.08.19, FFmpeg 5.1.9-0+deb12u1, and Node 20.20.2.
