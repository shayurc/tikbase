/**
 * api/check-subscription.ts on the paths where something is wrong.
 *
 * From 2026-08-15 the handler called isUpstreamOutage() and unavailable()
 * without importing them. The happy path never reaches either, and neither
 * does a request with no token — which is the only request the production
 * smoke test sends — so it shipped and stayed shipped. Every other path threw
 * a ReferenceError, then threw it again from the catch block:
 *
 *   curl -H 'Authorization: Bearer nope' https://tikbase.io/api/check-subscription
 *   -> 500 FUNCTION_INVOCATION_FAILED          (measured 2026-11-12)
 *
 * These drive the real handler with the network replaced, so the cases that
 * only happen when something breaks are the ones under test. No real network,
 * no database, no Stripe.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/check-subscription';

function fakeRes() {
  return {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as any,
    setHeader(name: string, value: string | number) {
      this.headers[name.toLowerCase()] = String(value);
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: any) {
      this.body = body;
      return this;
    },
  };
}

/** Point the handler at nowhere and replace fetch for the length of one test. */
function isolate(t: { after: (fn: () => void) => void }, fetchImpl: typeof fetch) {
  const saved = {
    fetch: globalThis.fetch,
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_SERVICE_ROLE_KEY,
    stripe: process.env.STRIPE_SECRET_KEY,
  };
  process.env.SUPABASE_URL = 'http://supabase.invalid';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  delete process.env.STRIPE_SECRET_KEY; // the self-heal must not run here
  globalThis.fetch = fetchImpl;
  t.after(() => {
    globalThis.fetch = saved.fetch;
    const restore = (name: string, value: string | undefined) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    restore('SUPABASE_URL', saved.url);
    restore('SUPABASE_SERVICE_ROLE_KEY', saved.key);
    restore('STRIPE_SECRET_KEY', saved.stripe);
  });
}

const withToken = { headers: { authorization: 'Bearer some-access-token' }, query: {} } as any;

test('no token: isPaid:false, and the network is never touched', async (t) => {
  let calls = 0;
  isolate(t, (async () => {
    calls++;
    throw new Error('should not be called');
  }) as any);

  const res = fakeRes();
  await handler({ headers: {}, query: {} } as any, res as any);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { isPaid: false });
  assert.equal(calls, 0);
});

test('a token the auth server rejects: isPaid:false, not a crash', async (t) => {
  isolate(t, (async () =>
    new Response(JSON.stringify({ code: 401, error_code: 'bad_jwt', msg: 'invalid JWT' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })) as any);

  const res = fakeRes();
  await handler(withToken, res as any);

  // An invalid token IS an answer: this caller is not a paying customer.
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { isPaid: false });
});

test('the database cannot be reached: 503, never isPaid:false', async (t) => {
  isolate(t, (async () => {
    throw new TypeError('fetch failed');
  }) as any);

  const res = fakeRes();
  await handler(withToken, res as any);

  // "Could not ask" must not be reported as "is not paying".
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, 'service_unavailable');
  assert.equal(res.body.isPaid, undefined);
  assert.equal(res.headers['retry-after'], '30');
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('the auth server answers 503: passed on as 503', async (t) => {
  isolate(t, (async () =>
    new Response(JSON.stringify({ message: 'upstream request timeout' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    })) as any);

  const res = fakeRes();
  await handler(withToken, res as any);

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, 'service_unavailable');
});

test('missing configuration: 503 for a signed-in caller, never isPaid:false', async (t) => {
  isolate(t, (async () => { throw new Error('should not be called'); }) as any);
  delete process.env.SUPABASE_URL;
  delete process.env.VITE_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  const res = fakeRes();
  await handler(withToken, res as any);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.isPaid, undefined);

  // Signed-out still needs no backend at all.
  const anon = fakeRes();
  await handler({ headers: {}, query: {} } as any, anon as any);
  assert.deepEqual(anon.body, { isPaid: false });
});
