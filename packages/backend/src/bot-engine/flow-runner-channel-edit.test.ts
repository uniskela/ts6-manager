import assert from 'node:assert/strict';
import { test } from 'node:test';

/**
 * After waitAndMark, FlowRunner must recheck EventBridge readiness before channeledit.
 */
test('executeChannelEdit skips dispatch when readiness fails after pace wait', async () => {
  const { FlowRunner } = await import('./flow-runner.js');
  const { webQueryChannelEditPacer } = await import('./channel-edit-pacer.js');

  webQueryChannelEditPacer.reset();

  const posts: string[] = [];
  const client = {
    executePost: async (_sid: number, command: string) => {
      posts.push(command);
      return [{ ok: 1 }];
    },
  };

  const runner = new FlowRunner({} as any, {} as any, { clients: new Set() } as any) as any;
  let ready = true;
  runner.setChannelEditReadyCheck(() => ready);

  const ctx = {
    configId: 1,
    sid: 1,
    resolveTemplate: async (v: string) => v,
  };

  await runner.executeChannelEdit(
    { channelId: '10', params: { channel_name: 'A' } },
    ctx,
    client,
  );
  assert.deepEqual(posts, ['channeledit']);

  // Flip readiness during a held waitAndMark — proves the post-wait recheck.
  let releaseWait!: () => void;
  const waitHeld = new Promise<void>((resolve) => {
    releaseWait = resolve;
  });
  let signalWaitEntered!: () => void;
  const waitEntered = new Promise<void>((resolve) => {
    signalWaitEntered = resolve;
  });
  const originalWaitAndMark = webQueryChannelEditPacer.waitAndMark;
  webQueryChannelEditPacer.waitAndMark = async () => {
    signalWaitEntered();
    await waitHeld;
    webQueryChannelEditPacer.mark();
  };

  try {
    ready = true;
    const pending = runner.executeChannelEdit(
      { channelId: '10', params: { channel_name: 'B' } },
      ctx,
      client,
    );
    await waitEntered;
    ready = false;
    releaseWait();
    await pending;
    assert.deepEqual(posts, ['channeledit']);
  } finally {
    webQueryChannelEditPacer.waitAndMark = originalWaitAndMark;
    webQueryChannelEditPacer.reset();
  }
});
