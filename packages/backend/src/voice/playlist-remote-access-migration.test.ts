import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { test } from 'node:test';

// Exercise the SQL upgrade against a real SQLite table with an existing playlist.
// The repository uses db push at container start; this also validates the
// explicit migration artifact for installations that manage SQL upgrades.
test('playlist remoteAccess migration defaults existing rows to hidden', () => {
  const directory = new URL('../../prisma/migrations/', import.meta.url);
  const entry = fs.readdirSync(directory).find((name) => name.includes('playlist_remote_access'));
  assert.ok(entry, 'an explicit Playlist.remoteAccess migration must be shipped');
  const sql = fs.readFileSync(new URL(`${entry}/migration.sql`, directory), 'utf8');
  const result = execFileSync('python3', ['-c', `
import sqlite3, json, sys
connection = sqlite3.connect(':memory:')
connection.execute('CREATE TABLE "Playlist" ("id" INTEGER PRIMARY KEY, "name" TEXT NOT NULL)')
connection.execute('INSERT INTO "Playlist" ("id", "name") VALUES (7, "Existing playlist")')
connection.executescript(sys.stdin.read())
print(json.dumps(connection.execute('SELECT "id", "name", "remoteAccess" FROM "Playlist"').fetchone()))
connection.execute('INSERT INTO "Playlist" ("id", "name") VALUES (8, "Another playlist")')
print(json.dumps(connection.execute('SELECT "remoteAccess" FROM "Playlist" WHERE "id" = 8').fetchone()))
`], { input: sql, encoding: 'utf8' }).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(result, [[7, 'Existing playlist', 'hidden'], ['hidden']]);
});
