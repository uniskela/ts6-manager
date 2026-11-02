/** Shared token file must not be world-accessible. */
export function assertPrivateTokenMode(mode) {
  if ((mode & 0o007) !== 0) throw new Error('token world-accessible');
}
