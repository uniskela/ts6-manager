export function musicRequestSourceLabel(source: string): string {
  const labels: Record<string, string> = {
    local: 'Local file', youtube: 'YouTube', radio: 'Radio', url: 'Link',
    twitch: 'Twitch', soundcloud: 'SoundCloud',
  };
  return labels[source] ?? 'Link';
}
