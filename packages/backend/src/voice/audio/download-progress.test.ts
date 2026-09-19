import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DownloadJobs, parseDownloadProgress } from './download-progress.js';

test('structured progress rejects noise and handles unknown totals and postprocessing', () => {
  assert.equal(parseDownloadProgress('some private URL'), null);
  assert.equal(parseDownloadProgress('ts6-progress:bad'), null);
  assert.equal(parseDownloadProgress('ts6-progress:null'), null);
  assert.deepEqual(parseDownloadProgress('ts6-progress:{"downloaded_bytes":50,"total_bytes":100,"speed":12,"eta":4}'),
    { status: 'downloading', percentage: 50, speed: 12, eta: 4 });
  assert.equal(parseDownloadProgress('ts6-progress:{"downloaded_bytes":5}')?.percentage, null);
  assert.equal(parseDownloadProgress('ts6-progress:{"status":"finished"}')?.status, 'processing');
  assert.equal(parseDownloadProgress('ts6-processing')?.status, 'processing');
});

test('jobs enforce owner/server, size, expiry and cancellation', () => {
  let now = 0;
  const jobs = new DownloadJobs(1, 100, () => now);
  const job = jobs.create(1, 2, 1);
  assert.match(job.id, /^[a-f0-9-]{36}$/);
  assert.equal(jobs.get(job.id, 2, 2), null);
  assert.equal(jobs.get(job.id, 1, 3), null);
  assert.ok(jobs.get(job.id, 1, 2));
  assert.throws(() => jobs.create(1, 2, 1), /capacity/);
  now = 101;
  jobs.sweep();
  assert.equal(jobs.get(job.id, 1, 2), null);
  assert.ok(job.controller.signal.aborted);
  assert.throws(() => jobs.create(1, 2, 251), /1–250/);
  jobs.create(1, 2, 1);
});

test('single and batch progress, completion, bounded errors and terminal state', async () => {
  const jobs = new DownloadJobs();
  for (const urls of [['one'], ['one', 'two']]) {
    const job = jobs.create(1, 1, urls.length);
    const seen: number[] = [];
    await jobs.run(job, urls, async (url, progress) => {
      seen.push(job.currentItem);
      progress({ status: 'processing', percentage: 100, eta: null, speed: null });
      if (url === 'two') throw new Error('sensitive subprocess detail');
      return { id: 1 };
    });
    assert.deepEqual(seen, urls.map((_, i) => i + 1));
    const result = jobs.get(job.id, 1, 1)!;
    assert.equal(result.status, urls.length === 1 ? 'done' : 'error');
    assert.equal(result.downloaded, 1);
    assert.ok(!JSON.stringify(result).includes('sensitive'));
    jobs.update(job, { status: 'downloading' });
    assert.equal(jobs.get(job.id, 1, 1)?.status, result.status);
  }
});

test('finished jobs expire and heartbeats cannot extend the absolute job deadline', async () => {
  let now = 0;
  const jobs = new DownloadJobs(100, 100, () => now, 200);
  const done = jobs.create(1, 1, 1);
  await jobs.run(done, ['one'], async () => ({ id: 1 }));
  now = 101;
  assert.equal(jobs.get(done.id, 1, 1), null);
  const active = jobs.create(1, 1, 1);
  const run = jobs.run(active, ['one'], (_url, _update, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  }));
  now = 190; jobs.update(active, { percentage: 20 });
  now = 280; jobs.update(active, { percentage: 30 });
  now = 302; jobs.sweep();
  await run;
  assert.equal(jobs.get(active.id, 1, 1), null);
  assert.equal(active.results.length, 0);
});
