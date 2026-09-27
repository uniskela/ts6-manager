import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyPacketLoss, classifyPing } from '../../src/lib/connection-health.ts';

describe('classifyPing', () => {
  it('bands server ping into normal, elevated, and high', () => {
    assert.equal(classifyPing(24.6), 'normal');
    assert.equal(classifyPing(99.9), 'normal');
    assert.equal(classifyPing(100), 'elevated');
    assert.equal(classifyPing(199.9), 'elevated');
    assert.equal(classifyPing(200), 'high');
  });

  it('treats missing or invalid values as normal rather than alarming', () => {
    assert.equal(classifyPing(Number.NaN), 'normal');
    assert.equal(classifyPing(Number.POSITIVE_INFINITY), 'normal');
  });
});

describe('classifyPacketLoss', () => {
  it('interprets the TeamSpeak 0–1 ratio, not a percentage', () => {
    assert.equal(classifyPacketLoss(0), 'normal');
    assert.equal(classifyPacketLoss(0.0099), 'normal');
    assert.equal(classifyPacketLoss(0.01), 'elevated');
    assert.equal(classifyPacketLoss(0.049), 'elevated');
    assert.equal(classifyPacketLoss(0.05), 'high');
    assert.equal(classifyPacketLoss(0.18), 'high');
  });
});
