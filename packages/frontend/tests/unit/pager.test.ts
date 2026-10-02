import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { clampPage, pageCount, pageRangeLabel, pageSlice, rememberedPageSize, rememberPageSize } from '../../src/lib/pager';

const items = Array.from({ length: 148 }, (_, i) => i + 1);

describe('pager', () => {
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it('slices the first, middle and last page', () => {
    assert.deepEqual(pageSlice(items, 1, 50).slice(0, 2), [1, 2]);
    assert.equal(pageSlice(items, 1, 50).length, 50);
    assert.equal(pageSlice(items, 2, 50)[0], 51);
    assert.deepEqual(pageSlice(items, 3, 50), items.slice(100));
  });

  it('counts pages, with at least one page for an empty list', () => {
    assert.equal(pageCount(148, 50), 3);
    assert.equal(pageCount(150, 50), 3);
    assert.equal(pageCount(0, 25), 1);
  });

  it('keeps the page valid after the page size changes', () => {
    assert.equal(clampPage(3, 148, 100), 2);
    assert.equal(clampPage(2, 148, 25), 2);
    assert.equal(clampPage(4, 0, 50), 1);
  });

  it('labels the visible range', () => {
    assert.equal(pageRangeLabel(148, 1, 50, 'channels'), '1–50 of 148 channels');
    assert.equal(pageRangeLabel(148, 3, 50, 'channels'), '101–148 of 148 channels');
    assert.equal(pageRangeLabel(0, 1, 50, 'songs'), '0 songs');
  });

  it('remembers the page size per list', () => {
    const store = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
    };
    rememberPageSize('console-songs', 100);
    assert.equal(rememberedPageSize('console-songs'), 100);
    assert.equal(rememberedPageSize('console-radio'), 50);
  });

  it('falls back to 50 when storage throws or holds junk', () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    };
    assert.equal(rememberedPageSize('console-songs'), 50);
    assert.doesNotThrow(() => rememberPageSize('console-songs', 25));
    (globalThis as { localStorage?: unknown }).localStorage = { getItem: () => '37', setItem: () => {} };
    assert.equal(rememberedPageSize('console-songs'), 50);
  });
});
