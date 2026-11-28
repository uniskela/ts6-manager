import assert from "node:assert/strict";
import { it } from "node:test";
import { FrameFeed } from "./frame-feed.js";

it("counts drained reads after finish and excludes oldest-drop and destroyed-stream cleanup reads", async (t) => {
  let now = 100;
  t.mock.method(Date, "now", () => now);

  const feed = new FrameFeed(3);
  assert.equal(feed.read(), null);
  for (let n = 1; n <= 6; n++) feed.offer(Buffer.from([n]));
  assert.equal(feed.queued, 3);
  assert.equal(feed.dropped, 3);
  assert.equal(feed.starved, 0);
  assert.equal(feed.consumed.frames, 0);
  feed.finish();
  const read: number[] = [];
  for await (const b of feed) read.push(b[0]);
  assert.deepEqual(read, [4, 5, 6]);
  assert.equal(feed.consumed.frames, 3);
  assert.equal(feed.dropped, 3);
  assert.equal(feed.starved, 0);

  const stopped = new FrameFeed();
  stopped.read();
  stopped.offer(Buffer.from([1]));
  stopped.destroy();
  stopped.read();
  assert.equal(stopped.consumed.frames, 0);

  const dry = new FrameFeed();
  dry.offer(Buffer.from([1]));
  assert.ok(dry.read());
  now += 41;
  dry._read();
  assert.equal(dry.consumed.frames, 1);
  assert.equal(dry.dropped, 0);
  assert.equal(dry.starved, 1);
  dry.destroy();
});
