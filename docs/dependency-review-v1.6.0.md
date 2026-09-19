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

PR #55 now includes `.github/workflows/container-security.yml`, which builds the
same four final Dockerfiles used for release and scans each image with Trivy 0.70.0.
The workflow uploads a full JSON inventory, prints all HIGH/CRITICAL findings, and
fails only when Trivy reports a HIGH/CRITICAL finding with an available fix
(`ignore-unfixed=true` for the gate). No vulnerability ignores are used.

Workflow run 35445751117 produced these release-gate results:

| Image | Full HIGH/CRITICAL inventory | Fixable HIGH/CRITICAL gate | Result |
|---|---:|---:|---|
| frontend | no gate findings | 0 | PASS |
| sidecar | 249 (239 high, 10 critical) | 0 | PASS — current Debian/FFmpeg findings have no Trivy-reported fix |
| backend | 285 OS + 49 bundled Node + 22 bundled Go-runtime | 9 OS + 49 Node + 22 Go-runtime | FAIL |
| all-in-one | 295 OS + 49 bundled Node + 22 bundled Go-runtime | 8 OS + 49 Node + 22 Go-runtime | FAIL |

The backend/all-in-one OS gate includes Debian fixes that are available for packages
such as `libcap2` (backend), `libgnutls30`, and `libpcre2-8-0`. The larger
runtime-image gate is dominated by build tooling that should not need to ship in
production: Corepack's pnpm 9.15.9 dependency tree (including `tar`,
`brace-expansion`, `glob`, `minimatch`, `ip-address`, and `sigstore`) and
the copied esbuild binary built with an older Go standard library. These findings
are separate from the audited production application dependency graph.

Python and SQLite findings without a Bookworm fixed version remain visible in the
full inventory but do not fail the fixable-only gate. The preferred remediation is
to refresh fixable Debian packages and remove unnecessary package-manager/build
tooling from production images, then rerun the workflow with backend startup,
Prisma, media, and all-in-one health validation. Do not suppress or severity-downgrade
the findings merely to make the gate green.

