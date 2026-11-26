/** Test helper: pull HttpOnly session + CSRF from exchange Set-Cookie headers. */
export function credentialsFromExchange(res: Response): { session: string; csrf: string } {
  const lines = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : String(res.headers.get('set-cookie') ?? '').split(/,(?=\s*[^;]+=)/);
  let session = '';
  let csrf = '';
  for (const line of lines) {
    const sessionMatch = /^ts6_lr_session=([^;]+)/.exec(line.trim());
    if (sessionMatch) session = decodeURIComponent(sessionMatch[1]!);
    const csrfMatch = /^ts6_lr_csrf=([^;]+)/.exec(line.trim());
    if (csrfMatch) csrf = decodeURIComponent(csrfMatch[1]!);
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(session) || !/^[A-Za-z0-9_-]{43}$/.test(csrf)) {
    throw new Error('exchange response missing session cookies');
  }
  return { session, csrf };
}
