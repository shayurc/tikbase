// Apple in-app purchase: the receipt checker and the rules for what a receipt
// is allowed to do. These are the tests that stand between "anyone can POST a
// string" and "this account is Pro".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { verifyAppleJws, AppleJwsError, APPLE_ROOT_CA_G3_PEM } from '../api/_lib/apple-jws';
import {
  checkTransaction,
  recordFromTransaction,
  newerRecord,
  appleRecordActive,
  appleConfig,
  APPLE_EXPIRY_SLACK_MS,
  type AppleTransaction,
} from '../api/_lib/apple-subscription';
import { hasPaidAccess } from '../api/_lib/resolve-tier';
import { deletionDecision } from '../api/delete-account';
import { forcedStatus } from '../api/apple-notifications';
import { makeChain, signJws } from './apple-chain';

const NOW = Date.parse('2026-11-13T12:00:00Z');
const DAY = 86_400_000;
const USER = '3f2b8a1e-9c4d-4e6f-8a7b-1c2d3e4f5a6b';

const chain = makeChain();
const trust = { trustedRoots: [chain.rootPem], now: NOW };

function rejects(fn: () => unknown, pattern: RegExp) {
  assert.throws(fn, (e: unknown) => e instanceof AppleJwsError && pattern.test((e as Error).message));
}

// ---- the pinned root -------------------------------------------------------

test('the pinned root is Apple Root CA - G3', () => {
  const root = new X509Certificate(APPLE_ROOT_CA_G3_PEM);
  assert.equal(
    root.fingerprint256,
    '63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79',
  );
  assert.match(root.subject, /Apple Root CA - G3/);
});

// ---- signature and chain ---------------------------------------------------

test('a correctly signed receipt verifies and returns its payload', () => {
  const jws = signJws(chain, { productId: 'p', signedDate: NOW - 1000 });
  assert.deepEqual(verifyAppleJws(jws, trust), { productId: 'p', signedDate: NOW - 1000 });
});

test('a valid chain from a root we do not trust is refused', () => {
  // The default trust is Apple's root only; a home-made chain must not pass.
  const jws = signJws(chain, { signedDate: NOW });
  rejects(() => verifyAppleJws(jws, { now: NOW }), /untrusted root/);
});

test('a payload changed after signing is refused', () => {
  const [h, , s] = signJws(chain, { appAccountToken: 'victim', signedDate: NOW }).split('.');
  const forged = Buffer.from(JSON.stringify({ appAccountToken: USER, signedDate: NOW })).toString('base64url');
  rejects(() => verifyAppleJws(`${h}.${forged}.${s}`, trust), /bad signature/);
});

test('a receipt signed by a key other than the leaf certificate is refused', () => {
  const other = makeChain();
  const jws = signJws(chain, { signedDate: NOW }, { keyPem: other.leafKeyPem });
  rejects(() => verifyAppleJws(jws, trust), /bad signature/);
});

test('a leaf from a different issuer spliced under the trusted root is refused', () => {
  const other = makeChain();
  const jws = signJws(other, { signedDate: NOW }, { x5c: [other.x5c[0], chain.x5c[1], chain.x5c[2]] });
  rejects(() => verifyAppleJws(jws, trust), /bad leaf/);
});

test('a leaf without the receipt-signing marker is refused', () => {
  // The case that matters most: a certificate Apple really issued, for
  // something other than signing receipts.
  const c = makeChain({ leafOid: false });
  const jws = signJws(c, { signedDate: NOW });
  rejects(() => verifyAppleJws(jws, { trustedRoots: [c.rootPem], now: NOW }), /not a receipt signer/);
});

test('an intermediate without the Apple WWDR marker is refused', () => {
  const c = makeChain({ intermediateOid: false });
  const jws = signJws(c, { signedDate: NOW });
  rejects(() => verifyAppleJws(jws, { trustedRoots: [c.rootPem], now: NOW }), /not Apple WWDR/);
});

