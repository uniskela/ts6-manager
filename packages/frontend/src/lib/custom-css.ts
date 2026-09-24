/** Hard limit for stored/imported custom CSS (UTF-8 bytes). */
export const CUSTOM_CSS_MAX_BYTES = 64 * 1024;

/** Managed style element id — only one instance is ever mounted. */
export const CUSTOM_CSS_STYLE_ID = 'ts6-custom-css';

/** Recovery path shown before enabling custom CSS (query latch, not persisted). */
export const SAFE_UI_RECOVERY_PATH = '/settings?tab=appearance&safe-ui=1';

export function utf8ByteLength(text: string): number {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(text).length;
  }
  // Extremely old environments without TextEncoder: approximate with URI encoding.
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

export function isCustomCssWithinLimit(text: string): boolean {
  return utf8ByteLength(text) <= CUSTOM_CSS_MAX_BYTES;
}

/** Sanitize persisted/imported CSS text. Oversized or non-string → empty. */
export function sanitizeCustomCssText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return isCustomCssWithinLimit(value) ? value : '';
}

export function sanitizeCustomCssEnabled(value: unknown, text: string): boolean {
  return value === true && text.length > 0;
}

/**
 * Ensure exactly one managed `<style>` node exists and set CSS via textContent only.
 * Never parses CSS as HTML or creates script nodes.
 */
export function syncCustomCssStyle(cssText: string | null): void {
  if (typeof document === 'undefined') return;

  const existing = document.getElementById(CUSTOM_CSS_STYLE_ID);

  if (cssText == null || cssText.length === 0) {
    existing?.remove();
    return;
  }

  let styleEl = existing;
  if (!(styleEl instanceof HTMLStyleElement)) {
    existing?.remove();
    styleEl = document.createElement('style');
    styleEl.id = CUSTOM_CSS_STYLE_ID;
    // After application stylesheets so overrides win predictably.
    document.head.appendChild(styleEl);
  }

  styleEl.textContent = cssText;
}

export function removeCustomCssStyle(): void {
  syncCustomCssStyle(null);
}
