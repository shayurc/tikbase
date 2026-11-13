// Lives under api/_lib, not shared/, and that is load-bearing.
//
// @vercel/node compiles each api/*.ts to api/*.js WITHOUT bundling its local
// imports, so an import of '../shared/resolve-tier' survived into the deployed
// function as a bare specifier pointing at a directory Vercel never shipped.
// Every endpoint that imported it died on cold start, in production, for days:
//
//   Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/var/task/shared/resolve-tier'
//     imported from /var/task/api/brand-profile.js
//
// Files under api/ are compiled and shipped; a leading underscore keeps this
// directory from being routed as functions. Imports of it carry an explicit
// .js extension because the deployed importer is ESM and Node will not guess.

/**
 * resolve-tier.ts — server-side entitlement gate.
 *
 * Lifted verbatim from api/top-products.ts so the two 1c endpoints do not become
 * the fourth and fifth copy of a security-relevant function. Behaviour is
 * identical, deliberately:
 *   - the tier comes from the caller's Bearer token, never from a query param,
 *   - NO Stripe calls on the data path (app_metadata is the source of truth),
 *   - any missing/invalid token or lookup failure degrades to 'free'. A data
 *     request is never 401'd; it is answered with the free slice.
 *
 * The three shipped endpoints (top-products, top-creators, check-subscription)
 * still carry their own copies. Migrating them is mechanical but touches live
 * paid-gating, so it is left as a follow-up rather than bundled into a feature
 * PR.
 */
import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { appleRecordActive } from './apple-subscription.js';

export type Tier = 'free' | 'paid';

/** Stripe subscription statuses that count as paying. Exported so the checkout
 *  guard and the tier gate cannot disagree about who already has a plan. */
export const ACTIVE_STATUSES = new Set(['active', 'trialing', 'past_due']);

/**
 * The one answer to "is this account Pro?". Two records can say yes: the
 * Stripe subscription the website sells, and the Apple subscription the
 * iPhone app sells (see apple-subscription.ts for why they are kept apart).
 * Every gate asks here so the two cannot be honoured in one place and
 * forgotten in another.
 */
export function hasPaidAccess(appMetadata: unknown, now: number = Date.now()): boolean {
  const meta = appMetadata as Record<string, any> | null | undefined;
  const status = meta?.subscription?.status;
  if (status && ACTIVE_STATUSES.has(status)) return true;
  return appleRecordActive(meta?.apple_subscription, now);
}

/**
 * Short-lived token -> tier memo.
 *
 * The two auth round trips below are sequential and measured ~400ms together,
 * which was the entire gap between the anon profile (p95 429ms) and the paid one
 * (p95 844ms) — the database work is ~25ms. Memoising for a minute puts a repeat
 * viewer's tier lookup at zero round trips.
 *
 * TTL is deliberately short: a subscription that changes mid-session is visible
 * within 60s. Keyed by a hash so raw bearer tokens are not held in memory, and
 * per-instance like the search rate limiter, which is fine — a cold start just
 * re-resolves.
 */
const TIER_TTL_MS = 60_000;
/**
 * 'free' is remembered for far less time than 'paid'.
 *
 * The moment that matters is the upgrade. Someone looks at the free slice,
 * pays, and comes back seconds later with the SAME token: a 'free' answer
 * memoised for a minute meant the next requests still got the free slice, and
 * the product looked like it had taken their money and unlocked nothing. In
 * the iPhone app the purchase sheet takes about fifteen seconds, so this was
 * the normal case there, not an edge.
 *
 * Ten seconds still spares a free visitor's page load its repeat lookups (a
 * page fires several requests at once). Paid keeps the full minute: a
 * cancellation showing up a minute late costs nothing.
 */
const FREE_TIER_TTL_MS = 10_000;
const tierCache = new Map<string, { tier: Tier; expiresAt: number }>();

function tokenKey(token: string): string {
  return createHash('sha256').update(token).digest('base64');
}

/** Only the shape actually read, so this stays free of @vercel/node. */
export interface TierRequest {
  headers: { authorization?: string | string[] };
}

export async function resolveTier(
  req: TierRequest,
  admin: SupabaseClient,
): Promise<Tier> {
  try {
    const raw = req.headers.authorization;
    const authHeader = Array.isArray(raw) ? raw[0] : raw || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) return 'free';

    const now = Date.now();
    const key = tokenKey(token);
    const memo = tierCache.get(key);
    if (memo && now < memo.expiresAt) return memo.tier;

    const { data: authData, error: authError } = await admin.auth.getUser(token);
    if (authError || !authData.user) return 'free';
    const { data, error } = await admin.auth.admin.getUserById(authData.user.id);
    if (error || !data.user) return 'free';
    const tier: Tier = hasPaidAccess(data.user.app_metadata) ? 'paid' : 'free';

    // Only successful resolutions are memoised. A failure path returns 'free'
    // without caching, so a transient auth blip cannot pin a paying customer to
    // the free tier for a minute.
    if (tierCache.size > 5000) {
      for (const [k, v] of tierCache) if (now >= v.expiresAt) tierCache.delete(k);
    }
    tierCache.set(key, {
      tier,
      expiresAt: now + (tier === 'paid' ? TIER_TTL_MS : FREE_TIER_TTL_MS),
    });
    return tier;
  } catch {
    return 'free';
  }
}