test('any algorithm other than ES256 is refused', () => {
  for (const alg of ['none', 'HS256', 'RS256']) {
    rejects(() => verifyAppleJws(signJws(chain, { signedDate: NOW }, { alg }), trust), /algorithm/);
  }
});

test('a chain that is not exactly leaf, intermediate, root is refused', () => {
  const two = signJws(chain, { signedDate: NOW }, { x5c: chain.x5c.slice(0, 2) });
  rejects(() => verifyAppleJws(two, trust), /certificate chain/);
  const selfSigned = signJws(chain, { signedDate: NOW }, { x5c: [chain.x5c[2], chain.x5c[2], chain.x5c[2]] });
  assert.throws(() => verifyAppleJws(selfSigned, trust), AppleJwsError);
});

test('a receipt dated in the future is refused', () => {
  const jws = signJws(chain, { signedDate: NOW + 3 * DAY });
  rejects(() => verifyAppleJws(jws, trust), /future/);
});

test('a receipt dated before the certificates existed is refused', () => {
  const jws = signJws(chain, { signedDate: Date.parse('2001-01-01') });
  rejects(() => verifyAppleJws(jws, trust), /not valid at signing time/);
});

test('junk is refused without throwing anything else', () => {
  for (const junk of [undefined, null, 42, '', 'a.b', 'a.b.c', '..', 'x'.repeat(30_000)]) {
    assert.throws(() => verifyAppleJws(junk as any, trust), AppleJwsError);
  }
});

// ---- which account a receipt may unlock -------------------------------------

const cfg = appleConfig({});
const tx = (over: Partial<AppleTransaction> = {}): AppleTransaction => ({
  bundleId: 'io.tikbase.app',
  productId: 'io.tikbase.app.pro.monthly',
  environment: 'Production',
  appAccountToken: USER,
  originalTransactionId: '1000',
  transactionId: '1001',
  expiresDate: NOW + 30 * DAY,
  signedDate: NOW,
  ...over,
});

test('a receipt for this app, this product and this account is accepted', () => {
  assert.deepEqual(checkTransaction(tx(), USER, cfg), { ok: true });
  // Apple and Supabase may disagree on letter case in the id.
  assert.deepEqual(checkTransaction(tx({ appAccountToken: USER.toUpperCase() }), USER, cfg), { ok: true });
});

test("someone else's receipt cannot unlock this account", () => {
  const other = '00000000-0000-4000-8000-000000000000';
  const r = checkTransaction(tx({ appAccountToken: other }), USER, cfg);
  assert.equal(r.ok, false);
  assert.equal((r as any).status, 409);
  assert.equal((r as any).error, 'different_account');
});

test('a receipt with no account id unlocks nobody', () => {
  assert.equal(checkTransaction(tx({ appAccountToken: undefined }), USER, cfg).ok, false);
});

test("a receipt from another app or for another product is refused", () => {
  assert.equal((checkTransaction(tx({ bundleId: 'com.other.app' }), USER, cfg) as any).error, 'wrong_product');
  assert.equal((checkTransaction(tx({ productId: 'io.tikbase.app.coins' }), USER, cfg) as any).error, 'wrong_product');
});

test('sandbox receipts are accepted unless switched off; Xcode ones never', () => {
  assert.equal(checkTransaction(tx({ environment: 'Sandbox' }), USER, cfg).ok, true);
  const strict = appleConfig({ APPLE_ALLOW_SANDBOX: '0' });
  assert.equal((checkTransaction(tx({ environment: 'Sandbox' }), USER, strict) as any).error, 'wrong_environment');
  assert.equal(checkTransaction(tx({ environment: 'Xcode' }), USER, cfg).ok, false);
});

// ---- what the stored record says --------------------------------------------

test('a paid-through date in the future is active, in the past is expired', () => {
  assert.equal(recordFromTransaction(tx(), NOW).status, 'active');
  assert.equal(recordFromTransaction(tx({ expiresDate: NOW - 1 }), NOW).status, 'expired');
  assert.equal(recordFromTransaction(tx({ expiresDate: undefined }), NOW).status, 'expired');
});

