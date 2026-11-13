// Server-side video ranking endpoint. Pre-computes the heavy
// video-fetching + snowflake-filtering + product-joining that was
// previously done in the browser (42K rows per page load).
//
// Caches results for 1 hour since data only changes daily.
// Returns paginated results for a given niche + timeframe.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { readAllPages, plausiblePostDate } from './_lib/paging.js';

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

export async function computeTopVideos(nicheSlug: string, days: number): Promise<any[]> {
  const supabase = getAdminClient();

  const cutoffDate = new Date(Date.now() - days * 86400000);

  // Step 1: Get product_ids with sold_count > 0 for the niche
  let productIds: string[] = [];
  if (nicheSlug !== 'all') {
    let offset = 0;
    while (true) {
      const { data } = await supabase
        .from('products')
        .select('product_id')
        .eq('niche_slug', nicheSlug)
        .gt('sold_count', 0)
        .range(offset, offset + 999);
      if (!data || data.length === 0) break;
      productIds = productIds.concat(data.map((p: any) => p.product_id));
      if (data.length < 1000) break;
      offset += 1000;
    }
  }

  // Step 2: Fetch all videos (for "all") or niche videos
  let allVideos: any[] = [];
  // Every read below goes through readAllPages. The niche branch used to ask
  // for `.limit(5000)` per 150-product batch and silently receive 1000 — the
  // most-viewed of all time — before the window filter ran, so recent videos
  // were crowded out by old ones. Both branches also sorted on view_count
  // alone, which is not a total order: rows that tie can repeat or go missing
  // between pages. video_url breaks the tie.
  if (nicheSlug === 'all') {
    allVideos = await readAllPages<any>(
      (from, to) =>
        supabase
          .from('product_videos')
          .select('*')
          .order('view_count', { ascending: false })
          .order('video_url', { ascending: true })
          .range(from, to),
      { what: 'product_videos (all niches)' },
    );
  } else {
    // Batch by product_ids
    for (let i = 0; i < productIds.length; i += 150) {
      const batch = productIds.slice(i, i + 150);
      const rows = await readAllPages<any>(
        (from, to) =>
          supabase
            .from('product_videos')
            .select('*')
            .in('product_id', batch)
            .order('view_count', { ascending: false })
            .order('video_url', { ascending: true })
            .range(from, to),
        { what: `product_videos (${nicheSlug}, batch ${i / 150})` },
      );
      allVideos = allVideos.concat(rows);
    }
  }

  // Step 3: Dedup by video ID
  const seen = new Set<string>();
  const deduped = allVideos.filter((v: any) => {
    const vidId = v.video_url?.match(/video\/(\d+)/)?.[1];
    if (!vidId || seen.has(vidId)) return false;
    seen.add(vidId);
    return true;
  });

  // Step 4: Filter by snowflake post date
  const filtered = deduped
    .filter((v: any) => {
      const postDate = extractPostDate(v.video_url);
      if (!postDate) return false;
      return postDate >= cutoffDate;
    })
    .sort((a: any, b: any) => (b.view_count || 0) - (a.view_count || 0));

  // Step 5: Fetch product details for filtered videos
  const videoProductIds = [...new Set(filtered.map((v: any) => v.product_id))] as string[];
  const productsMap: Record<string, any> = {};

  for (let i = 0; i < videoProductIds.length; i += 200) {
    const batch = videoProductIds.slice(i, i + 200);
    const { data } = await supabase
      .from('products')
      .select('product_id, title, niche_slug, niche_label, image_url, sale_price, sold_count, product_url')
      .in('product_id', batch);
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
const ACTIVE_STATUSES = new Set(['active', 'trialing', 'past_due']);
async function resolveTier(req: VercelRequest): Promise<'free' | 'paid'> {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) return 'free';
    const supabase = getAdminClient();
    const { data: authData, error: authError } = await supabase.auth.getUser(token);
    if (authError || !authData.user) return 'free';
    const { data, error } = await supabase.auth.admin.getUserById(authData.user.id);
    if (error || !data.user) return 'free';
    const sub = (data.user.app_metadata as any)?.subscription;
    return sub?.status && ACTIVE_STATUSES.has(sub.status) ? 'paid' : 'free';
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
