// Server-side video ranking endpoint. Pre-computes the heavy
// video-fetching + snowflake-filtering + product-joining that was
// previously done in the browser (42K rows per page load).
//
// Caches results for 1 hour since data only changes daily.
// Returns paginated results for a given niche + timeframe.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { resolveTier as resolveSharedTier } from './_lib/resolve-tier.js';
import { createClient } from '@supabase/supabase-js';
import { readAllByKey, forEachKeyPage, plausiblePostDate } from './_lib/paging.js';

interface CachedResult {
  videos: any[];
  timestamp: number;
}

// In-memory cache: key = "niche:days", value = enriched video list
const cache = new Map<string, CachedResult>();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

function extractPostDate(videoUrl: string): Date | null {
  const match = videoUrl?.match(/video\/(\d+)/);
  if (!match) return null;
  try {
    const videoId = BigInt(match[1]);
    const timestamp = Number(videoId >> 32n);
    const date = new Date(timestamp * 1000);
    if (!plausiblePostDate(date)) return null;
    return date;
  } catch {
    return null;
  }
}

function getAdminClient() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing Supabase env vars');
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Read the daily precomputed video ranking written by
// pipeline/precompute-rankings.ts. Returns null if not present yet so the
// handler falls back to live computation.
async function readPrecomputed(nicheSlug: string, days: number): Promise<any[] | null> {
  try {
    const supabase = getAdminClient();
    const { data, error } = await supabase
      .from('rankings_cache')
      .select('payload')
      .eq('cache_key', `videos:${nicheSlug}:${days}`)
      .maybeSingle();
    if (error || !data || !Array.isArray((data as any).payload)) return null;
    return (data as any).payload as any[];
  } catch {
    return null;
  }
}

/** Longest window the app offers; nothing older is ever ranked. */
const MAX_WINDOW_DAYS = 365;
// Only what the payload uses. `select('*')` also dragged discovery_source,
// like_count, ad_label, posted_at, video_id and post_ts across the wire for
// every one of 650k rows. `id` is here to page by and is dropped after.
const VIDEO_COLUMNS =
  'id,product_id,video_url,view_count,author_name,author_avatar_url,creator_key,cover_image_url,created_at';

export interface PooledVideo {
  product_id: string;
  video_url: string;
  view_count: number | null;
  postedAt: number;
  [column: string]: unknown;
}

/**
 * Raw rows -> one entry per video, dated, newest-window-first is NOT applied
 * here. Rows with no TikTok id in the URL, an implausible post time, or a post
 * time older than the longest window are dropped. Where the same video appears
 * on several rows (one per product it promotes), the most-viewed row wins —
 * what the old view_count-ordered read did implicitly.
 */
export function videoPoolBuilder(now: number = Date.now()) {
  const oldest = now - MAX_WINDOW_DAYS * 86400000;
  const best = new Map<string, PooledVideo>();
  return {
    /** Fold a page in. Rows are reduced as they arrive, so the raw table is
     *  never held in memory — only the videos that can still be ranked. */
    add(rows: any[]) {
      for (const row of rows) {
        const vidId = row.video_url?.match(/video\/(\d+)/)?.[1];
        if (!vidId) continue;
        const posted = extractPostDate(row.video_url);
        if (!posted) continue;
        const postedAt = posted.getTime();
        if (postedAt < oldest) continue;
        const prev = best.get(vidId);
        if (prev && (prev.view_count || 0) >= (row.view_count || 0)) continue;
        const { id: _id, ...rest } = row;
        best.set(vidId, { ...rest, postedAt });
      }
    },
    finish(): PooledVideo[] {
      return [...best.values()];
    },
  };
}

export function buildVideoPool(rows: any[], now: number = Date.now()): PooledVideo[] {
  const builder = videoPoolBuilder(now);
  builder.add(rows);
  return builder.finish();
}

