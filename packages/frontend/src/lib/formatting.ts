export function formatLocalTime(value: Date | number, locales?: Intl.LocalesArgument): string {
  return new Intl.DateTimeFormat(locales, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(value);
}
