import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatFatalSshFailureMessage } from './ssh-query-client.js';

describe('EventBridge executeCommand fatal reconnect path', () => {
  it('surfaces fatal auth from a zombie client left after mid-session reconnect', async () => {
    const { EventBridge } = await import('./event-bridge.js');
    const prisma = {
      tsServerConfig: {
        findUnique: async () => ({
          sshUsername: 'serveradmin',
          sshPassword: 'encrypted',
          sshPort: 10022,
        }),
      },
    };
    const bridge = new EventBridge(prisma as any) as any;

    // Simulate a client that failed auth during SshQueryClient.scheduleReconnect —
    // still in connections, disconnected, fatal, and never recorded in fatalSshFailures.
    bridge.connections.set('1:1', {
      isConnected: false,
      hasFatalError: true,
      lastFatalError: 'All configured authentication methods failed',
      destroy: async () => {},
      executeCommand: async () => {
        throw new Error('should not run');
      },
    });

    let connectCalls = 0;
    bridge.connectServer = async () => {
      connectCalls += 1;
      // Fresh attempt also fails permanently (bad credentials still configured).
      bridge.fatalSshFailures.set('1:1', 'All configured authentication methods failed');
    };

    await assert.rejects(
      () => bridge.executeCommand(1, 1, 'ftgetfilelist cid=1 cpw= path=/'),
      (err: Error) => {
        assert.match(err.message, /^SSH authentication failed:/);
        assert.equal(
          err.message,
          formatFatalSshFailureMessage('All configured authentication methods failed'),
        );
        return true;
      },
    );
    assert.equal(connectCalls, 1, 'zombie fatal client must be dropped so connect can retry');
    assert.equal(bridge.connections.has('1:1'), false);
  });

  it('maps temporary disconnect without fatal flag to SSH not connected', async () => {
    const { EventBridge } = await import('./event-bridge.js');
    const prisma = {
      tsServerConfig: {
        findUnique: async () => ({
          sshUsername: 'serveradmin',
          sshPassword: 'encrypted',
          sshPort: 10022,
        }),
      },
    };
    const bridge = new EventBridge(prisma as any) as any;
    bridge.connectServer = async () => {
      // Flood / reconnect pause: no client yet.
    };

    await assert.rejects(
      () => bridge.executeCommand(1, 1, 'whoami'),
      (err: Error) => {
        assert.equal(err.message, 'SSH not connected');
        return true;
      },
    );
  });
});
