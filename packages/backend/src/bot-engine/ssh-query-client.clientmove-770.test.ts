import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SshQueryClient } from './ssh-query-client.js';

test('clientmove TS error 770 resolves as success (already in channel)', async () => {
  const client = new SshQueryClient({
    id: 1,
    host: '127.0.0.1',
    sshPort: 10022,
    sshUsername: 'serveradmin',
    sshPassword: 'x',
  }) as any;

  let resolveReady!: () => void;
  const ready = new Promise<void>((r) => {
    resolveReady = r;
  });

  // Fake a connected shell that answers clientmove with 770.
  client.connected = true;
  client.bannerReceived = true;
  client.shell = {
    write: (line: string) => {
      assert.match(line, /^clientmove /);
      queueMicrotask(() => {
        client.onShellData(Buffer.from('error id=770 msg=already\\smember\\sof\\schannel\n'));
        resolveReady();
      });
    },
    close: () => {},
  };

  const resultPromise = client.executeCommand('clientmove clid=8 cid=1');
  await ready;
  await assert.doesNotReject(resultPromise);
});
