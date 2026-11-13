/**
 * precompute-creators.ts
 *
 * Precomputes the creator leaderboard ("top affiliates by GMV") for every
 * niche × window and stores each result in the `creator_rankings` table, so the
 * 1b read path is an instant table read — the same shape as rankings_cache /
 * api/top-products.
 *
 * Reads only from Supabase (product_videos, products, rankings_cache). Makes
 * ZERO ScrapeCreators calls and therefore costs no API credits; it can be run
 * at any time.
 *
 * Usage:
 *   tsx --env-file=.env pipeline/precompute-creators.ts              # all combos, writes
 *   tsx --env-file=.env pipeline/precompute-creators.ts --dry-run    # READ-ONLY, prints top 10 for all:30
 *   tsx --env-file=.env pipeline/precompute-creators.ts --dry-run 7  # dry-run a specific window
 *
 * Requires migrations/manual/2026-07-28-creators.sql to have been applied.
 */
import { createClient } from '@supabase/supabase-js';
import { deriveCreatorKey } from '../shared/creator-key';
import { warmAvatars, formatWarmStats, WARM_TOP_N_PER_PAYLOAD } from './warm-avatars';

const NICHE_SLUGS = [
  'all', 'beauty-skincare', 'gym-fitness', 'health-wellness', 'mens-wear',
  'womens-wear', 'tech-gadgets', 'pet-products', 'home-kitchen', 'food-beverage',
  'shoes-footwear', 'accessories-jewelry', 'baby-kids', 'toys-games', 'fragrance',
  'makeup', 'supplements', 'mens-grooming', 'haircare', 'collectibles',
];
// The leaderboard windows. Both must exist as products:<niche>:<days> keys in
// rankings_cache, because that is where per-product revenue is sourced.
const WINDOWS = [7, 30];
const STORE_TOP_N_CREATORS = 400;
const TOP_PRODUCTS_PER_CREATOR = 5;
const PAGE = 1000;

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

interface VideoRow {
  creator_key: string;
  product_id: string;
  video_id: string | null;
  view_count: number | null;
  posted_at: string | null;
  ad_label: string | null;
}
interface CreatorRow {
  creator_key: string;
  display_name: string | null;
  avatar_url: string | null;
  handle: string | null;
  author_id: string | null;
}
interface ProductRow {
  product_id: string;
  niche_slug: string | null;
  title: string | null;
}
interface RevenueEntry {
  estRevenue: number;
  hasRealDelta: boolean;
}

// A commissioned video. Matches the TikTok disclosure badge stored in ad_label
// (verified live 2026-07-27: the payload field is bc_ad_label_text, and the
// dominant value by far is "Creator earns commission").
function isCommissioned(adLabel: string | null): boolean {
  return /commission/i.test(adLabel || '');
}

// Post date for a video. posted_at is only populated on related_videos rows
// (73,724 of 196,105 = 37.6%), so the rest fall back to the video-id snowflake:
// timestamp = (id >> 32) as unix seconds.
//
// Validated 2026-07-28 against the 73,724 rows carrying BOTH values — on a
// 1,000-row unbiased sample, 87.5% agree within 60s, 98.8% within a day, and
// 97.9% land on the same UTC date. That is sufficient for day-granularity
// windowing, which is the only thing this is used for.
function postDate(v: VideoRow): Date | null {
  if (v.posted_at) {
    const t = Date.parse(v.posted_at);
    if (!Number.isNaN(t)) return new Date(t);
  }
  if (v.video_id && /^[0-9]{10,}$/.test(v.video_id)) {
    try {
      const secs = Number(BigInt(v.video_id) >> 32n);
      const d = new Date(secs * 1000);
      const y = d.getUTCFullYear();
      if (y >= 2016 && y <= 2030) return d;
    } catch {
      /* fall through */
    }
  }
  return null;
}

