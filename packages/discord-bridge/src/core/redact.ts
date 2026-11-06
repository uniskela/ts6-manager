/** Discord bot token shape: base64(user id) . timestamp . hmac. */
const DISCORD_TOKEN = /[A-Za-z0-9_-]{23,30}\.[A-Za-z0-9_-]{5,8}\.[A-Za-z0-9_-]{25,}/g;
const BEARER = /Bearer\s+[\w.~+/=-]+/gi;
const KEY_VALUE = /\b(token|secret|password|identity|private_?key|authorization)\b(["']?\s*[:=]\s*["']?)([^\s"',;}]+)/gi;

const known = new Set<string>();

/** Register an exact secret value so it is scrubbed even if it does not match a known shape. */
export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 8) known.add(value);
}

export function redact(input: string): string {
  let out = input;
  for (const s of known) out = out.split(s).join("[REDACTED]");
  return out.replace(DISCORD_TOKEN, "[REDACTED]").replace(BEARER, "Bearer [REDACTED]").replace(KEY_VALUE, "$1$2[REDACTED]");
}

export type LogFn = (line: string) => void;

export function createLogger(scope: string, sink: LogFn = (l) => process.stderr.write(`${l}\n`)) {
  const emit = (level: string, msg: string) => sink(redact(`${new Date().toISOString()} ${level} [${scope}] ${msg}`));
  return {
    info: (m: string) => emit("INFO", m),
    warn: (m: string) => emit("WARN", m),
    error: (m: string) => emit("ERROR", m),
  };
}
export type Logger = ReturnType<typeof createLogger>;

/** Error text safe to log: message only, never the stack or a request config. */
export function safeError(e: unknown): string {
  return redact(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
}
