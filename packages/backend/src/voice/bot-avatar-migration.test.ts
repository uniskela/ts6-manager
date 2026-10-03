import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { test } from 'node:test';

// Exercise the SQL upgrade against a real SQLite table with an existing bot.
// The repository uses db push at container start; this also validates the
// explicit migration artifact for installations that manage SQL upgrades.
test('avatar migration preserves existing bots with None and nullable image metadata', () => {
  const directory = new URL('../../prisma/migrations/', import.meta.url);
  const entry = fs.readdirSync(directory).find((name) => name.includes('bot_avatars'));
  assert.ok(entry, 'an explicit MusicBot avatar migration must be shipped');
  const sql = fs.readFileSync(new URL(`${entry}/migration.sql`, directory), 'utf8');
  const result = execFileSync('python3', ['-c', `
import sqlite3, json, sys
connection = sqlite3.connect(':memory:')
connection.execute('CREATE TABLE "MusicBot" ("id" INTEGER PRIMARY KEY, "name" TEXT NOT NULL)')
connection.execute('INSERT INTO "MusicBot" ("id", "name") VALUES (7, "Existing bot")')
connection.executescript(sys.stdin.read())
print(json.dumps(connection.execute('SELECT "id", "name", "avatarMode", "avatarFile", "avatarMd5" FROM "MusicBot"').fetchone()))
connection.execute('INSERT INTO "MusicBot" ("id", "name") VALUES (8, "Another bot")')
print(json.dumps(connection.execute('SELECT "avatarMode", "avatarFile", "avatarMd5" FROM "MusicBot" WHERE "id" = 8').fetchone()))
`], { input: sql, encoding: 'utf8' }).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(result, [[7, 'Existing bot', 'none', null, null], ['none', null, null]]);
});
