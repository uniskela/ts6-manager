/** Shared credential files must not be world-accessible. */
import { timingSafeEqual } from 'node:crypto';

export function assertPrivateTokenMode(mode) {
  if ((mode & 0o007) !== 0) throw new Error('token world-accessible');
}

/** Constant-time string compare. Different lengths still return false. */
export function tokensEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    if (left.length > 0) timingSafeEqual(left, left);
    return false;
  }
  if (left.length === 0) return true;
  return timingSafeEqual(left, right);
}
