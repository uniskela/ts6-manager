/**
 * CLI regression for guild slash registration preview/apply.
 * Uses injected Discord HTTP transport — never contacts Discord.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DiscordHttpTransport } from './discord-delivery.js';
import { getSupportedSlashCommands, toDiscordCommandBody } from './slash-commands.js';
import { runSlashRegisterCli } from './slash-register-cli.js';
import type { RemoteGuildCommand } from './slash-registration.js';

const APP = '999000000000000001';
const GUILD = '111000000000000001';
const SECRET = 'cli-secret-bot-token-DO-NOT-LEAK';

function remoteFromLocal(name: string, overrides: Partial<RemoteGuildCommand> = {}): RemoteGuildCommand {
  const local = getSupportedSlashCommands().find((c) => c.name === name)!;
  const body = toDiscordCommandBody(local);
  return {
    id: `id-${name}`,
    name: local.name,
    type: 1,
    description: String(body.description),
    options: (body.options as unknown[]) ?? [],
    default_member_permissions: null,
    ...overrides,
  };
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    log: (line: string) => out.push(line),
    error: (line: string) => err.push(line),
    text: () => [...out, ...err].join('\n'),
  };
}

describe('slash-register-cli', () => {
  it('1. preview performs no writes', async () => {
    const methods: string[] = [];
    const transport: DiscordHttpTransport = {
      async fetch(url, init) {
        methods.push(`${init?.method ?? 'GET'}:${url}`);
        return new Response(JSON.stringify([remoteFromLocal('queue')]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    };
    const cap = capture();
    const code = await runSlashRegisterCli(
      ['preview', '--application-id', APP, '--guild-id', GUILD, '--fetch-remote'],
      { env: { DISCORD_BOT_TOKEN: SECRET }, transport, log: cap.log, error: cap.error },
    );
    assert.equal(code, 0);
    assert.ok(methods.every((m) => m.startsWith('GET:')));
    assert.ok(!methods.some((m) => m.startsWith('POST:') || m.startsWith('PUT:') || m.startsWith('DELETE:')));
    assert.match(cap.text(), /DRY RUN/);
  });

  it('2. apply without --confirm-apply refuses', async () => {
    let hits = 0;
    const transport: DiscordHttpTransport = {
      async fetch() {
        hits += 1;
        return new Response('[]', { status: 200 });
      },
    };
    const cap = capture();
    const code = await runSlashRegisterCli(
      ['apply', '--application-id', APP, '--guild-id', GUILD, '--names', 'queue'],
      { env: { DISCORD_BOT_TOKEN: SECRET }, transport, log: cap.log, error: cap.error },
    );
    assert.equal(code, 2);
    assert.equal(hits, 0);
    assert.match(cap.text(), /confirm-apply/i);
  });

  it('3. apply without --names refuses (never means all)', async () => {
    let hits = 0;
    const transport: DiscordHttpTransport = {
      async fetch() {
        hits += 1;
        return new Response('[]', { status: 200 });
      },
    };
    const cap = capture();
    const code = await runSlashRegisterCli(
      ['apply', '--application-id', APP, '--guild-id', GUILD, '--confirm-apply'],
      { env: { DISCORD_BOT_TOKEN: SECRET }, transport, log: cap.log, error: cap.error },
    );
    assert.equal(code, 2);
    assert.equal(hits, 0);
    assert.match(cap.text(), /--names/);
  });

  it('4. unknown names refuse before HTTP', async () => {
    let hits = 0;
    const transport: DiscordHttpTransport = {
      async fetch() {
        hits += 1;
        return new Response('[]', { status: 200 });
      },
    };
    const cap = capture();
    const code = await runSlashRegisterCli(
      ['apply', '--application-id', APP, '--guild-id', GUILD, '--names', 'not-a-command', '--confirm-apply'],
      { env: { DISCORD_BOT_TOKEN: SECRET }, transport, log: cap.log, error: cap.error },
    );
    assert.equal(code, 2);
    assert.equal(hits, 0);
    assert.match(cap.text(), /unknown|unsupported/i);
  });

  it('5. approved new commands are registered via guild POST only', async () => {
    const urls: string[] = [];
    const transport: DiscordHttpTransport = {
      async fetch(url, init) {
        urls.push(`${init?.method ?? 'GET'}:${url}`);
        if ((init?.method ?? 'GET') === 'GET') {
          return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
        }
        assert.equal(init?.method, 'POST');
        const body = JSON.parse(String(init?.body));
        assert.equal(body.name, 'queue');
        return new Response(JSON.stringify({ id: 'new-queue', ...body }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    };
    const cap = capture();
    const code = await runSlashRegisterCli(
      ['apply', '--application-id', APP, '--guild-id', GUILD, '--names', 'queue', '--confirm-apply'],
      { env: { DISCORD_BOT_TOKEN: SECRET }, transport, log: cap.log, error: cap.error },
    );
    assert.equal(code, 0);
    assert.ok(urls.some((u) => u.startsWith('GET:') && u.includes('/guilds/')));
    assert.ok(urls.some((u) => u.startsWith('POST:') && u.includes('/guilds/') && u.includes('/commands')));
    assert.ok(!urls.some((u) => /applications\/\d+\/commands[^/]/.test(u) && !u.includes('/guilds/')));
    assert.ok(!urls.some((u) => u.startsWith('PUT:') || u.startsWith('DELETE:')));
    assert.match(cap.text(), /created=queue/);
  });

  it('6. same-name updates require --confirm-same-name-overwrite', async () => {
    const remote = [remoteFromLocal('play', { description: 'OLD' })];
    let posts = 0;
    const transport: DiscordHttpTransport = {
      async fetch(_url, init) {
        if ((init?.method ?? 'GET') === 'GET') {
          return new Response(JSON.stringify(remote), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        posts += 1;
        return new Response('{"id":"1","name":"play"}', { status: 200 });
      },
    };
    const cap = capture();
    const refused = await runSlashRegisterCli(
      ['apply', '--application-id', APP, '--guild-id', GUILD, '--names', 'play', '--confirm-apply'],
      { env: { DISCORD_BOT_TOKEN: SECRET }, transport, log: cap.log, error: cap.error },
    );
    assert.equal(refused, 1);
    assert.equal(posts, 0);
    assert.match(cap.text(), /confirmSameNameOverwrite|same-name/i);

    const cap2 = capture();
    const ok = await runSlashRegisterCli(
      [
        'apply', '--application-id', APP, '--guild-id', GUILD, '--names', 'play',
        '--confirm-apply', '--confirm-same-name-overwrite',
      ],
      { env: { DISCORD_BOT_TOKEN: SECRET }, transport, log: cap2.log, error: cap2.error },
    );
    assert.equal(ok, 0);
    assert.equal(posts, 1);
    assert.match(cap2.text(), /updated=play/);
  });

  it('7–9. collisions refused; unrelated preserved; no bulk PUT/DELETE/global', async () => {
    const remote: RemoteGuildCommand[] = [
      remoteFromLocal('queue'),
      { id: 'other', name: 'custommod', type: 1, description: 'unrelated' },
      { id: 'bad', name: 'stop', type: 2, description: 'collision' },
    ];
    const methods: string[] = [];
    const transport: DiscordHttpTransport = {
      async fetch(url, init) {
        methods.push(`${init?.method ?? 'GET'}:${url}`);
        if ((init?.method ?? 'GET') === 'GET') {
          return new Response(JSON.stringify(remote), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('{"id":"1","name":"play"}', { status: 200 });
      },
    };
    const cap = capture();
    const code = await runSlashRegisterCli(
      [
        'apply', '--application-id', APP, '--guild-id', GUILD,
        '--names', 'stop,play', '--confirm-apply', '--confirm-same-name-overwrite',
      ],
      { env: { DISCORD_BOT_TOKEN: SECRET }, transport, log: cap.log, error: cap.error },
    );
    assert.equal(code, 1);
    assert.match(cap.text(), /stop:.*collision/i);
    assert.match(cap.text(), /created=play|PARTIAL|errors=/);
    assert.ok(methods.every((m) => m.includes('/guilds/')));
    assert.ok(!methods.some((m) => m.startsWith('PUT:') || m.startsWith('DELETE:')));
    // Unrelated custommod never targeted.
    assert.ok(!methods.some((m) => m.startsWith('POST:') && m.includes('custommod')));
  });

  it('10. apply rechecks remote with GET immediately before writes', async () => {
    const order: string[] = [];
    const transport: DiscordHttpTransport = {
      async fetch(_url, init) {
        order.push(init?.method ?? 'GET');
        if ((init?.method ?? 'GET') === 'GET') {
          return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response('{"id":"1","name":"queue"}', { status: 200 });
      },
    };
    const code = await runSlashRegisterCli(
      ['apply', '--application-id', APP, '--guild-id', GUILD, '--names', 'queue', '--confirm-apply'],
      { env: { DISCORD_BOT_TOKEN: SECRET }, transport, log() {}, error() {} },
    );
    assert.equal(code, 0);
    assert.deepEqual(order[0], 'GET');
    assert.ok(order.includes('POST'));
    assert.ok(order.indexOf('GET') < order.indexOf('POST'));
  });

  it('11. 401 / 429 / timeout / 5xx handled without leaking tokens', async () => {
    const cases: Array<{ status?: number; throwNet?: boolean; match: RegExp }> = [
      { status: 401, match: /unauthorized/i },
      { status: 403, match: /unauthorized/i },
      { status: 429, match: /rate limited/i },
      { status: 500, match: /rejected|HTTP 500|registration/i },
      { throwNet: true, match: /network/i },
    ];
    for (const c of cases) {
      const cap = capture();
      const transport: DiscordHttpTransport = {
        async fetch() {
          if (c.throwNet) {
            throw Object.assign(new Error(`fail ${SECRET}`), { code: 'ETIMEDOUT', discordUnsent: true });
          }
          if (c.status === 429) {
            return new Response(JSON.stringify({ retry_after: 9, message: SECRET }), {
              status: 429,
              headers: { 'retry-after': '9' },
            });
          }
          return new Response(JSON.stringify({ message: `token=${SECRET}` }), { status: c.status ?? 500 });
        },
      };
      const code = await runSlashRegisterCli(
        ['apply', '--application-id', APP, '--guild-id', GUILD, '--names', 'queue', '--confirm-apply'],
        {
          env: { DISCORD_BOT_TOKEN: SECRET },
          transport,
          log: cap.log,
          error: cap.error,
          rateLimitWaitBudgetMs: 1_000,
        },
      );
      // For 429 on GET during apply dryRun, client uses default budget — may throw rate limited.
      assert.ok(code !== 0, `expected failure for ${c.status ?? 'net'}`);
      assert.match(cap.text(), c.match);
      assert.doesNotMatch(cap.text(), new RegExp(SECRET));
    }
  });

  it('12. partial success reports writes and exits nonzero', async () => {
    let postCount = 0;
    const transport: DiscordHttpTransport = {
      async fetch(_url, init) {
        if ((init?.method ?? 'GET') === 'GET') {
          return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
        }
        postCount += 1;
        if (postCount === 1) {
          return new Response('{"id":"1","name":"queue"}', { status: 200 });
        }
        return new Response(JSON.stringify({ message: 'boom' }), { status: 500 });
      },
    };
    const cap = capture();
    const code = await runSlashRegisterCli(
      ['apply', '--application-id', APP, '--guild-id', GUILD, '--names', 'queue,play', '--confirm-apply'],
      { env: { DISCORD_BOT_TOKEN: SECRET }, transport, log: cap.log, error: cap.error },
    );
    assert.equal(code, 1);
    assert.equal(postCount, 2);
    assert.match(cap.text(), /created=queue|PARTIAL/);
    assert.match(cap.text(), /play:/);
  });

  it('13. token never appears in argv path or diagnostics; env-only', async () => {
    const cap = capture();
    const code = await runSlashRegisterCli(
      ['apply', '--application-id', APP, '--guild-id', GUILD, '--names', 'queue', '--confirm-apply', SECRET],
      { env: {}, transport: { async fetch() { return new Response('[]', { status: 200 }); } }, log: cap.log, error: cap.error },
    );
    assert.equal(code, 2);
    assert.match(cap.text(), /DISCORD_BOT_TOKEN/);
    assert.doesNotMatch(cap.text(), new RegExp(SECRET));
  });

  it('14. re-running completed registration is idempotent (skipped, no POST)', async () => {
    const remote = [remoteFromLocal('queue')];
    let posts = 0;
    const transport: DiscordHttpTransport = {
      async fetch(_url, init) {
        if ((init?.method ?? 'GET') === 'GET') {
          return new Response(JSON.stringify(remote), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        posts += 1;
        return new Response('{"id":"1","name":"queue"}', { status: 200 });
      },
    };
    const cap = capture();
    const code = await runSlashRegisterCli(
      ['apply', '--application-id', APP, '--guild-id', GUILD, '--names', 'queue', '--confirm-apply'],
      { env: { DISCORD_BOT_TOKEN: SECRET }, transport, log: cap.log, error: cap.error },
    );
    assert.equal(code, 0);
    assert.equal(posts, 0);
    assert.match(cap.text(), /unchangedOrSkipped=queue|nothing to write/i);
  });

  it('default argv without action stays preview-compatible', async () => {
    const cap = capture();
    const code = await runSlashRegisterCli(
      ['--application-id', APP, '--guild-id', GUILD],
      { log: cap.log, error: cap.error },
    );
    assert.equal(code, 0);
    assert.match(cap.text(), /DRY RUN/);
  });
});
