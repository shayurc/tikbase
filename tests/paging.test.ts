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
