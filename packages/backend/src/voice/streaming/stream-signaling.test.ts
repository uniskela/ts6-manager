import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { StreamSignaling } from './stream-signaling.js';

function joinRequest(clid: string) {
  return { name: 'notifyjoinstreamrequest', params: { clid, id: 'stream-2' } };
}

describe('stream signaling lifecycle', () => {
  it('dispose detaches from the client so a later stream handles each join once', () => {
    const client = new EventEmitter();
    const first = new StreamSignaling(client as any);
    const firstJoins: string[] = [];
    first.on('joinStreamRequest', (p: Record<string, string>) => firstJoins.push(p.clid));
    assert.equal(client.listenerCount('command'), 1);

    first.dispose();
    assert.equal(client.listenerCount('command'), 0);

    const second = new StreamSignaling(client as any);
    const secondJoins: string[] = [];
    second.on('joinStreamRequest', (p: Record<string, string>) => secondJoins.push(p.clid));
    client.emit('command', joinRequest('42'));

    assert.deepEqual(firstJoins, []);
    assert.deepEqual(secondJoins, ['42']);
    assert.equal(client.listenerCount('command'), 1);
  });
});
