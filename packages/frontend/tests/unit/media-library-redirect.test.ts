import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isMediaLibraryTab, mediaLibraryRedirect } from '../../src/lib/media-library-redirect';

const redirect = (search: string) => mediaLibraryRedirect(new URLSearchParams(search));

/** The spec's redirect table: every old Media Bots link lands on its 1.10.0 page. */
describe('Media Library redirects', () => {
  it('sends the old Bots tab to the Bot Hub', () => {
    assert.equal(redirect('tab=bots'), '/bot-hub');
    assert.equal(redirect('tab=bots&bot=4'), '/bot-hub');
  });

  it('sends Queue and Video with a bot to that bot\'s console', () => {
    assert.equal(redirect('tab=queue&bot=3'), '/bot-hub/3');
    assert.equal(redirect('tab=video&bot=12&server=1'), '/bot-hub/12');
  });

  it('sends Queue without a bot to the Bot Hub and Video to Streaming defaults', () => {
    assert.equal(redirect('tab=queue'), '/bot-hub');
    assert.equal(redirect('tab=video'), '/media-bots?tab=streaming');
  });

  it('ignores a malformed bot id', () => {
    for (const bot of ['0', '-2', 'abc', '1.5', '']) {
      assert.equal(redirect(`tab=queue&bot=${bot}`), '/bot-hub', bot);
      assert.equal(redirect(`tab=video&bot=${bot}`), '/media-bots?tab=streaming', bot);
    }
  });

  it('sends Commands to Bot Flows → Chat commands', () => {
    assert.equal(redirect('tab=commands'), '/bots?tab=commands');
  });

  it('leaves Media Library tabs and unknown tabs where they are', () => {
    for (const search of ['', 'tab=library', 'tab=playlists', 'tab=radio&server=1', 'tab=requests', 'tab=streaming', 'tab=nope']) {
      assert.equal(redirect(search), null, search);
    }
  });

  it('knows the five Media Library tabs', () => {
    for (const tab of ['library', 'playlists', 'radio', 'requests', 'streaming']) assert.equal(isMediaLibraryTab(tab), true, tab);
    for (const tab of [null, 'bots', 'queue', 'video', 'commands']) assert.equal(isMediaLibraryTab(tab), false, String(tab));
  });
});
