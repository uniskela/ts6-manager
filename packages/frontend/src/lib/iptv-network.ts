/** Split the allowlist textarea into trimmed, unique, lower-case entries (commas or new lines). */
export function parseHostLines(text: string): string[] {
  const seen = new Set<string>();
  for (const part of text.split(/[\n,]/)) {
    const value = part.trim().toLowerCase();
    if (value) seen.add(value);
  }
  return [...seen];
}
