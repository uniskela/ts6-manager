const PREFIX = "[TS] ";
const MAX = 32;

/** `[TS] Username`, at most 32 UTF-16 code units. The prefix is kept and the name is truncated. */
export function tsNickname(displayName: string): string {
  const room = MAX - PREFIX.length;
  let name = displayName.trim() || "Unknown";
  if (name.length > room) {
    name = name.slice(0, room);
    const last = name.charCodeAt(name.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) name = name.slice(0, -1); // never leave half a surrogate pair
  }
  return PREFIX + name;
}

export const OVERFLOW_NICKNAME = `${PREFIX}Others`;
