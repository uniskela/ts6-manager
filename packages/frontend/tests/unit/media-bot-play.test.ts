import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';

const store = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
  },
  configurable: true,
});

describe('media-bot-play', () => {
  let getLastPlayAction: typeof import('../../src/lib/media-bot-play').getLastPlayAction;
  let setLastPlayAction: typeof import('../../src/lib/media-bot-play').setLastPlayAction;
  let isMediaPlayAction: typeof import('../../src/lib/media-bot-play').isMediaPlayAction;

  before(async () => {
    const mod = await import('../../src/lib/media-bot-play');
    getLastPlayAction = mod.getLastPlayAction;
    setLastPlayAction = mod.setLastPlayAction;
    isMediaPlayAction = mod.isMediaPlayAction;
  });

  it('defaults to song and validates actions', () => {
    store.clear();
    assert.equal(getLastPlayAction(1), 'song');
    assert.equal(isMediaPlayAction('video'), true);
    assert.equal(isMediaPlayAction('cd'), false);
  });

  it('persists last play action per bot', () => {
    store.clear();
    setLastPlayAction(7, 'iptv');
    assert.equal(getLastPlayAction(7), 'iptv');
    assert.equal(getLastPlayAction(8), 'song');
  });
});
