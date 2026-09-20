export function apiErrorMessage(error: unknown, fallback: string): string {
  const err = error as any;
  const data = err?.response?.data;
  if (data?.error && data?.details) return `${data.error}. ${data.details}`;
  if (data?.details) return String(data.details);
  if (data?.error) return String(data.error);
  if (err?.message) return String(err.message);
  return fallback;
}
