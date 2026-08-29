/** Parse MusicBot.commandChannelIds JSON (array of channel ID strings). */
export function parseCommandChannelIds(raw: string | null | undefined): string[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((v) => String(v).trim())
      .filter((v) => v.length > 0 && /^\d+$/.test(v));
  } catch {
    return [];
  }
}

export function serializeCommandChannelIds(ids: string[]): string | null {
  const unique = [...new Set(ids.map((id) => id.trim()).filter((id) => /^\d+$/.test(id)))];
  return unique.length > 0 ? JSON.stringify(unique) : null;
}

export function channelListenerKey(configId: number, sid: number, channelId: number): string {
  return `${configId}:${sid}:${channelId}`;
}
