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

  it('reports a refused setupstream by its return_code', () => {
    const client = new EventEmitter();
    const sent: string[] = [];
    (client as any).sendCommand = (cmd: string) => sent.push(cmd);
    const signaling = new StreamSignaling(client as any);
    const refusals: Array<{ id: number; msg: string }> = [];
    signaling.on('setupRefused', (r: { id: number; msg: string }) => refusals.push(r));

    signaling.sendSetupStream({ name: 'Bot Stream' });
    const code = /return_code=(\S+)/.exec(sent[0])?.[1];
    assert.ok(code, 'setupstream carries a return_code');

    // A reply to some other command is not ours.
    client.emit('command', { name: 'error', params: { id: '524', msg: 'client is flooding', return_code: 'other' } });
    assert.equal(refusals.length, 0);

    client.emit('command', { name: 'error', params: { id: '524', msg: 'client is flooding', return_code: code } });
    assert.deepEqual(refusals, [{ id: 524, msg: 'client is flooding' }]);
  });

  it('treats an ok reply to setupstream as no refusal', () => {
    const client = new EventEmitter();
    const sent: string[] = [];
    (client as any).sendCommand = (cmd: string) => sent.push(cmd);
    const signaling = new StreamSignaling(client as any);
    let refused = 0;
    signaling.on('setupRefused', () => { refused++; });
    signaling.sendSetupStream();
    const code = /return_code=(\S+)/.exec(sent[0])?.[1];
    client.emit('command', { name: 'error', params: { id: '0', msg: 'ok', return_code: code } });
    assert.equal(refused, 0);
  });
});