// Keyset pagination on a unique orderable column. OFFSET degrades badly past a
// few thousand rows on these tables, and product_videos is ~196k.
async function pageAll<T>(
  table: string,
  select: string,
  orderCol: string,
  tweak?: (q: any) => any,
): Promise<T[]> {
  const out: T[] = [];
  let last = '';
  while (true) {
    let q = supabase.from(table).select(select).order(orderCol, { ascending: true }).limit(PAGE);
    if (last) q = q.gt(orderCol, last);
    if (tweak) q = tweak(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data || data.length === 0) break;
    out.push(...(data as any as T[]));
    last = (data[data.length - 1] as any)[orderCol];
    if (data.length < PAGE) break;
  }
  return out;
}

// Re-exported for the existing callers of this module. The definition moved to
// shared/creator-key.ts once the avatar warmer needed the same rule — see the
// docblock there for why it must exist exactly once.
export { deriveCreatorKey };

// Per-product revenue for a window, sourced from the rankings_cache payload that
// precompute-rankings.ts already wrote. v1 covers RANKED products only: a
// product absent from the payload contributes 0 GMV, which means creators who
// only promote unranked products score 0. Stated rather than hidden — closing it
// needs a revenue model for the whole catalogue, not just the top 400 per niche.
async function loadRevenuePayload(
  cacheKey: string,
  opts: { allowMissing?: boolean } = {},
): Promise<Map<string, RevenueEntry>> {
  const m = new Map<string, RevenueEntry>();
  const { data, error } = await supabase
    .from('rankings_cache')
    .select('payload')
    .eq('cache_key', cacheKey)
    .maybeSingle();
  // An unreadable or missing payload used to return an empty map, which the
  // ranking below reads as "every product earned $0": one timeout on this read
  // published a leaderboard of creators at zero GMV, logged as a success, for
  // 24 hours. Throwing fails this one combo instead, and the previous
  // leaderboard for it stays in place.
  if (error) throw new Error(`revenue payload ${cacheKey} unreadable: ${error.message}`);
  if (!data || !Array.isArray((data as any).payload)) {
    // The 'all' union tolerates a niche with no row (it contributes nothing,
    // as documented below). A read ERROR is never tolerated: that is unknown,
    // not empty.
    if (opts.allowMissing) return m;
    throw new Error(`revenue payload ${cacheKey} is missing — product rankings must be precomputed first`);
  }
  for (const p of (data as any).payload) {
    const pid = p?.product_id;
    if (!pid) continue;
    const met = p?.metrics || {};
    m.set(String(pid), {
      estRevenue: Number(met.estRevenue) || 0,
      hasRealDelta: Boolean(met.hasRealDelta),
    });
  }
  return m;
}

async function loadRevenue(niche: string, days: number): Promise<Map<string, RevenueEntry>> {
  if (niche !== 'all') return loadRevenuePayload(`products:${niche}:${days}`);

  // 'all' is NOT products:all:<days>. That payload is the global top 400 by
  // revenue, which covers only a fraction of the products that are ranked
  // somewhere: measured 2026-07-29 at 30d, products:all:30 held 400 products
  // ($63.7M) while the union of the per-niche payloads held 5,600 ($137.4M) —
  // 5,252 products worth $81.1M were ranked in a niche but invisible to the
  // global payload, i.e. only 6.2% coverage.
  //
  // Sourcing 'all' from that payload made a creator who tops a narrow niche
  // score real GMV on their niche board and $0 on All Categories — which is the
  // default view, and the only view free tier gets. Union the per-niche
  // payloads instead so 'all' is a superset of every niche, as its name implies.
  //
  // Products cannot double-count: the map is keyed by product_id, and a product
  // carries one niche_slug, so it appears in exactly one niche payload.
  const merged = new Map<string, RevenueEntry>();
  for (const n of NICHE_SLUGS) {
    if (n === 'all') continue;
    const m = await loadRevenuePayload(`products:${n}:${days}`, { allowMissing: true });
    for (const [pid, entry] of m) {
      // Keep the higher revenue if a product somehow appears twice, so the
      // union can never under-report relative to any single niche.
      const prev = merged.get(pid);
      if (!prev || entry.estRevenue > prev.estRevenue) merged.set(pid, entry);
    }
  }
  // Fold in the global payload too: it can contain a product whose niche
  // payload was missing or failed to compute.
  const globalPayload = await loadRevenuePayload(`products:all:${days}`, { allowMissing: true });
  for (const [pid, entry] of globalPayload) {
    const prev = merged.get(pid);
    if (!prev || entry.estRevenue > prev.estRevenue) merged.set(pid, entry);
  }
  return merged;
}

