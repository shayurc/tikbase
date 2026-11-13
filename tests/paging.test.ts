/**
 * readAllPages and plausiblePostDate (api/_lib/paging.ts).
 *
 * PostgREST returns at most 1000 rows and says nothing when it truncates.
 * api/top-videos.ts asked for 5000 per batch, got 1000, and ranked from that.
 * These drive the helper with a fake table that truncates the same way.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readAllPages, plausiblePostDate, POSTGREST_PAGE } from '../api/_lib/paging';

/** A table of `n` rows that, like PostgREST, never returns more than 1000. */
function fakeTable(n: number, opts: { failAt?: number } = {}) {
  const calls: Array<[number, number]> = [];
  const fetchPage = async (from: number, to: number) => {
    calls.push([from, to]);
    if (opts.failAt !== undefined && from >= opts.failAt) {
      return { data: null, error: { message: 'canceling statement due to statement timeout' } };
    }
    const end = Math.min(to + 1, from + POSTGREST_PAGE, n);
    const data = Array.from({ length: Math.max(0, end - from) }, (_, i) => ({ row: from + i }));
    return { data, error: null };
  };
  return { fetchPage, calls };
}

test('reads past the 1000-row cap', async () => {
  const t = fakeTable(2500);
  const rows = await readAllPages(t.fetchPage);
  assert.equal(rows.length, 2500); // the old code stopped at 1000
  assert.deepEqual(rows.map((r) => r.row), Array.from({ length: 2500 }, (_, i) => i));
  assert.deepEqual(t.calls, [[0, 999], [1000, 1999], [2000, 2999]]);
});

test('an exact multiple of the page size costs one empty read, not a lost page', async () => {
  const t = fakeTable(2000);
  assert.equal((await readAllPages(t.fetchPage)).length, 2000);
  assert.equal(t.calls.length, 3);
});

test('a short table is one request', async () => {
  const t = fakeTable(40);
  assert.equal((await readAllPages(t.fetchPage)).length, 40);
  assert.equal(t.calls.length, 1);
});

test('an empty table is an empty list', async () => {
  assert.deepEqual(await readAllPages(fakeTable(0).fetchPage), []);
});

test('a failed page throws instead of returning a partial ranking', async () => {
  const t = fakeTable(5000, { failAt: 2000 });
  await assert.rejects(
    readAllPages(t.fetchPage, { what: 'product_videos (beauty)' }),
    /product_videos \(beauty\) failed at row 2000: canceling statement/,
  );
});

test('maxRows bounds a runaway read', async () => {
  const t = fakeTable(10_000);
  assert.equal((await readAllPages(t.fetchPage, { maxRows: 3000 })).length, 3000);
});

test('post dates: this year and next year are fine, the future and pre-2020 are not', () => {
  const now = Date.UTC(2028, 5, 1);
  assert.equal(plausiblePostDate(new Date(Date.UTC(2028, 4, 30)), now), true); // 2027 was the old ceiling
  assert.equal(plausiblePostDate(new Date(Date.UTC(2026, 7, 16)), now), true);
  assert.equal(plausiblePostDate(new Date(now + 12 * 3600_000), now), true); // clock skew
  assert.equal(plausiblePostDate(new Date(now + 3 * 86_400_000), now), false);
  assert.equal(plausiblePostDate(new Date(Date.UTC(2019, 11, 31)), now), false);
  assert.equal(plausiblePostDate(new Date(NaN), now), false);
});

// ---- keyset paging and the video pool (the rework that makes full reads affordable)

import { readAllByKey } from '../api/_lib/paging';
import { buildVideoPool, rankVideoWindow } from '../api/top-videos';

/** A table keyed by a sortable string id, served in key order, 1000 at a time. */
function keyedTable(n: number, opts: { failAfter?: number } = {}) {
  const all = Array.from({ length: n }, (_, i) => ({ id: `k${String(i).padStart(7, '0')}` }));
  const calls: Array<string | null> = [];
  const fetchAfter = async (last: string | null, size: number) => {
    calls.push(last);
    if (opts.failAfter !== undefined && calls.length > opts.failAfter) {
      return { data: null, error: { message: 'upstream request timeout' } };
    }
    const start = last === null ? 0 : all.findIndex((r) => r.id > last);
    return { data: start < 0 ? [] : all.slice(start, start + size), error: null };
  };
  return { fetchAfter, calls, all };
}

