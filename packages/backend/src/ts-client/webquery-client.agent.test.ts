import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { WebQueryClient } from './webquery-client.js';
import { createValidatedTsServerEndpoint } from '../utils/validate-ts-host.js';
import { TeamSpeakUnavailableError, TSApiError } from '../middleware/error-handler.js';

describe('WebQueryClient keep-alive agent recreate', () => {
  function makeClient(): WebQueryClient {
    const endpoint = createValidatedTsServerEndpoint('127.0.0.1', 10080, false, 10080);
    return new WebQueryClient(endpoint, 'test-key');
  }

  it('recreates the keep-alive agent before retrying a transient network error', async () => {
    const client = makeClient();
    const firstAgent = (client as any).agent as { destroy: () => void };
    let destroyed = 0;
    const originalDestroy = firstAgent.destroy.bind(firstAgent);
    firstAgent.destroy = () => {
      destroyed += 1;
      originalDestroy();
    };

    let calls = 0;
    const result = await (client as any).withTransientRetry(async () => {
      calls += 1;
      if (calls === 1) {
        const err: any = new Error('connect ECONNREFUSED 172.20.0.2:10080');
        err.code = 'ECONNREFUSED';
        throw err;
      }
      return 'ok';
    });

    assert.equal(result, 'ok');
    assert.equal(calls, 2);
    assert.equal(destroyed, 1);
    assert.notEqual((client as any).agent, firstAgent);
    assert.equal((client as any).http.defaults.httpAgent, (client as any).agent);
    client.destroy();
  });

  it('does not recreate the agent for TeamSpeak API / flood errors', async () => {
    const client = makeClient();
    const firstAgent = (client as any).agent;
    let destroyed = 0;
    const originalDestroy = firstAgent.destroy.bind(firstAgent);
    firstAgent.destroy = () => {
      destroyed += 1;
      originalDestroy();
    };

    await assert.rejects(
      () => (client as any).withTransientRetry(async () => {
        throw new TSApiError(2568, 'insufficient client permissions');
      }),
      (err: unknown) => err instanceof TSApiError,
    );

    assert.equal(destroyed, 0);
    assert.equal((client as any).agent, firstAgent);
    client.destroy();
  });

  it('still maps a second transient failure to TeamSpeakUnavailableError after recreate', async () => {
    const client = makeClient();
    const firstAgent = (client as any).agent;

    await assert.rejects(
      () => (client as any).withTransientRetry(async () => {
        const err: any = new Error('read ECONNRESET');
        err.code = 'ECONNRESET';
        throw err;
      }),
      (err: unknown) => err instanceof TeamSpeakUnavailableError,
    );

    assert.notEqual((client as any).agent, firstAgent);
    client.destroy();
  });
});
