/**
 * api/_lib/resolve-tier.ts — the one tier gate every data endpoint now uses.
 * Driven with a fake Supabase admin client that counts its calls. No network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTier } from '../api/_lib/resolve-tier';

function fakeAdmin(opts: { status?: string | null; getUserFails?: boolean; lookupFails?: boolean } = {}) {
  const calls = { getUser: 0, getUserById: 0 };
  const admin: any = {
    auth: {
      async getUser(_token: string) {
        calls.getUser++;
        if (opts.getUserFails) return { data: { user: null }, error: { message: 'fetch failed' } };
        return { data: { user: { id: 'u1' } }, error: null };
      },
      admin: {
        async getUserById(_id: string) {
          calls.getUserById++;
          if (opts.lookupFails) return { data: { user: null }, error: { message: 'timeout' } };
          const app_metadata = opts.status ? { subscription: { status: opts.status } } : {};
          return { data: { user: { id: 'u1', app_metadata } }, error: null };
        },
      },
    },
  };
  return { admin, calls };
}
let n = 0;
/** A fresh token each time, so one test's memo cannot answer another's. */
const req = (token = `tok-${++n}`) => ({ headers: { authorization: `Bearer ${token}` } });

test('no token is free, without asking anyone', async () => {
  const f = fakeAdmin({ status: 'active' });
  assert.equal(await resolveTier({ headers: {} }, f.admin), 'free');
  assert.deepEqual(f.calls, { getUser: 0, getUserById: 0 });
});

test('the tier is never taken from anything but the token', async () => {
  const f = fakeAdmin({ status: null });
  const r: any = { headers: { authorization: `Bearer tok-${++n}`, 'x-tier': 'paid' }, query: { tier: 'paid' } };
  assert.equal(await resolveTier(r, f.admin), 'free');
});

test('every paying status is paid; an ended one is free', async () => {
  for (const status of ['active', 'trialing', 'past_due']) {
    assert.equal(await resolveTier(req(), fakeAdmin({ status }).admin), 'paid', status);
  }
  for (const status of ['canceled', 'unpaid', 'incomplete_expired']) {
    assert.equal(await resolveTier(req(), fakeAdmin({ status }).admin), 'free', status);
  }
});

test('a repeat request with the same token costs no round trips', async () => {
  const f = fakeAdmin({ status: 'active' });
  const same = req();
  assert.equal(await resolveTier(same, f.admin), 'paid');
  assert.equal(await resolveTier(same, f.admin), 'paid');
  assert.equal(await resolveTier(same, f.admin), 'paid');
  assert.deepEqual(f.calls, { getUser: 1, getUserById: 1 }); // the inline copies paid 2 per request
});

test('a failed lookup answers free but is NOT remembered', async () => {
  const same = req();
  const broken = fakeAdmin({ status: 'active', lookupFails: true });
  assert.equal(await resolveTier(same, broken.admin), 'free');
  // The blip is over: the same token must resolve to paid at once, not after
  // a minute of being pinned to the free tier.
  const healthy = fakeAdmin({ status: 'active' });
  assert.equal(await resolveTier(same, healthy.admin), 'paid');
  assert.equal(healthy.calls.getUser, 1);
});