test('keyset: reads every row, in order, each exactly once', async () => {
  const t = keyedTable(3456);
  const rows = await readAllByKey(t.fetchAfter, (r) => r.id);
  assert.deepEqual(rows, t.all);
  assert.equal(t.calls.length, 4);
  assert.equal(t.calls[0], null);
});

test('keyset: a failed page throws, with how far it got', async () => {
  const t = keyedTable(5000, { failAfter: 2 });
  await assert.rejects(readAllByKey(t.fetchAfter, (r) => r.id, { what: 'product_videos' }), /product_videos failed after 2000 rows/);
});

test('keyset: a key that does not advance is an error, not an endless loop', async () => {
  const stuck = async () => ({ data: Array.from({ length: 1000 }, () => ({ id: 'same' })), error: null });
  await assert.rejects(readAllByKey(stuck, (r: any) => r.id), /did not advance/);
});

const NOW_MS = Date.UTC(2026, 10, 13);
const DAY = 86_400_000;
const urlAt = (ms: number, n = 1) => `https://www.tiktok.com/@c/video/${(BigInt(Math.floor(ms / 1000)) << 32n) | BigInt(n)}`;
const vid = (daysAgo: number, views: number, extra: object = {}) => ({
  id: `uuid-${daysAgo}-${views}`, product_id: 'p1', video_url: urlAt(NOW_MS - daysAgo * DAY, views), view_count: views, ...extra,
});

test('pool: undatable, implausible and older-than-a-year rows are dropped', () => {
  const pool = buildVideoPool(
    [vid(3, 100), vid(400, 999), { id: 'x', product_id: 'p', video_url: 'https://www.tiktok.com/@c/photo/1', view_count: 5 }, { id: 'y', product_id: 'p', video_url: null, view_count: 5 }],
    NOW_MS,
  );
  assert.equal(pool.length, 1);
  assert.equal(pool[0].view_count, 100);
  assert.equal('id' in pool[0], false); // the paging key is not part of the payload
});

test('pool: the same video on two product rows is kept once, most-viewed row wins, in any order', () => {
  const url = urlAt(NOW_MS - 2 * DAY, 7);
  const a = { id: 'a', product_id: 'p1', video_url: url, view_count: 10 };
  const b = { id: 'b', product_id: 'p2', video_url: url, view_count: 90 };
  for (const rows of [[a, b], [b, a]]) {
    const pool = buildVideoPool(rows, NOW_MS);
    assert.equal(pool.length, 1);
    assert.equal(pool[0].product_id, 'p2');
  }
});

test('window: THE BUG — a recent video is ranked however many old ones outview it', () => {
  // 1500 year-old videos with huge views, then one from three days ago. The
  // old read took the 1000 most-viewed and never saw the recent one.
  const old = Array.from({ length: 1500 }, (_, i) => vid(200 + (i % 100), 1_000_000 + i));
  const pool = buildVideoPool([...old, vid(3, 80_000)], NOW_MS);
  const week = rankVideoWindow(pool, 7, NOW_MS);
  assert.equal(week.length, 1);
  assert.equal(week[0].view_count, 80_000);
});

test('window: one pool serves every window, widest includes narrowest, most-viewed first', () => {
  const pool = buildVideoPool([vid(1, 50), vid(5, 500), vid(20, 5), vid(100, 9000), vid(300, 70)], NOW_MS);
  const sizes = [7, 14, 30, 90, 180, 365].map((d) => rankVideoWindow(pool, d, NOW_MS).length);
  assert.deepEqual(sizes, [2, 2, 3, 3, 4, 5]);
  const year = rankVideoWindow(pool, 365, NOW_MS).map((v) => v.view_count);
  assert.deepEqual(year, [9000, 500, 70, 50, 5]);
  assert.equal(pool.length, 5); // ranking a window does not consume the pool
});
