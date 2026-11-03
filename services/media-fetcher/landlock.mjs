/** Landlock ABI >= 4 is mandatory. No PID-only fallback. */
export const MIN_LANDLOCK_ABI = 4;

export function landlockDisabledByEnv(env = process.env) {
  return (env.LL_WRAP ?? '').trim() === '0'
    || (env.MEDIA_FETCHER_DISABLE_LANDLOCK ?? '').trim() === '1';
}

export function parseCheckOutput(stdout, status) {
  const m = /landlock_abi=(\d+)/.exec(stdout || '');
  const abi = m ? Number(m[1]) : 0;
  const fs = /landlock_fs=1/.test(stdout || '');
  return { ok: status === 0 && abi >= MIN_LANDLOCK_ABI && fs, abi, fs };
}
