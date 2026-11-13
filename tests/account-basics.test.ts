/**
 * The two decisions behind the account pages, both pure.
 *
 *   deletionDecision  when an account may be deleted. Getting it wrong either
 *                     deletes on a stray request or leaves Stripe charging a
 *                     card for a login that no longer exists.
 *   passwordProblem   what the reset form refuses.
 *
 * No network, no database.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { deletionDecision, CONFIRM_WORD } from '../api/delete-account';
import { passwordProblem, MIN_PASSWORD_LENGTH } from '../client/src/pages/reset-password';

test('delete: nothing happens without the exact confirmation word', () => {
  for (const confirm of [undefined, null, '', 'delete', 'DELETE ', true, 'yes']) {
    const d = deletionDecision({ confirm, subscriptionStatus: null });
    assert.equal(d.ok, false, String(confirm));
    assert.equal(!d.ok && d.status, 400);
  }
});

test('delete: refused while a subscription is live, in every paying status', () => {
  for (const status of ['active', 'trialing', 'past_due']) {
    const d = deletionDecision({ confirm: CONFIRM_WORD, subscriptionStatus: status });
    assert.equal(d.ok, false, status);
    assert.equal(!d.ok && d.status, 409);
    assert.match(!d.ok ? d.message : '', /Billing/);
  }
});

test('delete: allowed for a free account and for an ended subscription', () => {
  for (const status of [null, undefined, 'canceled', 'incomplete_expired', 'unpaid']) {
    assert.deepEqual(deletionDecision({ confirm: CONFIRM_WORD, subscriptionStatus: status }), { ok: true });
  }
});

test('delete: the confirmation is checked before the plan', () => {
  const d = deletionDecision({ confirm: 'nope', subscriptionStatus: 'active' });
  assert.equal(!d.ok && d.status, 400);
});

test('password: too short is refused, at the stated length it is accepted', () => {
  const short = 'a'.repeat(MIN_PASSWORD_LENGTH - 1);
  const ok = 'a'.repeat(MIN_PASSWORD_LENGTH);
  assert.match(passwordProblem(short, short) ?? '', /at least/);
  assert.equal(passwordProblem(ok, ok), null);
});

test('password: a mismatch is refused', () => {
  assert.match(passwordProblem('correct horse', 'correct house') ?? '', /do not match/);
});