/** The videos of one window, most-viewed first. */
export function rankVideoWindow(pool: PooledVideo[], days: number, now: number = Date.now()): PooledVideo[] {
  const cutoff = now - days * 86400000;
  return pool
    .filter((v) => v.postedAt >= cutoff)
    .sort((a, b) => (b.view_count || 0) - (a.view_count || 0));
}

/**
 * Every video of a niche, read ONCE.
 *
 * The nightly precompute asks for six windows per niche, one after another,
 * and each call used to read the niche's videos from scratch — for 'all', the
 * whole table six times. The window is only a filter on the post date, which
 * is in the row. So the rows are read once, kept for the niche being worked
 * on, and each window is a filter over them in memory.
 *
 * That is also what pays for reading every row (the 1000-row cap fix): one
 * complete read per niche is fewer rows than six capped ones.
 *
 * One niche is held at a time, so memory is bounded by the largest niche.
 */
const POOL_TTL = 15 * 60 * 1000;
let pooled: { niche: string; loadedAt: number; videos: Promise<PooledVideo[]> } | null = null;

async function readNicheVideos(nicheSlug: string): Promise<PooledVideo[]> {
  const supabase = getAdminClient();
  const pool = videoPoolBuilder();

  if (nicheSlug === 'all') {
    await forEachKeyPage<any>(
      (last, size) => {
        let q = supabase.from('product_videos').select(VIDEO_COLUMNS).order('id', { ascending: true }).limit(size);
        if (last) q = q.gt('id', last);
        return q;
      },
      (r) => r.id,
      (page) => pool.add(page),
      { what: 'product_videos (all niches)' },
    );
  } else {
    // Products with sales in this niche. Ordered, so pages cannot overlap, and
    // a failed page throws rather than quietly shrinking the niche.
    const products = await readAllByKey<any>(
      (last, size) => {
        let q = supabase
          .from('products')
          .select('product_id')
          .eq('niche_slug', nicheSlug)
          .gt('sold_count', 0)
          .order('product_id', { ascending: true })
          .limit(size);
        if (last) q = q.gt('product_id', last);
        return q;
      },
      (r) => r.product_id,
      { what: `products (${nicheSlug})` },
    );
    const productIds: string[] = products.map((p) => p.product_id);

    // The old read asked for `.limit(5000)` per 150-product batch and silently
    // received 1000 — the most-viewed of all time — before the window filter
    // ran, so recent videos were crowded out by old ones.
    for (let i = 0; i < productIds.length; i += 150) {
      const batch = productIds.slice(i, i + 150);
      await forEachKeyPage<any>(
        (last, size) => {
          let q = supabase
            .from('product_videos')
            .select(VIDEO_COLUMNS)
            .in('product_id', batch)
            .order('id', { ascending: true })
            .limit(size);
          if (last) q = q.gt('id', last);
          return q;
        },
        (r) => r.id,
        (page) => pool.add(page),
        { what: `product_videos (${nicheSlug}, batch ${i / 150})` },
      );
    }
  }

  return pool.finish();
}

function nicheVideoPool(nicheSlug: string): Promise<PooledVideo[]> {
  const now = Date.now();
  if (pooled && pooled.niche === nicheSlug && now - pooled.loadedAt < POOL_TTL) {
    return pooled.videos;
  }
  const entry = { niche: nicheSlug, loadedAt: now, videos: readNicheVideos(nicheSlug) };
  pooled = entry;
  // A failed read must not be served to the next window as if it were the pool.
  entry.videos.catch(() => {
    if (pooled === entry) pooled = null;
  });
  return entry.videos;
}

