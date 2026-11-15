import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DiscordHttpTransport } from './discord-delivery.js';
import { getSupportedSlashCommands, toDiscordCommandBody } from './slash-commands.js';
import {
  createSlashRegistrationClient,
  previewSlashRegistration,
  type RemoteGuildCommand,
} from './slash-registration.js';

const APP = '999000000000000001';
const GUILD = '111000000000000001';
const SECRET = 'super-secret-bot-token-DO-NOT-LEAK';

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
    dm_permission: false,
    ...overrides,
  };
}

describe('Discord slash registration client (Phase 2C step 3B.2)', () => {
  it('1. dry run performs no writes', async () => {
    const methods: string[] = [];
    const transport: DiscordHttpTransport = {
      async fetch(url, init) {
        methods.push(init?.method ?? 'GET');
        assert.match(url, /\/guilds\/111000000000000001\/commands$/);
        assert.doesNotMatch(url, /\/applications\/[^/]+\/commands$/); // no global
        return new Response(JSON.stringify([remoteFromLocal('queue')]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    };
    const client = createSlashRegistrationClient({
      applicationId: APP,
      authorization: `Bot ${SECRET}`,
      transport,
    });
    const plan = await client.dryRun(GUILD);
    assert.equal(plan.dryRun, true);
    assert.ok(plan.create.some((c) => c.name === 'play'));
    assert.ok(plan.unchanged.some((u) => u.local.name === 'queue'));
    assert.deepEqual(methods, ['GET']);
  });

  it('treats omitted remote options [] as equivalent to local empty options', () => {
    const local = getSupportedSlashCommands().find((c) => c.name === 'queue')!;
    const body = toDiscordCommandBody(local);
    assert.ok(!('options' in body) || !body.options || (body.options as unknown[]).length === 0);
    const { plan } = previewSlashRegistration({
      applicationId: APP,
      guildId: GUILD,
      remote: [{
        id: 'id-queue',
        name: 'queue',
        type: 1,
        description: String(body.description),
        // Discord often omits empty options rather than sending []
        default_member_permissions: null,
      }],
    });
    assert.ok(plan.unchanged.some((u) => u.local.name === 'queue'));
    assert.equal(plan.update.length, 0);
  });

  it('2–6. payloads valid; unchanged preserved; collisions reported; updates need apply; unrelated kept', async () => {
    const remote: RemoteGuildCommand[] = [
      remoteFromLocal('queue'),
      remoteFromLocal('play', { description: 'OLD DESCRIPTION' }),
      { id: 'other', name: 'custommod', type: 1, description: 'unrelated' },
      { id: 'bad', name: 'stop', type: 2, description: 'user command collision' },
    ];
    const { plan, text } = previewSlashRegistration({
      applicationId: APP,
      guildId: GUILD,
      remote,
    });
    assert.equal(plan.validationErrors.length, 0);
    assert.ok(plan.unchanged.some((u) => u.local.name === 'queue'));
    assert.ok(plan.update.some((u) => u.local.name === 'play'));
    assert.ok(plan.unrelated.some((u) => u.name === 'custommod'));
    assert.ok(plan.collisions.some((c) => c.remote.name === 'stop'));
    assert.match(text, /DRY RUN/);
    assert.match(text, /unrelated\(preserved\)=custommod/);

    let posts = 0;
    const transport: DiscordHttpTransport = {
      async fetch(url, init) {
        if ((init?.method ?? 'GET') === 'GET') {
          return new Response(JSON.stringify(remote), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        posts += 1;
        assert.equal(init?.method, 'POST');
        assert.match(url, /\/guilds\/.+\/commands$/);
        assert.doesNotMatch(url, /\/applications\/[^/]+\/commands$/);
        const body = JSON.parse(String(init?.body));
        assert.equal(body.name, 'play');
        assert.ok(!('dm_permission' in body));
        assert.ok(!('contexts' in body));
        return new Response(JSON.stringify({ id: 'new-play', ...body }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    };
    const client = createSlashRegistrationClient({
      applicationId: APP,
      authorization: `Bot ${SECRET}`,
      transport,
    });
    // Empty names → no writes even with confirmApply.
    const none = await client.apply(GUILD, { names: [], confirmApply: true, injectedRemote: remote });
    assert.equal(posts, 0);
    assert.equal(none.applied.length, 0);

    // Same-name update without explicit overwrite confirmation → refuse, no POST.
    await assert.rejects(
      () => client.apply(GUILD, {
        names: ['play'],
        confirmApply: true,
        injectedRemote: remote,
      }),
      /confirmSameNameOverwrite/,
    );
    assert.equal(posts, 0);

    const applied = await client.apply(GUILD, {
      names: ['play', 'stop', 'custommod', 'missing'],
      confirmApply: true,
      confirmSameNameOverwrite: true,
      injectedRemote: remote,
    });
    assert.equal(posts, 1);
    assert.deepEqual(applied.applied.map((a) => a.name), ['play']);
    assert.ok(applied.errors.some((e) => e.name === 'stop' && /collision/i.test(e.message)));
    assert.ok(applied.errors.some((e) => e.name === 'custommod' && /unknown|unsupported/i.test(e.message)));
    assert.ok(applied.errors.some((e) => e.name === 'missing' && /unknown|unsupported/i.test(e.message)));
    // Unrelated never DELETEd.
    assert.equal(posts, 1);
  });

  it('7. no global registration endpoint is called', async () => {
    const urls: string[] = [];
    const transport: DiscordHttpTransport = {
      async fetch(url, init) {
        urls.push(`${init?.method}:${url}`);
        if ((init?.method ?? 'GET') === 'GET') {
          return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response('{"id":"1","name":"queue"}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    };
    const client = createSlashRegistrationClient({
      applicationId: APP,
      authorization: `Bot ${SECRET}`,
      transport,
    });
    await client.apply(GUILD, { names: ['queue'], confirmApply: true, injectedRemote: [] });
    for (const u of urls) {
      assert.doesNotMatch(u, /applications\/\d+\/commands[^/]/);
      assert.match(u, /\/guilds\//);
    }
  });

  it('8–11. 400/401/429/network handled safely without leaking credentials', async () => {
    const diags: string[] = [];

    const client400 = createSlashRegistrationClient({
      applicationId: APP,
      authorization: `Bot ${SECRET}`,
      onDiagnostic: (m) => diags.push(m),
      transport: {
        async fetch(_url, init) {
          if ((init?.method ?? 'GET') === 'GET') {
            return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
          }
          return new Response(JSON.stringify({ message: `bad token=${SECRET}` }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          });
        },
      },
    });
    const bad = await client400.apply(GUILD, { names: ['queue'], confirmApply: true, injectedRemote: [] });
    assert.equal(bad.errors.length, 1);
    assert.doesNotMatch(bad.errors[0].message, new RegExp(SECRET));

    const client401 = createSlashRegistrationClient({
      applicationId: APP,
      authorization: `Bot ${SECRET}`,
      onDiagnostic: (m) => diags.push(m),
      transport: {
        async fetch() {
          return new Response('nope', { status: 401 });
        },
      },
    });
    await assert.rejects(
      () => client401.dryRun(GUILD),
      /unauthorized/i,
    );

    const client429 = createSlashRegistrationClient({
      applicationId: APP,
      authorization: `Bot ${SECRET}`,
      rateLimitWaitBudgetMs: 5_000,
      onDiagnostic: (m) => diags.push(m),
      transport: {
        async fetch() {
          return new Response(JSON.stringify({ retry_after: 9 }), {
            status: 429,
            headers: { 'retry-after': '9', 'content-type': 'application/json' },
          });
        },
      },
    });
    await assert.rejects(() => client429.dryRun(GUILD), /rate limited/i);

    let netHits = 0;
    const clientNet = createSlashRegistrationClient({
      applicationId: APP,
      authorization: `Bot ${SECRET}`,
      onDiagnostic: (m) => diags.push(m),
      transport: {
        async fetch() {
          netHits += 1;
          throw Object.assign(new Error('connect'), { code: 'ECONNREFUSED', discordUnsent: true });
        },
      },
    });
    await assert.rejects(() => clientNet.dryRun(GUILD), /network/i);
    assert.equal(netHits, 1);

    for (const line of diags) assert.doesNotMatch(line, new RegExp(SECRET));
  });

  it('12. credentials never appear in apply error messages', async () => {
    const client = createSlashRegistrationClient({
      applicationId: APP,
      authorization: `Bot ${SECRET}`,
      transport: {
        async fetch(_url, init) {
          if ((init?.method ?? 'GET') === 'GET') {
            return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
          }
          return new Response(JSON.stringify({ message: `Authorization Bot ${SECRET} invalid` }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          });
        },
      },
    });
    const result = await client.apply(GUILD, {
      names: ['queue'],
      confirmApply: true,
      injectedRemote: [],
    });
    assert.equal(result.errors.length, 1);
    assert.doesNotMatch(result.errors[0].message, new RegExp(SECRET));
  });

  it('13. backend startup performs no registration (module side-effect free)', async () => {
    let hits = 0;
    const transport: DiscordHttpTransport = {
      async fetch() {
        hits += 1;
        return new Response('[]', { status: 200 });
      },
    };
    createSlashRegistrationClient({
      applicationId: APP,
      authorization: `Bot ${SECRET}`,
      transport,
    });
    assert.equal(hits, 0);
    // Importing backend index path is heavy; assert config flag stays off.
    const { config } = await import('../config.js');
    assert.equal(config.discordInteractionsEnabled, false);
  });

  it('snowflake guild/application ids stay strings; invalid rejected', () => {
    assert.throws(
      () => createSlashRegistrationClient({
        applicationId: 'not-a-id',
        authorization: `Bot ${SECRET}`,
      }),
      /snowflake/i,
    );
    const client = createSlashRegistrationClient({
      applicationId: APP,
      authorization: `Bot ${SECRET}`,
      transport: { async fetch() { return new Response('[]', { status: 200 }); } },
    });
    assert.throws(() => client.planAgainst('nope', []), /snowflake/i);
  });

  it('fromPlan locks application/guild identity; create does not need overwrite confirm', async () => {
    let posts = 0;
    const transport: DiscordHttpTransport = {
      async fetch(_url, init) {
        if ((init?.method ?? 'GET') === 'GET') {
          return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
        }
        posts += 1;
        return new Response('{"id":"1","name":"queue"}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    };
    const client = createSlashRegistrationClient({
      applicationId: APP,
      authorization: `Bot ${SECRET}`,
      transport,
    });
    const plan = client.planAgainst(GUILD, []);
    await assert.rejects(
      () => client.apply(GUILD, {
        names: ['queue'],
        confirmApply: true,
        fromPlan: { ...plan, applicationId: '888000000000000001' },
        injectedRemote: [],
      }),
      /applicationId/,
    );
    await assert.rejects(
      () => client.apply(GUILD, {
        names: ['queue'],
        confirmApply: true,
        fromPlan: { ...plan, guildId: '222000000000000002' },
        injectedRemote: [],
      }),
      /guildId/,
    );
    assert.equal(posts, 0);

    // Fresh create (no remote same-name) — confirmSameNameOverwrite not required.
    const created = await client.apply(GUILD, {
      names: ['queue'],
      confirmApply: true,
      fromPlan: plan,
      injectedRemote: [],
    });
    assert.equal(posts, 1);
    assert.equal(created.applied[0]?.action, 'create');
  });

  it('registration never creates guild bindings; DELETE never issued', async () => {
    const methods: string[] = [];
    const transport: DiscordHttpTransport = {
      async fetch(_url, init) {
        methods.push(init?.method ?? 'GET');
        if ((init?.method ?? 'GET') === 'GET') {
          return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response('{"id":"1","name":"queue"}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    };
    const client = createSlashRegistrationClient({
      applicationId: APP,
      authorization: `Bot ${SECRET}`,
      transport,
    });
    await client.apply(GUILD, { names: ['queue'], confirmApply: true, injectedRemote: [] });
    assert.ok(methods.every((m) => m === 'GET' || m === 'POST'));
    assert.ok(!methods.includes('DELETE'));
    assert.ok(!methods.includes('PUT'));
  });
});