interface CreatorAgg {
  creator_key: string;
  videos_posted: number;
  views_on_window_videos: number;
  commissioned_videos: number;
  products: Map<string, { views: number; videos: number }>;
}

/**
 * Compute the leaderboard for one niche × window.
 *
 * GMV ATTRIBUTION — this is a MODELLED number, not measured revenue.
 * For each product, the window's estimated revenue is split across the creators
 * who posted about it in that window, in proportion to their share of views on
 * that product's window videos:
 *
 *   creator_gmv = SUM over products of
 *                 productRevenue[p] * (creatorViewsOnP / allCreatorViewsOnP)
 *
 * Both view terms are LIFETIME view counts on videos POSTED IN THE WINDOW — we
 * do not snapshot view history, so a window's "views" cannot mean views accrued
 * during the window. gmv_confidence reports the share of a creator's attributed
 * GMV that came from products whose revenue was backed by a real snapshot delta
 * (hasRealDelta) rather than the estimator.
 */
function computeLeaderboard(
  videos: VideoRow[],
  creators: Map<string, CreatorRow>,
  productNiche: Map<string, ProductRow>,
  revenue: Map<string, RevenueEntry>,
  niche: string,
  days: number,
  now: number,
): any[] {
  const cutoff = now - days * 86400000;

  // 1. Window videos, restricted to the niche when one is requested.
  const inWindow: { v: VideoRow; views: number }[] = [];
  for (const v of videos) {
    if (!v.creator_key) continue;
    if (niche !== 'all') {
      const p = productNiche.get(v.product_id);
      if (!p || p.niche_slug !== niche) continue;
    }
    const d = postDate(v);
    if (!d) continue;
    const t = d.getTime();
    if (t < cutoff || t > now) continue;
    inWindow.push({ v, views: Math.max(0, v.view_count || 0) });
  }

  // 2. Denominator for attribution: all window views per product.
  const productWindowViews = new Map<string, number>();
  for (const { v, views } of inWindow) {
    productWindowViews.set(v.product_id, (productWindowViews.get(v.product_id) || 0) + views);
  }

  // 3. Fold per creator.
  const aggs = new Map<string, CreatorAgg>();
  for (const { v, views } of inWindow) {
    let a = aggs.get(v.creator_key);
    if (!a) {
      a = {
        creator_key: v.creator_key,
        videos_posted: 0,
        views_on_window_videos: 0,
        commissioned_videos: 0,
        products: new Map(),
      };
      aggs.set(v.creator_key, a);
    }
    a.videos_posted++;
    a.views_on_window_videos += views;
    if (isCommissioned(v.ad_label)) a.commissioned_videos++;
    const pe = a.products.get(v.product_id) || { views: 0, videos: 0 };
    pe.views += views;
    pe.videos++;
    a.products.set(v.product_id, pe);
  }

  // 4. Attribute GMV and shape the payload rows.
  const out: any[] = [];
  for (const a of aggs.values()) {
    let gmv = 0;
    let gmvReal = 0;
    for (const [pid, pe] of a.products) {
      const rev = revenue.get(pid);
      if (!rev || rev.estRevenue <= 0) continue; // unranked product -> 0, by design
      const denom = productWindowViews.get(pid) || 0;
      if (denom <= 0) continue;
      const share = pe.views / denom;
      const attributed = rev.estRevenue * share;
      gmv += attributed;
      if (rev.hasRealDelta) gmvReal += attributed;
    }

    // dominant_niche: mode of the promoted products' niche_slug.
    const nicheCount = new Map<string, number>();
    for (const pid of a.products.keys()) {
      const ns = productNiche.get(pid)?.niche_slug;
      if (ns) nicheCount.set(ns, (nicheCount.get(ns) || 0) + 1);
    }
    let dominantNiche: string | null = null;
    let best = 0;
    for (const [ns, n] of nicheCount) {
      if (n > best) {
        best = n;
        dominantNiche = ns;
      }
    }

    const topProducts = [...a.products.entries()]
      .sort((x, y) => y[1].views - x[1].views)
      .slice(0, TOP_PRODUCTS_PER_CREATOR)
      .map(([pid, pe]) => ({
        product_id: pid,
        title: productNiche.get(pid)?.title ?? null,
        niche_slug: productNiche.get(pid)?.niche_slug ?? null,
        videos: pe.videos,
        views: pe.views,
      }));

    const c = creators.get(a.creator_key);
    out.push({
      creator_key: a.creator_key,
      display_name: c?.display_name ?? null,
      avatar_url: c?.avatar_url ?? null,
      handle: c?.handle ?? null,
      author_id: c?.author_id ?? null,
      metrics: {
        // MODELLED — see computeLeaderboard docblock.
        attributedGmv: Math.round(gmv * 100) / 100,
        // Share of attributedGmv from products with a real snapshot delta.
        gmvConfidence: gmv > 0 ? Math.round((gmvReal / gmv) * 1000) / 1000 : 0,
        videosPosted: a.videos_posted,
        distinctProducts: a.products.size,
        // LIFETIME views on videos POSTED IN THE WINDOW — not views accrued
        // during the window. We do not snapshot view history.
        viewsOnWindowVideos: a.views_on_window_videos,
        affiliateIntensity:
          a.videos_posted > 0
            ? Math.round((a.commissioned_videos / a.videos_posted) * 1000) / 1000
            : 0,
        dominantNiche,
      },
      topProducts,
    });
  }

  out.sort((x, y) => y.metrics.attributedGmv - x.metrics.attributedGmv);
  return out;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const argWindow = process.argv.slice(2).find((a) => /^\d+$/.test(a));
  const started = Date.now();

  // Guard: the migration creates creator_rankings. A write run without it would
  // half-run, so bail. A dry run does not write, and derives keys itself, so it
  // is allowed to proceed pre-migration — that is how the aggregation is
  // verified against production before any DDL is applied.
  const probe = await supabase.from('creator_rankings').select('cache_key').limit(1);
  const migrated = !probe.error;
  if (!migrated) {
    const msg =
      `creator_rankings is not queryable: ${probe.error?.message}\n` +
      `  Run migrations/manual/2026-07-28-creators.sql in the Supabase SQL editor.`;
    if (!dryRun) {
      console.error(`\n  ${'!'.repeat(60)}\n  ${msg}\n  ${'!'.repeat(60)}\n`);
      process.exit(1);
    }
    console.log(`  [pre-migration dry run] ${msg}`);
    console.log('  Deriving creator_key from video_url in memory instead.\n');
  }

  console.log('Loading creators, products and videos from Supabase...');
  const t0 = Date.now();

  const creators = new Map<string, CreatorRow>();
  if (migrated) {
    const creatorRows = await pageAll<CreatorRow>(
      'creators',
      'creator_key,display_name,avatar_url,handle,author_id',
      'creator_key',
    );
    for (const c of creatorRows) creators.set(c.creator_key, c);
  }

  const productRows = await pageAll<ProductRow & { id: string }>(
    'products',
    'id,product_id,niche_slug,title',
    'id',
  );
  const productNiche = new Map<string, ProductRow>();
  for (const p of productRows) productNiche.set(p.product_id, p);

  // Pre-migration the creator_key column does not exist, so select video_url and
  // derive. Post-migration read the stored column and skip unkeyed rows.
  const videoSelect = migrated
    ? 'id,creator_key,product_id,video_id,view_count,posted_at,ad_label'
    : 'id,video_url,product_id,video_id,view_count,posted_at,ad_label,author_name,author_avatar_url';
  const rawVideos = await pageAll<any>(
    'product_videos',
    videoSelect,
    'id',
    migrated ? (q) => q.not('creator_key', 'is', null) : undefined,
  );

  const videoRows: VideoRow[] = [];
  for (const r of rawVideos) {
    const ck = migrated ? r.creator_key : deriveCreatorKey(r.video_url);
    if (!ck) continue;
    videoRows.push({
      creator_key: ck,
      product_id: r.product_id,
      video_id: r.video_id,
      view_count: r.view_count,
      posted_at: r.posted_at,
      ad_label: r.ad_label,
    });
    // Pre-migration, synthesise the creator row the migration would have built:
    // newest-seen display name and avatar.
    if (!migrated && !creators.has(ck)) {
      creators.set(ck, {
        creator_key: ck,
        display_name: r.author_name ?? null,
        avatar_url: r.author_avatar_url ?? null,
        handle: ck.startsWith('id:') ? null : ck,
        author_id: ck.startsWith('id:') ? ck.slice(3) : null,
      });
    }
  }

  console.log(
    `  loaded ${creators.size} creators, ${productNiche.size} products, ` +
    `${videoRows.length} keyed videos (of ${rawVideos.length} rows) ` +
    `in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );

  const now = Date.now();
  const windows = argWindow ? [Number(argWindow)] : WINDOWS;

  if (dryRun) {
    const days = windows[0] ?? 30;
    const ni = process.argv.indexOf('--niche');
    const dryNiche = ni >= 0 ? process.argv[ni + 1] : 'all';
    const revenue = await loadRevenue(dryNiche, days);
    const realDeltaProducts = [...revenue.values()].filter((r) => r.hasRealDelta).length;
    const ranked = computeLeaderboard(
      videoRows, creators, productNiche, revenue, dryNiche, days, now,
    );
    console.log(
      `\n=== DRY RUN (no writes) — creators:${dryNiche}:${days} — ` +
      `${ranked.length} creators, revenue source has ${revenue.size} ranked products ` +
      `(${realDeltaProducts} with hasRealDelta) ===\n`,
    );
    console.log(
      'rank  attributedGmv   conf   vids  prods       views  aff%  niche               creator',
    );
    for (const [i, c] of ranked.slice(0, 10).entries()) {
      const m = c.metrics;
      console.log(
        `${String(i + 1).padStart(4)}  ` +
        `$${m.attributedGmv.toLocaleString('en-US', { maximumFractionDigits: 0 }).padStart(12)}  ` +
        `${m.gmvConfidence.toFixed(2)}  ` +
        `${String(m.videosPosted).padStart(4)}  ` +
        `${String(m.distinctProducts).padStart(5)}  ` +
        `${m.viewsOnWindowVideos.toLocaleString('en-US').padStart(11)}  ` +
        `${(m.affiliateIntensity * 100).toFixed(0).padStart(3)}%  ` +
        `${(m.dominantNiche || '-').padEnd(18)}  ` +
        `${c.handle ? '@' + c.handle : c.creator_key} (${c.display_name ?? '?'})`,
      );
    }

    const totalGmv = ranked.reduce((s, c) => s + c.metrics.attributedGmv, 0);
    const top100 = ranked.slice(0, 100).reduce((s, c) => s + c.metrics.attributedGmv, 0);
    const withGmv = ranked.filter((c) => c.metrics.attributedGmv > 0);
    const confs = withGmv.map((c) => c.metrics.gmvConfidence).sort((a, b) => a - b);
    console.log(
      `\n  creators with GMV > 0: ${withGmv.length} / ${ranked.length}` +
      `\n  total attributed GMV : $${totalGmv.toLocaleString('en-US', { maximumFractionDigits: 0 })}` +
      `\n  top-100 GMV share    : ${totalGmv > 0 ? ((100 * top100) / totalGmv).toFixed(1) : '0'}%` +
      `\n  median gmvConfidence : ${confs.length ? confs[Math.floor(confs.length / 2)].toFixed(3) : 'n/a'}`,
    );
    console.log(`\nDry run done in ${((Date.now() - started) / 1000).toFixed(1)}s — nothing written.`);
    return;
  }

  let ok = 0;
  let fail = 0;
  // Creators that will actually render, collected as each payload is stored.
  const warmTargets = new Set<string>();
  for (const days of windows) {
    for (const niche of NICHE_SLUGS) {
      const t = Date.now();
      try {
        const revenue = await loadRevenue(niche, days);
        const ranked = computeLeaderboard(
          videoRows, creators, productNiche, revenue, niche, days, now,
        );
        const payload = ranked.slice(0, STORE_TOP_N_CREATORS);
        const { error } = await supabase.from('creator_rankings').upsert(
          {
            cache_key: `creators:${niche}:${days}`,
            payload,
            creator_count: ranked.length,
            computed_at: new Date().toISOString(),
          },
          { onConflict: 'cache_key' },
        );
        if (error) throw new Error(error.message);
        ok++;
        for (const c of payload.slice(0, WARM_TOP_N_PER_PAYLOAD)) {
          if (c?.creator_key) warmTargets.add(c.creator_key);
        }
        console.log(
          `  ✓ creators:${niche}:${days} — ${ranked.length} creators ` +
          `(stored ${payload.length}) in ${((Date.now() - t) / 1000).toFixed(1)}s`,
        );
      } catch (e: any) {
        fail++;
        console.error(`  ✗ creators:${niche}:${days} — ${e?.message || e}`);
      }
    }
  }

  // Refresh the denormalised per-creator counts that creator search ranks by.
  // Set-based UPDATE inside the database — doing it as 110k client-side updates
  // is what made the creator_key backfill take 29 minutes.
  //
  // Chunked, because one call cannot finish: PostgREST runs as `authenticator`,
  // whose statement_timeout is 8s, and the full aggregate costs 14.3s when the
  // visibility map is stale — which is precisely its state here, right after
  // the night's inserts. Raising the timeout from inside the function does not
  // work (the timer is armed when the outer statement starts); the migration
  // header records the probe. So each call takes a bounded slice of the
  // creator_key range and returns a cursor.
  //
  // Still non-fatal — stale counts mis-rank search slightly, which is not worth
  // failing a leaderboard run over — but a failure now names the chunk it died
  // on rather than silently leaving every count a week old.
  const countsStart = Date.now();
  let cursor: string | null = null;
  let chunks = 0;
  let touched = 0;
  let countErr: string | null = null;
  // Bounded: 163,737 distinct keys / 2,000 per chunk is ~82 calls. The cap
  // stops a cursor that somehow stops advancing from looping forever, and
  // leaves room for the key count to grow.
  const MAX_CHUNKS = 500;
  while (chunks < MAX_CHUNKS) {
    const { data, error } = await supabase.rpc('refresh_creator_counts', {
      p_after: cursor,
      p_limit: 2000,
    });
    if (error) { countErr = error.message; break; }
    chunks++;
    const res = data as { done: boolean; touched: number; last_key: string | null };
    touched += Number(res?.touched) || 0;
    if (res?.done) break;
    // A cursor that does not move would spin: treat it as a failure, not a loop.
    if (!res?.last_key || res.last_key === cursor) {
      countErr = `cursor did not advance past ${cursor ?? 'start'}`;
      break;
    }
    cursor = res.last_key;
  }
  const countsSecs = ((Date.now() - countsStart) / 1000).toFixed(1);
  if (countErr) {
    console.warn(
      `  [WARN] refresh_creator_counts failed after ${chunks} chunk(s) ` +
      `(${touched} rows changed, cursor ${cursor ?? 'start'}): ${countErr}`,
    );
  } else {
    console.log(
      `  creator counts refreshed: ${touched} rows changed in ${chunks} chunk(s), ${countsSecs}s`,
    );
  }

  // Warm the avatar cache for the creators that just landed in a payload. This
  // is the only moment their signed CDN URLs are known-fresh — by tomorrow the
  // signatures have lapsed and the bytes are unreachable, so a request-time
  // fetch can only ever serve a placeholder. Costs no ScrapeCreators credits
  // (plain CDN image GETs) and never fails the run.
  console.log(`\nWarming avatar cache for ${warmTargets.size} rendered creators...`);
  const warm = await warmAvatars(supabase, [...warmTargets]);
  console.log(`  ${formatWarmStats(warm)}`);

  console.log(
    `\nCreator precompute done: ${ok} ok, ${fail} failed in ` +
    `${((Date.now() - started) / 1000).toFixed(0)}s`,
  );
  // Exit red when anything failed. This used to exit 0 with "N failed" in a
  // log nobody reads, so a night where every combo failed was a green tick.
  // Last line on purpose: everything that could be salvaged has been written.
  if (fail > 0) {
    console.error(`${fail} leaderboard(s) were NOT rebuilt and still hold their previous data.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
