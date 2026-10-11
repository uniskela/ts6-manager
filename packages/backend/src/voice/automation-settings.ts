import { DEFAULT_BOT_AUTOMATION_SETTINGS, type BotAutomationSettings } from '@ts6/common';
import { AppError } from '../middleware/error-handler.js';

function object(raw: unknown, fields: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      Object.keys(raw).length !== fields.length || fields.some((key) => !Object.hasOwn(raw, key))) {
    throw new AppError(400, 'Invalid automation settings fields');
  }
  return raw as Record<string, unknown>;
}

/** Full replacement, with no coercion or silently ignored fields. */
export function parseAutomationSettings(raw: unknown): BotAutomationSettings {
  const data = object(raw, Object.keys(DEFAULT_BOT_AUTOMATION_SETTINGS));
  for (const key of ['enabled', 'requireListeners', 'stayInChannel']) {
    if (typeof data[key] !== 'boolean') throw new AppError(400, `${key} must be a boolean`);
  }
  for (const [key, min, max] of [
    ['quietPeriodSeconds', 0, 86400], ['retryBaseSeconds', 1, 3600], ['retryMaxSeconds', 1, 86400],
  ] as const) {
    if (typeof data[key] !== 'number' || !Number.isSafeInteger(data[key]) || data[key] < min || data[key] > max) {
      throw new AppError(400, `${key} must be a whole number from ${min} to ${max}`);
    }
  }
  if ((data.retryMaxSeconds as number) < (data.retryBaseSeconds as number)) {
    throw new AppError(400, 'retryMaxSeconds must be at least retryBaseSeconds');
  }
  let source: BotAutomationSettings['source'] = null;
  if (data.source !== null) {
    const candidate = object(data.source, ['kind', 'id']);
    if ((candidate.kind !== 'playlist' && candidate.kind !== 'radio') ||
        typeof candidate.id !== 'number' || !Number.isSafeInteger(candidate.id) || candidate.id <= 0) {
      throw new AppError(400, 'source must reference a saved playlist or radio station');
    }
    source = { kind: candidate.kind, id: candidate.id };
  }
  if (data.enabled && !source) throw new AppError(400, 'Choose a saved source before enabling Auto-DJ');
  return { ...data, source } as BotAutomationSettings;
}

/** Old rows and corrupt checkpoints cannot enable automation by accident. */
export function readAutomationSettings(raw: string | null | undefined): BotAutomationSettings {
  if (raw) {
    try { return parseAutomationSettings(JSON.parse(raw)); } catch { /* fail closed */ }
  }
  return { ...DEFAULT_BOT_AUTOMATION_SETTINGS };
}
