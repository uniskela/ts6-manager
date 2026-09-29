import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHostLines } from '../../src/lib/iptv-network';

test('host list parsing trims, lower-cases, dedupes and accepts commas or new lines', () => {
  assert.deepEqual(parseHostLines(' 192.168.1.20 \nThreadfin.LAN, 192.168.1.20\n\n10.0.0.0/24'), ['192.168.1.20', 'threadfin.lan', '10.0.0.0/24']);
  assert.deepEqual(parseHostLines('   \n , '), []);
});
