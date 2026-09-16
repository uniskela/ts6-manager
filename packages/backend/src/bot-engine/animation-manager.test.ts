import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AnimationManager, type AnimationConfig } from './animation-manager.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('AnimationManager WebQuery client refresh', () => {
  it('resolves the current WebQuery client for each animation tick', async () => {
    let firstCalls = 0;
    let secondCalls = 0;

    const firstClient = {
      executePost: async () => {
        firstCalls++;
        return {};
      },
    };
    const secondClient = {
      executePost: async () => {
        secondCalls++;
        return {};
      },
    };

    let currentClient = firstClient;
    const getClient = () => currentClient;
    const manager = new AnimationManager();
    const config: AnimationConfig = {
      channelId: '1',
      text: 'Server Stats',
      style: 'wave',
      intervalSeconds: 0.01,
      prefix: '',
    };

    try {
      manager.startAnimation(99, 1, config, getClient as any);
      await sleep(50);
      assert.equal(firstCalls, 1, 'the immediate tick should use the initial client');

      currentClient = secondClient;
      await sleep(2_100);
      assert.equal(secondCalls, 1, 'the next tick should use the refreshed client');
    } finally {
      manager.stopAnimation(99);
    }
  });
});
