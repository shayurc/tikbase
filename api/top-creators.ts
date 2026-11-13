// Server-side creator leaderboard endpoint ("Top Affiliates").
//
// Reads the nightly aggregate written by pipeline/precompute-creators.ts into
// creator_rankings. Deliberately has NO live-compute fallback: the aggregation
// loads ~316k video rows and takes minutes, so computing it inside a request
// would hang the endpoint. A missing cache row is a 503 the page renders as a
// friendly "computes tonight" state.
//
// Mirrors api/top-products.ts: same resolveTier, same free-tier coercion before
// any lookup, same honest total, same private cache header.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { resolveTier as resolveSharedTier } from './_lib/resolve-tier.js';
import { createClient } from '@supabase/supabase-js';

interface CachedResult {
  creators: any[];
  computedAt: string | null;
  creatorCount: number;
  timestamp: number;
}

const cache = new Map<string, CachedResult>();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

function getAdminClient() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing Supabase env vars');
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// One implementation: api/_lib/resolve-tier.ts. This file used to carry its own
// copy of a security-relevant function (one of four), without the shared
// version's one-minute memo — so every request here paid two sequential auth
// round trips, measured at about 400ms, before any data was read.
async function resolveTier(req: VercelRequest): Promise<'free' | 'paid'> {
  try {
    return await resolveSharedTier(req, getAdminClient());
  } catch {
    return 'free';
  }
}

// Free tier sees the real top 5 of all/30d and nothing else. Coerced BEFORE the
// cache lookup so ?niche=&days=&page=&limit= cannot widen the response.
const FREE_NICHE = 'all';
const FREE_DAYS = 30;
const FREE_ROWS = 5;

// The windows precompute-creators.ts actually writes.
const VALID_DAYS = [7, 30];

async function readPrecomputed(
  nicheSlug: string,
  days: number,
): Promise<{ creators: any[]; computedAt: string | null; creatorCount: number } | null> {
  try {
    const supabase = getAdminClient();
    const { data, error } = await supabase
      .from('creator_rankings')
      .select('payload,computed_at,creator_count')
      .eq('cache_key', `creators:${nicheSlug}:${days}`)
      .maybeSingle();
    if (error || !data || !Array.isArray((data as any).payload)) return null;
    const payload = (data as any).payload as any[];
    return {
      creators: payload,
      computedAt: (data as any).computed_at ?? null,
      // The precompute stores only the top N; creator_count is how many were
      // actually ranked. Both are reported: `total` is what this endpoint can
      // serve (and what pagination/upsell must promise), `creatorCount` is the
      // true universe. Conflating them would either understate the dataset or
      // promise rows Pro cannot deliver.
      creatorCount: Number((data as any).creator_count) || payload.length,
    };
  } catch {
    return null;
  }
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  try {
    const tier = await resolveTier(req);

    let nicheSlug = (req.query.niche as string) || 'all';
    let days = parseInt((req.query.days as string) || '30', 10);
    let page = Math.max(1, parseInt((req.query.page as string) || '1', 10) || 1);
    let limit = Math.min(
      100,
      Math.max(1, parseInt((req.query.limit as string) || '50', 10) || 50),
    );

    if (tier === 'free') {
      nicheSlug = FREE_NICHE;
      days = FREE_DAYS;
      page = 1;
      limit = FREE_ROWS;
    }

    if (!VALID_DAYS.includes(days)) {
      return res.status(400).json({ error: 'Invalid days' });
    }

    const cacheKey = `${nicheSlug}:${days}`;
    const cached = cache.get(cacheKey);
    let creators: any[];
    let computedAt: string | null;
    let creatorCount: number;

    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      creators = cached.creators;
      computedAt = cached.computedAt;
      creatorCount = cached.creatorCount;
    } else {
      const pre = await readPrecomputed(nicheSlug, days);
      // No live-compute fallback by design — see the file header.
      if (!pre) {
        res.setHeader('Cache-Control', 'private, max-age=60');
        return res.status(503).json({
          error: 'leaderboard not computed yet',
          niche: nicheSlug,
          days,
        });
      }
      creators = pre.creators;
      computedAt = pre.computedAt;
      creatorCount = pre.creatorCount;
      cache.set(cacheKey, { creators, computedAt, creatorCount, timestamp: Date.now() });
    }

    const offset = (page - 1) * limit;
    // Per-user (tiered) responses must never be shared by the CDN, which caches
    // by URL and ignores auth — an edge-cached Pro payload would leak to free
    // callers. 'private' keeps it browser-only; creator_rankings keeps it fast.
    res.setHeader('Cache-Control', 'private, max-age=300');

    return res.json({
      creators: creators.slice(offset, offset + limit),
      total: creators.length, // honest servable count even when the page is truncated
      creatorCount,           // true number ranked, >= total
      page,
      limit,
      computedAt,
    });
  } catch (err: any) {
    console.error('top-creators error:', err?.message);
    return res.status(500).json({ error: 'Failed to fetch creators' });
  }
}
