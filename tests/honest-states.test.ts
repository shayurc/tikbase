/**
 * windowCountsFor (api/top-products.ts): a failed stats chunk must read as
 * "unknown", never as "0 creators" — 0 is what earns an Opportunity badge.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { windowCountsFor, annotateOpportunity } from '../api/top-products';

const stats = new Map([['p1', { distinctCreators: 12, windowVideos: 40, commissionedVideos: 9 }]]);

test('a product the RPC answered for keeps its counts', () => {
  assert.deepEqual(windowCountsFor(stats, new Set(), 'p1'), { distinct_creators: 12, window_video_count: 40 });
});

test('a product the RPC answered "nothing" for is a real zero', () => {
  assert.deepEqual(windowCountsFor(stats, new Set(), 'p2'), { distinct_creators: 0, window_video_count: 0 });
  assert.deepEqual(windowCountsFor(stats, undefined, 'p2'), { distinct_creators: 0, window_video_count: 0 });
});

test('a product whose chunk failed is unknown, not zero', () => {
  assert.deepEqual(windowCountsFor(stats, new Set(['p3']), 'p3'), { distinct_creators: null, window_video_count: null });
});

test('THE BUG: a timed-out chunk no longer hands out Opportunity badges', () => {
  const row = (id: string, rev: number, counts: { distinct_creators: number | null }) => ({
    product_id: id, metrics: { estRevenue: rev, hasRealDelta: true }, ...counts,
  });
  // Ten ordinary products, and one best-seller whose stats chunk failed.
  const make = (failedCounts: { distinct_creators: number | null }) => [
    ...Array.from({ length: 10 }, (_, i) => row(`n${i}`, 1000 + i, { distinct_creators: 20 + i })),
    row('big', 999_999, failedCounts),
  ];
  const before = make({ distinct_creators: 0 }); // what `?? 0` produced
  annotateOpportunity(before);
  assert.equal(before.at(-1)!.opportunity, true);

  const after = make(windowCountsFor(new Map(), new Set(['big']), 'big'));
  annotateOpportunity(after);
  assert.equal(after.at(-1)!.opportunity, false);
});