export async function computeTopVideos(nicheSlug: string, days: number): Promise<any[]> {
  const supabase = getAdminClient();
  const filtered = rankVideoWindow(await nicheVideoPool(nicheSlug), days);

  // Step 5: Fetch product details for filtered videos
  const videoProductIds = [...new Set(filtered.map((v: any) => v.product_id))] as string[];
  const productsMap: Record<string, any> = {};

  for (let i = 0; i < videoProductIds.length; i += 200) {
    const batch = videoProductIds.slice(i, i + 200);
    const { data, error } = await supabase
      .from('products')
      .select('product_id, title, niche_slug, niche_label, image_url, sale_price, sold_count, product_url')
      .in('product_id', batch);
    // A failed batch used to drop its videos from the ranking without a word.
    if (error) throw new Error(`products for videos (${nicheSlug}, batch ${i / 200}): ${error.message}`);
    if (data) data.forEach((p: any) => { productsMap[p.product_id] = p; });
  }

  // Step 6: Build final list — only videos with real products that have sales
  const enriched = filtered
    .map((v: any) => {
      const product = productsMap[v.product_id];
      if (!product) return null;
      if (product.title?.includes('Discovered Videos')) return null;
      if ((product.sold_count ?? 0) <= 0) return null;
      return {
        product_id: v.product_id,
        video_url: v.video_url,
        view_count: v.view_count,
        author_name: v.author_name,
        // The signed CDN url is kept for compatibility with payloads written
        // before this change, but it 403s within a day of being captured —
        // measured 20 of 20 rows dead. creator_key is what the client should
        // use: /api/avatar?key= serves stored bytes and always renders.
        author_avatar_url: v.author_avatar_url,
        creator_key: v.creator_key ?? null,
        cover_image_url: v.cover_image_url,
        created_at: v.created_at,
        product,
      };
    })
    .filter(Boolean);

  return enriched;
}

// Server-side entitlement gate. Resolve the caller's tier from their Bearer
// token (lightweight verification copied from check-subscription.ts; NO Stripe
// calls on the data path). Any missing/invalid token degrades to 'free' — we
// never 401 a data request.
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

// Free tier: real top 10 on fresh 7-day data, 'all' niche only.
const FREE_NICHE = 'all';
const FREE_DAYS = 7;
const FREE_ROWS = 10;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const tier = await resolveTier(req);

    let nicheSlug = (req.query.niche as string) || 'all';
    let days = parseInt((req.query.days as string) || '7', 10);
    let page = Math.max(1, parseInt((req.query.page as string) || '1', 10) || 1);
    let limit = Math.min(100, Math.max(1, parseInt((req.query.limit as string) || '50', 10) || 50));

    // Free-tier coercion BEFORE cache/compute lookup: pin to all/7d/top-10
    // regardless of query params (blocks the ?page=&limit= bypass).
    if (tier === 'free') {
      nicheSlug = FREE_NICHE;
      days = FREE_DAYS;
      page = 1;
      limit = FREE_ROWS;
    }

    // Validate
    if (![7, 14, 30, 90, 180, 365].includes(days)) {
      return res.status(400).json({ error: 'Invalid days parameter' });
    }

    const cacheKey = `${nicheSlug}:${days}`;
    const cached = cache.get(cacheKey);

    let videos: any[];
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      videos = cached.videos;
    } else {
      // Prefer the daily precomputed ranking (instant); fall back to live
      // computation only for combos not yet precomputed.
      const pre = await readPrecomputed(nicheSlug, days);
      videos = pre ?? (await computeTopVideos(nicheSlug, days));
      cache.set(cacheKey, { videos, timestamp: Date.now() });
    }

    const offset = (page - 1) * limit;
    const paginated = videos.slice(offset, offset + limit);

    // Per-user (tiered) responses must never be shared by the CDN, which caches
    // by URL and ignores auth. 'private' keeps it browser-only.
    res.setHeader('Cache-Control', 'private, max-age=300');

    return res.json({
      videos: paginated,
      total: videos.length, // honest full count even when the page is truncated
      page,
      limit,
    });
  } catch (err: any) {
    console.error('top-videos error:', err?.message);
    return res.status(500).json({ error: 'Failed to fetch videos' });
  }
}
