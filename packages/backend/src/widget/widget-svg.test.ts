import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { WidgetData } from '@ts6/common';
import { renderWidgetSvg } from './widget-svg.js';

const baseData: WidgetData = {
  serverName: 'Test Server',
  serverHost: 'example.com',
  serverPort: 9987,
  onlineUsers: 1,
  maxClients: 32,
  uptime: 3600,
  platform: 'TeamSpeak',
  version: '',
  theme: 'dark',
  showChannelTree: false,
  showClients: false,
  channelTree: [],
  fetchedAt: new Date().toISOString(),
};

describe('renderWidgetSvg', () => {
  it('brands the footer as ts6-manager with a GitHub link', () => {
    const svg = renderWidgetSvg(baseData);
    assert.match(svg, /ts6-manager/);
    assert.doesNotMatch(svg, /TS6 WebUI Widget/);
    assert.match(svg, /href="https:\/\/github\.com\/uniskela\/ts6-manager"/);
    assert.match(svg, /target="_blank"/);
    assert.match(svg, /rel="noopener noreferrer"/);
  });
});
