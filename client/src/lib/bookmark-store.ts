/**
 * Where saved items live, per account.
 *
 * They were stored under one key for the whole browser, so whoever signed in
 * next on the same device opened Saved and found the previous person's list —
 * and added to it. Each account now has its own key.
 *
 * Lists saved before this change sit under the old unscoped key. The first
 * account to sign in afterwards takes them over (they are almost always that
 * person's) and the old key is removed, so they are not handed to a second
 * account as well.
 *
 * No React and no direct localStorage here: the storage is passed in, so this
 * runs under node:test.
 */

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 'anon' when nobody is signed in. */
export function scopedKey(base: string, scope: string): string {
  return `${base}:${scope}`;
}

function parseList<T>(raw: string | null): T[] | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : null;
  } catch {
    return null;
  }
}

export function loadScoped<T>(store: KeyValueStore, base: string, scope: string): T[] {
  try {
    const own = parseList<T>(store.getItem(scopedKey(base, scope)));
    if (own) return own;
    if (scope === 'anon') return [];
    const legacy = parseList<T>(store.getItem(base));
    if (!legacy) return [];
    store.setItem(scopedKey(base, scope), JSON.stringify(legacy));
    store.removeItem(base);
    return legacy;
  } catch {
    // Storage blocked (private mode, sandboxed iframe): nothing saved, nothing thrown.
    return [];
  }
}

export function saveScoped<T>(store: KeyValueStore, base: string, scope: string, value: T[]): void {
  try {
    store.setItem(scopedKey(base, scope), JSON.stringify(value));
  } catch {
    /* storage blocked — keep in memory only */
  }
}
