import { isAbsolute } from 'node:path';

/** Select the bundled executable or an operator-supplied absolute path, never PATH. */
export function getYtDlpPath(env: NodeJS.ProcessEnv = process.env): string {
  const executable = env.YT_DLP_PATH ?? '/usr/local/bin/yt-dlp';
  if (!isAbsolute(executable)) throw new Error('YT_DLP_PATH must be an absolute path');
  return executable;
}
