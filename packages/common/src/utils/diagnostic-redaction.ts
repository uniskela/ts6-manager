/**
 * Strip credentials from diagnostic text before it is shown, copied, or logged.
 * Matches assignment and header forms; leaves ordinary words like "cookies" alone.
 */
const REPLACEMENTS: Array<[RegExp, string]> = [
  [/\b(Cookie|Set-Cookie|Authorization)\s*:\s*[^\r\n]*/gi, '$1: [redacted]'],
  [/\b(https?:\/\/)[^/\s@]+@/gi, '$1[redacted]@'],
  [/Bearer\s+[a-z0-9\-._~+/]+=*/gi, 'Bearer [redacted]'],
  [/\beyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*){0,2}/g, '[redacted-jwt]'],
  [/\benc:[a-f\d]+:[a-f\d]+:[a-f\d]+/gi, '[redacted-credential]'],
  [/(api[_-]?key)['"]?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s&,;]+)/gi, '$1=[redacted]'],
  [/(token|password|passwd)['"]?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s&,;]+)/gi, '$1=[redacted]'],
  [/(secret|cookie|authorization)['"]?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s&,;]+)/gi, '$1=[redacted]'],
];
const SECRET_KEY = /(?:api[_-]?key|token|password|passwd|secret|cookie|authorization)$/i;

export function redactDiagnosticText(value: string): string {
  let out = value;
  for (const [pattern, replacement] of REPLACEMENTS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

export function redactDiagnosticValue<T>(value: T): T {
  if (typeof value === 'string') return redactDiagnosticText(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactDiagnosticValue(item)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
      key, SECRET_KEY.test(key) ? '[redacted]' : redactDiagnosticValue(nested),
    ])) as T;
  }
  return value;
}
