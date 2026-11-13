/**
 * Per-account saved items and referral attribution. Both pure; no browser.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScoped, saveScoped, scopedKey, type KeyValueStore } from '../client/src/lib/bookmark-store';
import { shouldAttachReferral, ATTRIBUTION_WINDOW_MS } from '../client/src/lib/referral';

function memoryStore(initial: Record<string, string> = {}): KeyValueStore & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = v; },
    removeItem: (k) => { delete data[k]; },
  };
}
const BASE = 'tikbase:savedVideos';

test('saved: two accounts on one browser do not see each other\'s list', () => {
  const store = memoryStore();
  saveScoped(store, BASE, 'alice', [{ v: 1 }]);
  saveScoped(store, BASE, 'bob', [{ v: 2 }, { v: 3 }]);
  assert.deepEqual(loadScoped(store, BASE, 'alice'), [{ v: 1 }]);
  assert.deepEqual(loadScoped(store, BASE, 'bob'), [{ v: 2 }, { v: 3 }]);
  assert.deepEqual(loadScoped(store, BASE, 'carol'), []);
});

test('saved: a list from before the change goes to the first account, once', () => {
  const store = memoryStore({ [BASE]: JSON.stringify([{ v: 'old' }]) });
  assert.deepEqual(loadScoped(store, BASE, 'alice'), [{ v: 'old' }]);
  assert.equal(store.getItem(BASE), null); // not left for the next account
  assert.deepEqual(loadScoped(store, BASE, 'bob'), []);
  assert.deepEqual(loadScoped(store, BASE, 'alice'), [{ v: 'old' }]);
});

test('saved: signed-out never adopts or exposes the old list', () => {
  const store = memoryStore({ [BASE]: JSON.stringify([{ v: 'old' }]) });
  assert.deepEqual(loadScoped(store, BASE, 'anon'), []);
  assert.notEqual(store.getItem(BASE), null);
});

test('saved: corrupt or blocked storage is an empty list, not a crash', () => {
  assert.deepEqual(loadScoped(memoryStore({ [scopedKey(BASE, 'alice')]: '{not json' }), BASE, 'alice'), []);
  const blocked: KeyValueStore = {
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('SecurityError'); },
    removeItem() { throw new Error('SecurityError'); },
  };
  assert.deepEqual(loadScoped(blocked, BASE, 'alice'), []);
  assert.doesNotThrow(() => saveScoped(blocked, BASE, 'alice', [1]));
});

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0);
const createdAgo = (ms: number) => new Date(NOW - ms).toISOString();

test('referral: a brand-new account with a stored code is attributed', () => {
  assert.equal(shouldAttachReferral({ hasStoredCode: true, alreadyAttributed: false, accountCreatedAt: createdAgo(20_000), now: NOW }), true);
});

test('referral: an existing customer who clicks an affiliate link is NOT re-attributed', () => {
  assert.equal(shouldAttachReferral({ hasStoredCode: true, alreadyAttributed: false, accountCreatedAt: createdAgo(40 * 86_400_000), now: NOW }), false);
  assert.equal(shouldAttachReferral({ hasStoredCode: true, alreadyAttributed: false, accountCreatedAt: createdAgo(ATTRIBUTION_WINDOW_MS + 1), now: NOW }), false);
});

test('referral: never overwritten, never invented', () => {
  assert.equal(shouldAttachReferral({ hasStoredCode: true, alreadyAttributed: true, accountCreatedAt: createdAgo(1000), now: NOW }), false);
  assert.equal(shouldAttachReferral({ hasStoredCode: false, alreadyAttributed: false, accountCreatedAt: createdAgo(1000), now: NOW }), false);
  assert.equal(shouldAttachReferral({ hasStoredCode: true, alreadyAttributed: false, accountCreatedAt: null, now: NOW }), false);
  assert.equal(shouldAttachReferral({ hasStoredCode: true, alreadyAttributed: false, accountCreatedAt: 'garbage', now: NOW }), false);
});
