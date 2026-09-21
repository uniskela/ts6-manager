export function formatLocalTime(value: Date | number, locales?: Intl.LocalesArgument): string {
  return new Intl.DateTimeFormat(locales, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(value);
}

export function formatLocalDateTime(value: Date | number | string, locales?: Intl.LocalesArgument): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString(locales);
}

export function formatNumber(value: number, locales?: Intl.LocalesArgument): string {
  return Number.isFinite(value) ? value.toLocaleString(locales) : '—';
}