| Package | Installed | Reported fixed version(s) | Additional advisory IDs |
|---|---|---|---|
| `brace-expansion` | `2.0.1` | 1.1.18, 2.1.4, 3.0.6, 5.0.9 | CVE-2026-69152 |
| `brace-expansion` | `2.0.1` | 5.0.7, 1.1.16, 2.1.2 | CVE-2026-13149 |
| `brace-expansion` | `2.0.1` | 5.0.8, 3.0.3, 2.1.3, 1.1.17 | CVE-2026-14257 |
| `cross-spawn` | `7.0.3` | 7.0.5, 6.0.6 | CVE-2024-21538 |
| `glob` | `10.4.2` | 11.1.0, 10.5.0 | CVE-2025-64756 |
| `glob` | `10.4.5` | 11.1.0, 10.5.0 | CVE-2025-64756 |
| `ip-address` | `9.0.5` | 10.3.1 | CVE-2026-69192 |
| `libcap2` | `1:2.66-4+deb12u2+b2` | 1:2.66-4+deb12u3 | CVE-2026-4878 |
| `libgnutls30` | `3.7.9-2+deb12u6` | 3.7.9-2+deb12u7 | CVE-2026-33845, CVE-2026-33846, CVE-2026-3833, CVE-2026-42009, CVE-2026-42010 |
| `libpcre2-8-0` | `10.42-1` | 10.42-1+deb12u1 | CVE-2026-86145, CVE-2026-89157, CVE-2026-89161 |
| `libpython3.11-minimal` | `3.11.2-6+deb12u8` | Not reported | CVE-2025-69534, CVE-2026-11940, CVE-2026-15308, CVE-2026-3644, CVE-2026-7210, CVE-2026-8328 |
| `libpython3.11-stdlib` | `3.11.2-6+deb12u8` | Not reported | CVE-2025-69534, CVE-2026-11940, CVE-2026-15308, CVE-2026-3644, CVE-2026-7210, CVE-2026-8328 |
| `libsqlite3-0` | `3.40.1-2+deb12u2` | Not reported | CVE-2025-7458, CVE-2026-11822, CVE-2026-11824 |
| `minimatch` | `9.0.5` | 10.2.1, 9.0.6, 8.0.5, 7.4.7, 6.2.1, 5.1.7, 4.2.4, 3.1.3 | CVE-2026-26996 |
| `minimatch` | `9.0.5` | 10.2.3, 9.0.7, 8.0.6, 7.4.8, 6.2.2, 5.1.8, 4.2.5, 3.1.3 | CVE-2026-27903 |
| `minimatch` | `9.0.5` | 10.2.3, 9.0.7, 8.0.6, 7.4.8, 6.2.2, 5.1.8, 4.2.5, 3.1.4 | CVE-2026-27904 |
| `pacote` | `18.0.6` | 21.5.1 | CVE-2026-9496 |
| `pnpm` | `9.15.9` | 10.26.0 | CVE-2025-69263 |
| `pnpm` | `9.15.9` | 10.27.0 | CVE-2025-69262 |
| `pnpm` | `9.15.9` | 10.34.0, 11.4.0 | CVE-2026-50015, CVE-2026-50016 |
| `pnpm` | `9.15.9` | 10.34.2, 11.5.3 | CVE-2026-55487, CVE-2026-55697, CVE-2026-55698 |
| `pnpm` | `9.15.9` | 10.34.4, 11.7.0 | GHSA-72r4-9c5j-mj57, GHSA-fr4h-3cph-29xv |
| `pnpm` | `9.15.9` | 10.34.4, 11.8.0 | GHSA-qrv3-253h-g69c |
| `pnpm` | `9.15.9` | 10.34.5, 11.11.0 | CVE-2026-82392, CVE-2026-82393 |
| `python3.11` | `3.11.2-6+deb12u8` | Not reported | CVE-2025-69534, CVE-2026-11940, CVE-2026-15308, CVE-2026-3644, CVE-2026-7210, CVE-2026-8328 |
| `python3.11-minimal` | `3.11.2-6+deb12u8` | Not reported | CVE-2025-69534, CVE-2026-11940, CVE-2026-15308, CVE-2026-3644, CVE-2026-7210, CVE-2026-8328 |
| `sigstore` | `2.3.1` | 4.1.1 | CVE-2026-48815 |
| `stdlib` | `v1.23.12` | 1.24.11, 1.25.5 | CVE-2025-61729 |
| `stdlib` | `v1.23.12` | 1.24.12, 1.25.6 | CVE-2025-61726 |
| `stdlib` | `v1.23.12` | 1.24.13, 1.25.7, 1.26.0-rc.3 | CVE-2025-68121 |
| `stdlib` | `v1.23.12` | 1.25.10, 1.26.3 | CVE-2026-33811, CVE-2026-33814, CVE-2026-39820, CVE-2026-39836, CVE-2026-42499 |
| `stdlib` | `v1.23.12` | 1.25.11, 1.26.4 | CVE-2026-27145, CVE-2026-42504 |
| `stdlib` | `v1.23.12` | 1.25.12, 1.26.5, 1.27.0-rc.2 | CVE-2026-39822 |
| `stdlib` | `v1.23.12` | 1.25.13, 1.26.6, 1.27.0-rc.3 | CVE-2026-33818, CVE-2026-39821, CVE-2026-56853, CVE-2026-56858, CVE-2026-56859, CVE-2026-56860, CVE-2026-56862 |
| `stdlib` | `v1.23.12` | 1.25.8, 1.26.1 | CVE-2026-25679 |
| `stdlib` | `v1.23.12` | 1.25.9, 1.26.2 | CVE-2026-32280, CVE-2026-32281, CVE-2026-32283 |
| `tar` | `6.2.1` | 7.5.10 | CVE-2026-29786 |
| `tar` | `6.2.1` | 7.5.11 | CVE-2026-31802 |
| `tar` | `6.2.1` | 7.5.18 | CVE-2026-59874 |
| `tar` | `6.2.1` | 7.5.19 | CVE-2026-59873 |
| `tar` | `6.2.1` | 7.5.21 | CVE-2026-73566 |
| `tar` | `6.2.1` | 7.5.3 | CVE-2026-23745 |
| `tar` | `6.2.1` | 7.5.4 | CVE-2026-23950 |
| `tar` | `6.2.1` | 7.5.7 | CVE-2026-24842 |
| `tar` | `6.2.1` | 7.5.8 | CVE-2026-26960 |
