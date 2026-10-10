/**
 * Backend ↔ sidecar release compatibility. The two are built from one tag and
 * share an HTTP contract that changes between releases, so the supported
 * pairing is the same version on both sides. A native sidecar is installed
 * separately from the backend image and can be left behind on upgrade.
 */

export type SidecarVersionState = 'match' | 'mismatch' | 'unknown';

export interface SidecarVersionCheck {
  state: SidecarVersionState;
  /** Sidecar version as reported, or a short label when it reports none. */
  label: string;
  /** Operator-facing note; null when the versions match. */
  note: string | null;
}

function normalize(version: string | null | undefined): string {
  return (version ?? '').trim().replace(/^v/i, '');
}

/**
 * Compare the version from the sidecar's GET /health with the backend's.
 * Sidecars before 1.11 report no version, and a `go build` without release
 * flags reports `dev`; neither can be checked, so they are `unknown`.
 */
export function checkSidecarVersion(
  backendVersion: string | null | undefined,
  sidecarVersion: string | null | undefined,
): SidecarVersionCheck {
  const backend = normalize(backendVersion);
  const sidecar = normalize(sidecarVersion);
  if (!sidecar) {
    return {
      state: 'unknown',
      label: 'unversioned',
      note: 'the sidecar reports no version (older than 1.11) — update it to the backend release',
    };
  }
  if (sidecar === 'dev') {
    return {
      state: 'unknown',
      label: 'dev',
      note: 'the sidecar is an unversioned source build — build it from the backend release',
    };
  }
  if (!backend || backend === sidecar) {
    return { state: backend ? 'match' : 'unknown', label: sidecar, note: null };
  }
  return {
    state: 'mismatch',
    label: sidecar,
    note: `sidecar ${sidecar} does not match backend ${backend} — run both from the same release`,
  };
}
