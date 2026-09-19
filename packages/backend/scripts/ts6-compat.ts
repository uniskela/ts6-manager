import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createWebQueryClient } from '../src/ts-client/webquery-client.js';

const tag = process.env.TS6_IMAGE_TAG || '6.0.0-beta13';
if (!/^[\w.-]+$/.test(tag)) throw new Error('Invalid image tag');
const key = randomBytes(32).toString('hex');
const name = `ts6-compat-${randomBytes(6).toString('hex')}`;
const docker = (args: string[]) => execFileSync('docker', args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, TSSERVER_QUERY_ADMIN_API_KEY: key },
}).trim();
let client: ReturnType<typeof createWebQueryClient> | undefined;
try {
  docker(['run', '-d', '--name', name, '-p', '127.0.0.1::10080',
    '-e', 'TSSERVER_LICENSE_ACCEPTED=accept', '-e', 'TSSERVER_QUERY_HTTP_ENABLED=1',
    '-e', 'TSSERVER_QUERY_HTTP_ALLOW_GUEST=0', '-e', 'TSSERVER_QUERY_SSH_ALLOW_GUEST=0',
    '-e', 'TSSERVER_QUERY_ADMIN_API_KEY', `teamspeaksystems/teamspeak6-server:${tag}`]);
  const port = Number(docker(['port', name, '10080/tcp']).split(':').pop());
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 120_000;
  let ready = false;
  while (Date.now() < deadline) {
    assert.equal(docker(['inspect', '--format', '{{.State.Running}}', name]), 'true', 'TeamSpeak exited during startup');
    try {
      const response = await fetch(`${origin}/1/serverinfo`, {
        headers: { 'x-api-key': key }, signal: AbortSignal.timeout(2000),
      });
      const body = await response.json() as any;
      if (response.ok && body.status?.code === 0 && body.body?.[0]?.virtualserver_status === 'online') {
        ready = true; break;
      }
    } catch { /* not ready */ }
    await delay(1000);
  }
  assert.ok(ready, 'Default virtual server did not become ready');
  const anonymous = await fetch(`${origin}/1/serverinfo`, { signal: AbortSignal.timeout(5000) });
  const anonymousBody = await anonymous.json() as any;
  assert.ok(!anonymous.ok || anonymousBody.status?.code !== 0, 'Guest WebQuery unexpectedly succeeded');
  client = createWebQueryClient('127.0.0.1', port, key);
  const version = await client.execute(0, 'version');
  assert.ok(version?.[0]?.version?.includes(tag), 'Unexpected TeamSpeak version');
  for (const command of ['serverinfo', 'clientlist', 'channellist', 'serverrequestconnectioninfo']) {
    // Pace the smoke probe below default Query flood thresholds. Readiness is still polled.
    await delay(2000);
    const result = await client.execute(1, command);
    assert.ok(Array.isArray(result) && result.length > 0, `${command} returned no data`);
    console.log(`PASS ${command}`);
  }
  // Also verify the channelinfo fields relied on by ownership cleanup.
  await delay(2000);
  const created = await client.executePost(1, 'channelcreate', {
    channel_name: 'Compatibility smoke',
    channel_description: 'Ownership marker', channel_flag_semi_permanent: 1, channel_flag_permanent: 0,
  });
  const cid = created[0].cid;
  await delay(2000);
  const info = (await client.execute(1, 'channelinfo', { cid }))[0];
  assert.equal(info.channel_name, 'Compatibility smoke');
  assert.equal(info.channel_description, 'Ownership marker');
  assert.equal(Number(info.channel_flag_semi_permanent), 1);
  assert.ok('pid' in info, 'channelinfo must return parent ID');
  await delay(2000);
  await client.executePost(1, 'channeldelete', { cid, force: 0 });
  console.log(`PASS authenticated WebQuery compatibility: teamspeaksystems/teamspeak6-server:${tag}`);
} catch (error) {
  console.error('Failure code:', typeof (error as any)?.code === 'number' ? (error as any).code : 'none');
  console.error(error instanceof Error && error.name === 'AssertionError' ? error.message : 'Query failed');
  // Do not print thrown HTTP/Docker objects or server logs: they may contain keys.
  console.error('TeamSpeak compatibility smoke failed (credentials and server logs withheld).');
  process.exitCode = 1;
} finally {
  client?.destroy();
  try { docker(['rm', '-f', '-v', name]); } catch { /* already removed */ }
}
