// Lives under api/_lib, not shared/, and that is load-bearing.
//
// @vercel/node compiles each api/*.ts to api/*.js WITHOUT bundling its local
// imports, so an import of '../shared/avatar-cache' survived into the deployed
// function as a bare specifier pointing at a directory Vercel never shipped.
// Every endpoint that imported it died on cold start, in production, for days:
//
//   Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/var/task/shared/avatar-cache'
//     imported from /var/task/api/avatar.js
//
// Files under api/ are compiled and shipped; a leading underscore keeps this
// directory from being routed as functions. Imports of it carry an explicit
// .js extension because the deployed importer is ESM and Node will not guess.

/**
 * avatar-cache.ts — the one storage-write path for creator avatars.
 *
 * Extracted from api/avatar.ts so the request-time proxy and the nightly warmer
 * (pipeline/warm-avatars.ts) cache bytes identically. The storage key derivation
 * in particular must never drift: if the warmer wrote to a different path than
 * the proxy reads, warming would silently cache nothing the page can find.
 *
 * Why any of this exists: TikTok CDN avatar URLs are signed (`x-expires`,
 * `x-signature`) and 403 the moment the signature lapses, so the avatar_url we
 * store on `creators` is dead within about a day. Caching the bytes once, keyed
 * by creator rather than by URL, is what makes the leaderboard render faces.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { acceptableImage } from './image-guard.js';

export const AVATAR_BUCKET = 'thumbnails'; // reuse the existing bucket; distinct path prefix
export const AVATAR_PREFIX = 'avatars';
export const AVATAR_IMG_TIMEOUT_MS = 8000;

/**
 * creator_key is 'lower(handle)' or 'id:<digits>'. Flatten to a filesystem-safe
 * name; the charset is already constrained by the migration's derivation.
 *
 * DO NOT change this without migrating the existing objects — the proxy resolves
 * reads through the same function, so a changed mapping orphans every cached
 * avatar at once.
 */
export function avatarStorageName(creatorKey: string): string {
  return `${creatorKey.replace(/[^a-z0-9_.-]/gi, '_').slice(0, 120)}.jpg`;
}

export function avatarStoragePath(creatorKey: string): string {
  return `${AVATAR_PREFIX}/${avatarStorageName(creatorKey)}`;
}

export function avatarPublicUrl(supabase: SupabaseClient, creatorKey: string): string {
  return supabase.storage.from(AVATAR_BUCKET).getPublicUrl(avatarStoragePath(creatorKey)).data
    .publicUrl;
}

export async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Expiry encoded in a signed CDN URL, in epoch ms, or null when the URL carries
 * no `x-expires` (some avatar URLs are unsigned — those we treat as usable).
 */
export function signedUrlExpiryMs(url: string | null | undefined): number | null {
  if (!url) return null;
  const m = /[?&]x-expires=(\d+)/.exec(url);
  if (!m) return null;
  return Number(m[1]) * 1000;
}

/**
 * Is this URL worth spending a request on? An already-expired signature is a
 * guaranteed 403, so the warmer skips it rather than burning a fetch and a
 * retry on it. Unsigned URLs (no x-expires) are treated as live — we cannot
 * tell, and the fetch itself is the cheapest way to find out.
 */
export function isSignedUrlLive(url: string | null | undefined, now = Date.now()): boolean {
  if (!url) return false;
  const exp = signedUrlExpiryMs(url);
  return exp === null ? true : exp > now;
}

export type CacheAvatarOutcome =
  | 'stored' // bytes are in Storage; publicUrl is permanent
  | 'fetch-failed' // origin refused or timed out (expired signature, usually)
  | 'upload-failed' // we have fresh bytes but Storage rejected the write
  | 'empty'; // origin returned a 200 with no usable body

export interface CacheAvatarResult {
  outcome: CacheAvatarOutcome;
  /** Permanent Storage URL for this creator (valid to serve once outcome === 'stored'). */
  publicUrl: string;
  /** Bytes written, when known. */
  bytes: number;
  /** HTTP status from the origin fetch, when we got that far. */
  status?: number;
  contentType?: string;
}

/**
 * Fetch an avatar from its (currently fresh) signed URL and store it under the
 * creator's stable key. Never throws — callers are a request handler that must
 * not 500 and a nightly job that must not fail the run, so every failure comes
 * back as an outcome.
 */
export async function cacheAvatar(
  supabase: SupabaseClient,
  creatorKey: string,
  srcUrl: string,
  timeoutMs = AVATAR_IMG_TIMEOUT_MS,
): Promise<CacheAvatarResult> {
  const path = avatarStoragePath(creatorKey);
  const publicUrl = avatarPublicUrl(supabase, creatorKey);

  let img: Response;
  try {
    img = await fetchWithTimeout(srcUrl, timeoutMs);
  } catch {
    return { outcome: 'fetch-failed', publicUrl, bytes: 0 };
  }
  if (!img.ok) return { outcome: 'fetch-failed', publicUrl, bytes: 0, status: img.status };

  let buf: Buffer;
  try {
    buf = Buffer.from(await img.arrayBuffer());
  } catch {
    return { outcome: 'fetch-failed', publicUrl, bytes: 0, status: img.status };
  }
  // Not an image, or implausibly large: same outcome as an empty body — a 200
  // with nothing usable in it. The stored type comes from the bytes, not from
  // the origin's header.
  const verdict = acceptableImage(buf);
  if (!verdict.ok) {
    return { outcome: 'empty', publicUrl, bytes: 0, status: img.status };
  }

  const contentType = verdict.contentType;
  const { error } = await supabase.storage
    .from(AVATAR_BUCKET)
    .upload(path, buf, { contentType, upsert: true, cacheControl: '31536000' });

  if (error) {
    return {
      outcome: 'upload-failed',
      publicUrl,
      bytes: buf.byteLength,
      status: img.status,
      contentType,
    };
  }
  return { outcome: 'stored', publicUrl, bytes: buf.byteLength, status: img.status, contentType };
}

export interface CachedAvatarListing {
  /** storage-name -> last-modified (epoch ms). */
  files: Map<string, number>;
  /** False when a page failed, so `files` is a partial view, not the truth. */
  complete: boolean;
  error?: string;
}

/**
 * Every cached avatar, as one bulk listing, so a batch caller can answer "is this
 * creator already cached, and how recently?" without a per-creator round trip
 * (the proxy's single-key `search` is the right shape for one request; it is the
 * wrong shape for several hundred).
 *
 * `complete` matters: a failed listing looks exactly like an empty bucket, and a
 * caller that cannot tell them apart silently re-fetches everything it already
 * had. Observed doing precisely that on 2026-07-30.
 */
export async function listCachedAvatars(
  supabase: SupabaseClient,
): Promise<CachedAvatarListing> {
  const files = new Map<string, number>();
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase.storage
      .from(AVATAR_BUCKET)
      .list(AVATAR_PREFIX, { limit: PAGE, offset });
    if (error) return { files, complete: false, error: error.message };
    if (!data || data.length === 0) break;
    for (const f of data) {
      const meta = f as unknown as { updated_at?: string; created_at?: string };
      const stamp = meta.updated_at || meta.created_at;
      files.set(f.name, stamp ? Date.parse(stamp) : 0);
    }
    if (data.length < PAGE) break;
  }
  return { files, complete: true };
}
