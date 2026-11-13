/**
 * The three decisions that decide who pays for what and who sees what.
 *
 *   askSubscription      the browser's "does this account pay?" — where a
 *                        failed request used to be read as "no", paywalling a
 *                        paying customer for the rest of the session.
 *   resolveSessionOwner  which account a paid checkout is written to — where
 *                        the request body used to choose.
 *   rankForCaller        which rows a caller may see — where a free caller's
 *                        `sort` used to choose from all 400.
 *
 * All three are pure, so every branch is here. No network, no database.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { askSubscription } from '../client/src/lib/subscription-check';
import { resolveSessionOwner } from '../api/verify-session';
import { rankForCaller } from '../api/top-products';

// ---------------------------------------------------------------- askSubscription

type Step = { status: number; body?: unknown; raw?: string } | 'network-error';

/** A fetch that answers from a script, one step per call. */
function scriptedFetch(steps: Step[]) {
  const calls: Array<{ url: string; auth: string | undefined }> = [];
  const impl = (async (url: string, init?: any) => {
    calls.push({ url, auth: init?.headers?.Authorization });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (step === 'network-error') throw new TypeError('fetch failed');
    return new Response(step.raw ?? JSON.stringify(step.body ?? {}), { status: step.status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function noWait() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

test('askSubscription: a 200 is an answer, either way, in one request', async () => {
  for (const isPaid of [true, false]) {
    const f = scriptedFetch([{ status: 200, body: { isPaid } }]);
    const answer = await askSubscription('tok', { fetchImpl: f.impl, sleep: noWait().sleep });
    assert.deepEqual(answer, { known: true, isPaid });
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, '/api/check-subscription');
    assert.equal(f.calls[0].auth, 'Bearer tok'); // the old success-page poll sent none
  }
});

test('askSubscription: a 503 then a 200 is retried into an answer', async () => {
  const f = scriptedFetch([
    { status: 503, body: { error: 'service_unavailable' } },
    { status: 200, body: { isPaid: true } },
  ]);
  const w = noWait();
  const answer = await askSubscription('tok', { fetchImpl: f.impl, sleep: w.sleep });
  assert.deepEqual(answer, { known: true, isPaid: true });
  assert.equal(f.calls.length, 2);
  assert.deepEqual(w.waits, [1000]);
});

test('askSubscription: a 500 that never recovers is UNKNOWN, not "free"', async () => {
  // Exactly what production returned: a non-JSON 500 body.
  const f = scriptedFetch([{ status: 500, raw: 'A server error has occurred' }]);
  const w = noWait();
  const answer = await askSubscription('tok', { fetchImpl: f.impl, sleep: w.sleep });
  assert.deepEqual(answer, { known: false });
  assert.equal(f.calls.length, 3); // first try + two retries
  assert.deepEqual(w.waits, [1000, 3000]);
});

test('askSubscription: a dead connection is UNKNOWN, not "free"', async () => {
  const f = scriptedFetch(['network-error']);
  const answer = await askSubscription('tok', { fetchImpl: f.impl, sleep: noWait().sleep });
  assert.deepEqual(answer, { known: false });
  assert.equal(f.calls.length, 3);
});

test('askSubscription: a 200 that is not JSON is not an answer', async () => {
  const f = scriptedFetch([{ status: 200, raw: '<html>gateway</html>' }, { status: 200, body: { isPaid: true } }]);
  const answer = await askSubscription('tok', { fetchImpl: f.impl, sleep: noWait().sleep });
  assert.deepEqual(answer, { known: true, isPaid: true });
  assert.equal(f.calls.length, 2);
});

test('askSubscription: retryDelaysMs [] means one attempt (the success page polls itself)', async () => {
  const f = scriptedFetch([{ status: 503 }]);
  const answer = await askSubscription('tok', { fetchImpl: f.impl, retryDelaysMs: [], sleep: noWait().sleep });
  assert.deepEqual(answer, { known: false });
  assert.equal(f.calls.length, 1);
});

// ------------------------------------------------------------ resolveSessionOwner

const A = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const none = { stampedUserId: null, linkedUserId: null, callerId: null, legacyUserId: null };

test('owner: a checkout started from the site goes to the account stamped on it', () => {
  assert.deepEqual(resolveSessionOwner({ ...none, stampedUserId: A, linkedUserId: A, callerId: A }), {
    ok: true,
    userId: A,
  });
});

test('owner: a client from before the token was sent still confirms its own purchase', () => {
  // No bearer, user_id in the body. It is compared to the stamp, never written.
  assert.deepEqual(resolveSessionOwner({ ...none, stampedUserId: A, legacyUserId: A }), {
    ok: true,
    userId: A,
  });
});

test('owner: nobody else can confirm a stamped checkout, whatever the body says', () => {
  const byToken = resolveSessionOwner({ ...none, stampedUserId: A, callerId: B, legacyUserId: A });
  assert.equal(byToken.ok, false);
  assert.equal(!byToken.ok && byToken.status, 403);

  const byBody = resolveSessionOwner({ ...none, stampedUserId: A, legacyUserId: B });
  assert.equal(byBody.ok, false);
  assert.equal(!byBody.ok && byBody.status, 403);
});

test('owner: a stamped checkout with nobody named is asked to sign in', () => {
  const d = resolveSessionOwner({ ...none, stampedUserId: A });
  assert.equal(!d.ok && d.status, 401);
});

test('owner: THE HOLE — a Payment Link session cannot be claimed with a body user_id', () => {
  // Before: no client_reference_id meant the guard was skipped and the
  // subscription was written to whatever user_id the request carried.
  const d = resolveSessionOwner({ ...none, legacyUserId: B });
  assert.equal(d.ok, false);
  assert.equal(!d.ok && d.status, 401);
});

test('owner: a Payment Link session goes to the first signed-in claim', () => {
  assert.deepEqual(resolveSessionOwner({ ...none, callerId: A }), { ok: true, userId: A });
});

test('owner: confirming again from the same account is fine', () => {
  assert.deepEqual(resolveSessionOwner({ ...none, callerId: A, linkedUserId: A }), {
    ok: true,
    userId: A,
  });
});

test('owner: one payment, one account — a linked subscription cannot be taken', () => {
  const second = resolveSessionOwner({ ...none, callerId: B, linkedUserId: A });
  assert.equal(second.ok, false);
  assert.equal(!second.ok && second.status, 403);

  const stampedElsewhere = resolveSessionOwner({ ...none, stampedUserId: A, callerId: A, linkedUserId: B });
  assert.equal(stampedElsewhere.ok, false);
  assert.equal(!stampedElsewhere.ok && stampedElsewhere.status, 403);
});

// ------------------------------------------------------------------ rankForCaller

/** 30 products in default order (revenue descending), with other columns scrambled. */
function ranking() {
  return Array.from({ length: 30 }, (_, i) => ({
    product_id: `p${String(i + 1).padStart(2, '0')}`,
    sale_price: ((i * 7 + 13) % 30) + 1, // the cheapest ($1) is p12 — outside the free ten
    sold_count: ((i * 11) % 30) * 100,
    stock_quantity: (i * 13) % 30,
    distinct_creators: (i * 17) % 30,
    affiliate_intensity: ((i * 19) % 30) / 30,
    metrics: { estRevenue: 30_000 - i * 1000, periodViews: (i * 23) % 30, estPeriodUnitsSold: 30 - i },
    windows: { '7': { revenue: 30_000 - i * 1000 }, '30': { revenue: ((i * 29) % 30) * 5000 } },
  }));
}
const ids = (rows: any[]) => rows.map((r) => r.product_id);
const FREE_TEN = ids(ranking().slice(0, 10));
const SORT_KEYS = [
  'periodViews', 'sold_count', 'estRevenue', 'stock_quantity', 'total_sold',
  'sale_price', 'revenue7d', 'revenue30d', 'distinct_creators', 'affiliate_intensity',
];

test('free: the default view is the top ten, unchanged', () => {
  assert.deepEqual(ids(rankForCaller(ranking(), 'free', 'estRevenue', 'desc')), FREE_TEN);
});

test('free: NO sort key, in either direction, reveals a row outside the top ten', () => {
  for (const key of SORT_KEYS) {
    for (const dir of ['asc', 'desc']) {
      const got = ids(rankForCaller(ranking(), 'free', key, dir));
      assert.equal(got.length, 10, `${key} ${dir}`);
      assert.deepEqual([...got].sort(), [...FREE_TEN].sort(), `${key} ${dir} leaked a Pro row`);
    }
  }
});

test('free: sorting still works — it re-orders the ten', () => {
  const byPrice = rankForCaller(ranking(), 'free', 'sale_price', 'asc');
  const prices = byPrice.map((r) => r.sale_price);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
  assert.notDeepEqual(ids(byPrice), FREE_TEN);
});

test('free: a sort key that does not exist changes nothing', () => {
  assert.deepEqual(ids(rankForCaller(ranking(), 'free', 'no_such_column', 'asc')), FREE_TEN);
});

test('paid: sorts the whole ranking, as before', () => {
  const all = ranking();
  const byPrice = rankForCaller(all, 'paid', 'sale_price', 'asc');
  assert.equal(byPrice.length, 30);
  assert.equal(byPrice[0].sale_price, 1);
  // The cheapest product is outside the free ten: a paid caller sees it first,
  // and a free caller sorting the same way must not (asserted above).
  assert.equal(byPrice[0].product_id, 'p12');
  assert.equal(FREE_TEN.includes(byPrice[0].product_id), false);
  // Default order is returned as-is.
  assert.deepEqual(ids(rankForCaller(all, 'paid', 'estRevenue', 'desc')), ids(all));
});

test('the cached ranking is never re-ordered in place', () => {
  const all = ranking();
  const before = ids(all);
  rankForCaller(all, 'paid', 'sale_price', 'asc');
  rankForCaller(all, 'free', 'revenue30d', 'desc');
  assert.deepEqual(ids(all), before);
});
