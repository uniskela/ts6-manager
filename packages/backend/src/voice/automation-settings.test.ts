import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_BOT_AUTOMATION_SETTINGS } from '@ts6/common';
import { parseAutomationSettings, readAutomationSettings } from './automation-settings.js';

test('missing and corrupt saved settings fail closed; valid settings round trip', () => {
  for (const raw of [undefined, null, '', '{', JSON.stringify({ enabled: true }), JSON.stringify({ ...DEFAULT_BOT_AUTOMATION_SETTINGS, stayInChannel: 'true' })]) {
    assert.deepEqual(readAutomationSettings(raw), DEFAULT_BOT_AUTOMATION_SETTINGS);
  }
  const settings = { ...DEFAULT_BOT_AUTOMATION_SETTINGS, enabled: true, source: { kind: 'radio' as const, id: 5 }, stayInChannel: true };
  assert.deepEqual(readAutomationSettings(JSON.stringify(settings)), settings);
});

test('settings reject incomplete, unknown, coerced and unbounded values', () => {
  for (const value of [null, [], {},
    { ...DEFAULT_BOT_AUTOMATION_SETTINGS, extra: true },
    { ...DEFAULT_BOT_AUTOMATION_SETTINGS, enabled: 'true' },
    { ...DEFAULT_BOT_AUTOMATION_SETTINGS, enabled: true },
    { ...DEFAULT_BOT_AUTOMATION_SETTINGS, quietPeriodSeconds: -1 },
    { ...DEFAULT_BOT_AUTOMATION_SETTINGS, quietPeriodSeconds: 86401 },
    { ...DEFAULT_BOT_AUTOMATION_SETTINGS, quietPeriodSeconds: 1.5 },
    { ...DEFAULT_BOT_AUTOMATION_SETTINGS, retryBaseSeconds: 0 },
    { ...DEFAULT_BOT_AUTOMATION_SETTINGS, retryBaseSeconds: 3601 },
    { ...DEFAULT_BOT_AUTOMATION_SETTINGS, retryMaxSeconds: 20 },
    { ...DEFAULT_BOT_AUTOMATION_SETTINGS, retryMaxSeconds: 86401 },
    { ...DEFAULT_BOT_AUTOMATION_SETTINGS, source: { kind: 'url', id: 1 } },
    { ...DEFAULT_BOT_AUTOMATION_SETTINGS, source: { kind: 'radio', id: '1' } },
    { ...DEFAULT_BOT_AUTOMATION_SETTINGS, source: { kind: 'playlist', id: -1 } },
    { ...DEFAULT_BOT_AUTOMATION_SETTINGS, source: { kind: 'playlist', id: 1, url: 'ignored' } },
  ]) assert.throws(() => parseAutomationSettings(value), (error: any) => error.statusCode === 400);
  assert.equal(parseAutomationSettings({ ...DEFAULT_BOT_AUTOMATION_SETTINGS, quietPeriodSeconds: 0 }).quietPeriodSeconds, 0);
  assert.equal(parseAutomationSettings({ ...DEFAULT_BOT_AUTOMATION_SETTINGS, stayInChannel: true }).stayInChannel, true);
});