test('a refunded purchase is revoked even though its dates look live', () => {
  assert.equal(recordFromTransaction(tx({ revocationDate: NOW - DAY }), NOW).status, 'revoked');
  assert.equal(recordFromTransaction(tx(), NOW, { forceStatus: 'revoked' }).status, 'revoked');
});

test("Apple's billing grace period extends the paid-through date", () => {
  const r = recordFromTransaction(tx({ expiresDate: NOW - DAY }), NOW, { gracePeriodExpiresDate: NOW + 5 * DAY });
  assert.equal(r.status, 'active');
  assert.equal(r.expires_at, new Date(NOW + 5 * DAY).toISOString());
});

test('refund and expiry notices end access; renewals do not force anything', () => {
  assert.equal(forcedStatus('REFUND'), 'revoked');
  assert.equal(forcedStatus('REVOKE'), 'revoked');
  assert.equal(forcedStatus('EXPIRED'), 'expired');
  assert.equal(forcedStatus('GRACE_PERIOD_EXPIRED'), 'expired');
  assert.equal(forcedStatus('DID_RENEW'), undefined);
  assert.equal(forcedStatus('SUBSCRIBED'), undefined);
});

test('an older receipt replayed after a refund does not bring Pro back', () => {
  const refunded = recordFromTransaction(tx({ signedDate: NOW }), NOW, { forceStatus: 'revoked' });
  const replay = recordFromTransaction(tx({ signedDate: NOW - DAY }), NOW);
  assert.equal(replay.status, 'active');
  assert.equal(newerRecord(refunded, replay).status, 'revoked');
  // A genuinely newer purchase does win.
  const resubscribed = recordFromTransaction(tx({ signedDate: NOW + DAY, transactionId: '1002' }), NOW + DAY);
  assert.equal(newerRecord(refunded, resubscribed).status, 'active');
  assert.equal(newerRecord(null, replay), replay);
});

test('an Apple record stops counting shortly after its paid-through date', () => {
  const r = recordFromTransaction(tx({ expiresDate: NOW + DAY }), NOW);
  assert.equal(appleRecordActive(r, NOW), true);
  // A late renewal notice must not paywall a paying customer at midnight...
  assert.equal(appleRecordActive(r, NOW + DAY + APPLE_EXPIRY_SLACK_MS - 1), true);
  // ...and a lost expiry notice must not be Pro for ever.
  assert.equal(appleRecordActive(r, NOW + DAY + APPLE_EXPIRY_SLACK_MS + 1), false);
  assert.equal(appleRecordActive({ ...r, status: 'revoked' }, NOW), false);
  for (const junk of [null, undefined, {}, 'active', { status: 'active' }, { status: 'active', expires_at: 'soon' }]) {
    assert.equal(appleRecordActive(junk, NOW), false);
  }
});

// ---- the gates ---------------------------------------------------------------

test('an account is Pro through Stripe, through Apple, or both; otherwise free', () => {
  const apple = recordFromTransaction(tx(), NOW);
  assert.equal(hasPaidAccess({ subscription: { status: 'active' } }, NOW), true);
  assert.equal(hasPaidAccess({ apple_subscription: apple }, NOW), true);
  assert.equal(hasPaidAccess({ subscription: { status: 'canceled' }, apple_subscription: apple }, NOW), true);
  assert.equal(hasPaidAccess({ subscription: { status: 'canceled' } }, NOW), false);
  assert.equal(hasPaidAccess({ apple_subscription: { ...apple, status: 'expired' } }, NOW), false);
  assert.equal(hasPaidAccess({}, NOW), false);
  assert.equal(hasPaidAccess(null, NOW), false);
});

test('account deletion is refused while an Apple subscription is live, and says where to cancel', () => {
  const d = deletionDecision({ confirm: 'DELETE', subscriptionStatus: null, appleActive: true });
  assert.equal(d.ok, false);
  assert.equal((d as any).status, 409);
  assert.match((d as any).message, /Apple Account settings/);
  assert.deepEqual(deletionDecision({ confirm: 'DELETE', subscriptionStatus: null, appleActive: false }), { ok: true });
});
