import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_SQLITE_CONNECTION_LIMIT,
  isSqliteUrl,
  sqliteDatasourceUrl,
} from './sqlite-datasource.js';

describe('SQLite datasource URL', () => {
  it('defaults to the configured connection limit for a plain SQLite path', () => {
    const url = sqliteDatasourceUrl('file:./data/ts6webui.db');
    assert.equal(url, 'file:./data/ts6webui.db?connection_limit=2');
    assert.equal(DEFAULT_SQLITE_CONNECTION_LIMIT, 2);
  });

  it('preserves the database path exactly', () => {
    const url = sqliteDatasourceUrl('file:/var/lib/ts6/app.db');
    assert.ok(url.startsWith('file:/var/lib/ts6/app.db?'));
    assert.match(url, /connection_limit=2$/);
  });

  it('preserves unrelated query parameters', () => {
    const url = sqliteDatasourceUrl('file:./data/ts6webui.db?socket_timeout=20&cache=shared');
    const params = new URLSearchParams(url.slice(url.indexOf('?') + 1));
    assert.equal(params.get('socket_timeout'), '20');
    assert.equal(params.get('cache'), 'shared');
    assert.equal(params.get('connection_limit'), '2');
  });

  it('respects an explicitly configured connection limit', () => {
    const explicit = 'file:./data/ts6webui.db?connection_limit=5';
    assert.equal(sqliteDatasourceUrl(explicit), explicit);

    const explicitWithOthers = 'file:./data/ts6webui.db?socket_timeout=20&connection_limit=7&cache=shared';
    assert.equal(sqliteDatasourceUrl(explicitWithOthers), explicitWithOthers);
  });

  it('does not add a second query parameter separator', () => {
    const url = sqliteDatasourceUrl('file:./data/ts6webui.db?socket_timeout=20');
    assert.equal(url.split('?').length, 2);
    assert.ok(!url.includes('?&'));
  });

  it('leaves a non-SQLite URL unchanged', () => {
    const postgres = 'postgresql://user:pw@host:5432/db?schema=public';
    assert.equal(sqliteDatasourceUrl(postgres), postgres);
  });

  it('recognises SQLite URLs', () => {
    assert.equal(isSqliteUrl('file:./data/x.db'), true);
    assert.equal(isSqliteUrl(':memory:'), true);
    assert.equal(isSqliteUrl('postgresql://host/db'), false);
  });
});
