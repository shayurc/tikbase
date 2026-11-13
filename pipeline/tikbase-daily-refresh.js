/**
 * tikbase-daily-refresh.js
 *
 * Daily pipeline that collects TikTok Shop data via ScrapCreators API
 * and writes to Supabase. 5 phases:
 *   1. Keyword Video Discovery
 *   2. Shop Search Enrichment
 *   3. Snapshot All Products (+ mine related_videos from the same responses)
 *   4. Fill Missing Prices
 *   5. Refresh Thumbnails
 *
 * Usage:  node pipeline/tikbase-daily-refresh.js
 * Requires env vars: SCRAPECREATORS_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from "@supabase/supabase-js";
import { deriveCreatorKey } from "../shared/creator-key.js";
import { recordDead404s, clearStrikes, STRIKES_TO_FLAG } from "./price-strikes.js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import {
  readProductResponse,
  shouldAbortSnapshots,
  snapshotFailure,
} from "./product-response.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SCRAPECREATORS_API_KEY =
  process.env.SCRAPECREATORS_API_KEY;
const SUPABASE_URL =
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SCRAPECREATORS_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    "Missing required env vars: SCRAPECREATORS_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY"
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const API_BASE = "https://api.scrapecreators.com";
const RATE_LIMIT_MS = 250; // 250ms between API calls
// Region for the product-detail endpoint. Pins pricing to the US market —
// without it some products return a non-US price. (Verified: it does NOT
// change the 404/availability rate.)
const REGION = process.env.SCRAPECREATORS_REGION || "US";

// Phase 3 snapshot allocation. Each day we re-fetch fresh sold_count/price/stock
// for a bounded set of products (every fetch costs one ScrapeCreators call).
// The set is drawn in two tiers from the same eligible pool — sold_count>0 and
// not price_unavailable:
//
//   HOT      — highest lifetime sold_count, re-snapshotted EVERY run, so the
//              head of every ranking keeps a fresh day-over-day delta.
//   ROTATION — least-recently-snapshotted, NULLs (never snapshotted) first, so
//              the long tail is covered on a bounded cycle instead of never.
//
// Products served from rankings_cache are deliberately NOT a fetch tier. The
// rotation cycle already keeps them inside valid delta spans: MAX_SPAN_RATIO
// (1.5) in api/top-products.ts accepts a baseline->latest span of
// periodDays/1.5 .. periodDays*1.5, so the tightest window (7d) accepts
// 4.7-10.5 days. A ~7.5-day rotation sits inside that band for every timeframe,
// which means a member re-snapshotted once per cycle can still earn
// hasRealDelta everywhere. Fetching all ~10.7k members daily would buy same-day
// freshness, which only the head of the ranking actually needs — and the head
// is already the hot tier. It would cost ~5x the credits for that.
//
// Coverage is verified rather than assumed: reportMembershipAges() below runs
// at end of pipeline and reports member snapshot ages against the 10.5-day
// ceiling. If members start aging past it, raise SNAPSHOT_ROTATION_LIMIT.
//
// Why a rotation rather than a bigger top-N: ordering the whole budget by
// sold_count is a fixed point. The same products win every run, so anything
// below the cutoff is excluded permanently, not just today — it can never
// accumulate the second snapshot that hasRealDelta requires. See
// probes/SNAPSHOT-COVERAGE.md: that cutoff left 96.9% of products created after
// 2026-07-08 with zero snapshots.
//
// Sizing: api/top-products.ts rejects a delta whose baseline->latest span falls
// outside periodDays/1.5 .. periodDays*1.5 (MAX_SPAN_RATIO). The shortest window
// is 7 days, so a product must be re-snapshotted at least every ~10 days to be
// eligible for a real delta there. Against ~35.3k eligible products, a 4,500/run
// rotation clears the tail in ~7.5 days — inside that ceiling with margin.
//
// Cost/time: measured throughput is ~3.49 products/sec for the whole of Phase 3
// (fetch + related_videos mining) at concurrency 10. 6,000/run is ~29 min of
// Phase 3 and 6,000 API credits/day, against 3,000/day before this change.
// Levers if the membership monitor shows members aging past ~9 days:
//   1. Per-niche hot coverage — give each niche its own small hot allocation
//      instead of one global top-N. Cheapest real fix: the cache is ranked per
//      niche, so a global sold_count cutoff under-serves narrow niches, which
//      is exactly where aging members concentrate.
//   2. SNAPSHOT_ROTATION_LIMIT — shortens the cycle across the board.
//   3. STORE_TOP_N_PRODUCTS in precompute-rankings.ts (currently 400) — shrinks
//      the cache, and so the set being monitored, at source.
const SNAPSHOT_HOT_LIMIT = Number(process.env.SNAPSHOT_HOT_LIMIT) || 1500;
const SNAPSHOT_ROTATION_LIMIT = Number(process.env.SNAPSHOT_ROTATION_LIMIT) || 4500;
// The span ceiling the rotation cycle has to stay under: MAX_SPAN_RATIO=1.5 in
// api/top-products.ts against the tightest (7-day) window.
const MEMBER_AGE_SLA_DAYS = 10.5;
const MEMBER_AGE_WARN_DAYS = 9;
// Legacy single-cap override. Still honoured when set: it caps the COMBINED
// tracked set, split between hot and rotation in their configured ratio.
const SNAPSHOT_TRACKED_LIMIT = Number(process.env.SNAPSHOT_TRACKED_LIMIT) || 0;
const SNAPSHOT_CONCURRENCY = 10;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apiFetch(path) {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    headers: { "x-api-key": SCRAPECREATORS_API_KEY },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API ${res.status} for ${path}: ${text.slice(0, 200)}`);
  }
  const body = await res.json();
  // Every successful response carries the balance. Recording it costs nothing
  // and is the only way to see the wall coming BEFORE the run that hits it —
  // the existing check only fires once 402s have already cost us a day of data.
  if (body && typeof body.credits_remaining === "number") {
    stats.credits_remaining = body.credits_remaining;
    if (stats.credits_at_start === null) stats.credits_at_start = body.credits_remaining;
  }
  stats.api_calls++;
  return body;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Summary counters
const stats = {
  api_calls: 0,
  credits_at_start: null,
  credits_remaining: null,
  phase1_videos: 0,
  phase1_products: 0,
  phase2_products: 0,
  phase2_birth_snapshots: 0,
  phase3_snapshots: 0,
  phase3_failure: null,
  phase3_rotation_advanced: 0,
  // null, not 0: "not measured" and "measured at zero" are different facts,
  // and printing the second when the first is true is what hid a broken
  // monitor for three nights.
  phase3_member_ages_known: false,
  phase3_member_max_age: null,
  phase3_members_over_warn: null,
  phase3_monitor_error: null,
  phase3_404_flagged: 0,
  phase3_404_first_strike: 0,
  phase3_related_inserted: 0,
  phase3_related_updated: 0,
  phase4_prices_filled: 0,
  phase4_revived: 0,
  phase5_thumbnails: 0,
  api_failures: 0,
  api_402: 0,
};

// A 402 from ScrapeCreators means the credit balance is exhausted. That is an
// outage, not a per-item failure, and it must never be able to look like
// "found nothing" — every phase counts it and the summary shouts about it.
function isCreditError(err) {
  return /\bAPI 402\b|out of credits/i.test(String(err?.message || ""));
}

// Record a failed API call. Returns true if it was a credit (402) failure.
function recordApiFailure(err) {
  stats.api_failures++;
  const credit = isCreditError(err);
  if (credit) stats.api_402++;
  return credit;
}

// --- birth snapshots -------------------------------------------------------
// Which of these product_ids are not yet in the products table. Called BEFORE
// the upsert, so "new" means new. On any error it returns an empty set, so a
// failed lookup seeds nothing rather than mis-seeding everything.
async function findNewProductIds(ids) {
  const existing = new Set();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const { data, error } = await supabase
      .from("products")
      .select("product_id")
      .in("product_id", chunk);
    if (error) {
      console.error("  [WARN] birth-snapshot existence check failed:", error.message);
      return new Set();
    }
    for (const r of data || []) existing.add(r.product_id);
  }
  return new Set(ids.filter((id) => !existing.has(id)));
}

// Write a first ("birth") snapshot for newly-discovered products, from the
// sold_count/price already present in the discovery payload. Zero API cost.
//
// Without this a new product has no snapshot until rotation reaches it, so its
// delta baseline starts a cycle late. Seeding at insert gives the delta model a
// floor row from day one.
//
// Only Phase 2 (shop search) can do this: its payload carries sold_info, so a
// real sold_count is available. Phase 1 (keyword video discovery) extracts
// products from video anchors, which carry no sold_count at all — seeding a
// null-sold_count row there would be worse than nothing, because
// api/top-products.ts coerces a null baseline to 0 and would read the product's
// entire lifetime volume as one period's delta. Phase 1 products therefore get
// their first snapshot from the next run's rotation instead, which picks them
// up immediately: they enter with last_snapshot_date NULL and rotation orders
// ASC NULLS FIRST.
async function seedBirthSnapshots(products) {
  const rows = products
    .filter((p) => p.sold_count != null)
    .map((p) => ({
      product_id: String(p.product_id),
      sold_count: p.sold_count,
      sale_price: p.sale_price ?? null,
      stock_quantity: p.stock_quantity ?? null,
      snapshot_date: today(),
    }));
  if (!rows.length) return 0;

  let seeded = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    // ignoreDuplicates → ON CONFLICT DO NOTHING on (product_id, snapshot_date).
    // Phase 3 runs later in the same process and upserts with
    // ignoreDuplicates:false, so a fresh-fetched value always wins over a seed.
    const { error } = await supabase
      .from("product_snapshots")
      .upsert(chunk, {
        onConflict: "product_id,snapshot_date",
        ignoreDuplicates: true,
      });
    if (error) console.error("  [WARN] birth snapshot insert:", error.message);
    else seeded += chunk.length;
  }
  return seeded;
}

// ---------------------------------------------------------------------------
// Niche definitions
// ---------------------------------------------------------------------------

const NICHE_LABELS = {
  "beauty-skincare": "Beauty & Skincare",
  "gym-fitness": "Gym & Fitness",
  "health-wellness": "Health & Wellness",
  "womens-wear": "Women's Wear",
  "mens-wear": "Men's Wear",
  "tech-gadgets": "Tech & Gadgets",
  "pet-products": "Pet Products",
  "home-kitchen": "Home & Kitchen",
  "food-beverage": "Food & Beverage",
  "shoes-footwear": "Shoes & Footwear",
  "accessories-jewelry": "Accessories & Jewelry",
  "baby-kids": "Baby & Kids",
  "toys-games": "Toys & Games",
  "fragrance": "Fragrance & Perfume",
  "supplements": "Supplements & Wellness",
  "mens-grooming": "Men's Grooming",
  "haircare": "Haircare",
  "makeup": "Makeup & Cosmetics",
  "collectibles": "Collectibles & Trading Cards",
};

const KEYWORD_QUERIES = {
  // Purchase-intent only: every query names the shop or a buying action, so the
  // results are products people are actually buying rather than fan content.
  "collectibles": [
    "tiktok shop trading cards",
    "tiktok shop collectibles viral",
    "tiktok made me buy it collectibles",
    "pokemon cards tiktok shop",
    "funko pop tiktok shop",
  ],
  "beauty-skincare": [
    "tiktok shop skincare viral",
    "tiktok made me buy it skincare",
    "best tiktok shop beauty products",
    "viral skincare routine tiktok",
    "tiktok shop makeup must haves",
    "beauty finds tiktok shop",
    "skincare holy grail tiktok",
    "tiktok shop beauty haul",
    "trending skincare products tiktok",
    "viral beauty tiktok affiliate",
  ],
  "gym-fitness": [
    "tiktok shop gym must haves",
    "viral fitness products tiktok",
    "tiktok shop workout equipment",
    "gym finds tiktok shop",
    "tiktok made me buy it fitness",
    "home gym tiktok shop",
    "fitness gadgets trending tiktok",
    "tiktok shop protein supplements",
    "tiktok shop resistance bands",
    "creatine tiktok shop",
    "massage gun tiktok viral",
    "pre workout tiktok shop",
    "tiktok shop sports bra",
    "tiktok shop leggings gym",
  ],
  "health-wellness": [
    "tiktok shop health products viral",
    "wellness finds tiktok shop",
    "tiktok made me buy it health",
    "viral supplements tiktok shop",
    "health gadgets tiktok trending",
    "tiktok shop wellness must haves",
    "self care products tiktok shop",
    "health essentials tiktok viral",
    "tiktok shop vitamins trending",
    "wellness routine tiktok shop",
  ],
  "womens-wear": [
    "tiktok shop womens fashion viral",
    "trending womens clothing tiktok",
    "tiktok made me buy it fashion",
    "viral outfits tiktok shop",
    "tiktok shop dress haul",
    "womens fashion finds tiktok",
    "cute clothes tiktok shop",
    "tiktok shop spring outfits",
    "viral womens wear tiktok affiliate",
    "best tiktok shop clothing finds",
  ],
  "mens-wear": [
    "tiktok shop mens fashion viral",
    "mens clothing tiktok shop",
    "tiktok made me buy it mens",
    "viral mens outfits tiktok",
    "mens fashion finds tiktok shop",
    "tiktok shop streetwear trending",
    "mens essentials tiktok shop",
    "guys fashion tiktok viral",
    "best mens tiktok shop finds",
    "mens style tiktok affiliate",
  ],
  "tech-gadgets": [
    "tiktok shop tech gadgets viral",
    "tiktok made me buy it tech",
    "viral gadgets tiktok shop",
    "cool tech finds tiktok",
    "tiktok shop electronics trending",
    "must have gadgets tiktok shop",
    "tech accessories tiktok viral",
    "amazon finds tech tiktok shop",
    "smart home tiktok shop",
    "viral tech products tiktok affiliate",
  ],
  "pet-products": [
    "tiktok shop pet products viral",
    "tiktok made me buy it pets",
    "viral pet finds tiktok shop",
    "dog products tiktok shop trending",
    "cat products tiktok viral",
    "pet must haves tiktok shop",
    "best pet products tiktok",
    "pet accessories tiktok shop",
    "viral pet gadgets tiktok",
    "pet essentials tiktok affiliate",
  ],
  "home-kitchen": [
    "tiktok shop kitchen gadgets viral",
    "tiktok made me buy it kitchen",
    "cleantok must haves tiktok shop",
    "home organization tiktok shop",
    "viral cleaning products tiktok shop",
    "kitchen finds tiktok shop",
    "tiktok shop home gadgets viral",
    "restock tiktok shop organization",
    "tiktok shop kitchen must haves",
    "satisfying cleaning gadgets tiktok",
    "viral home products tiktok affiliate",
    "tiktok shop storage organization",
    "rapid egg cooker tiktok shop",
    "tiktok shop vacuum sealer viral",
  ],
  "food-beverage": [
    "tiktok shop snacks viral",
    "tiktok made me buy it snacks",
    "freeze dried candy tiktok shop",
    "viral snacks tiktok shop",
    "tiktok shop food must haves",
    "boba kit tiktok shop",
    "tiktok shop drinks viral",
    "snack haul tiktok shop",
    "tiktok shop candy viral",
    "energy drink tiktok shop trending",
    "exotic snacks tiktok shop",
    "tiktok shop chips spicy viral",
    "best tiktok shop snacks",
    "freeze dried skittles tiktok",
  ],
  "shoes-footwear": [
    "tiktok shop shoes viral",
    "tiktok made me buy it shoes",
    "viral sneakers tiktok shop",
    "tiktok shop shoe finds",
    "crocs tiktok shop",
    "hey dude tiktok shop",
    "tiktok shop boots women",
    "comfortable shoes tiktok viral",
    "tiktok shop sandals summer",
    "best tiktok shop shoes",
    "slippers tiktok shop viral",
    "tiktok shop trainers sneakers",
    "barefoot shoes tiktok shop",
    "tiktok shop clogs mules",
  ],
  "accessories-jewelry": [
    "tiktok shop jewelry viral",
    "tiktok made me buy it jewelry",
    "viral accessories tiktok shop",
    "tiktok shop gold jewelry finds",
    "tiktok shop necklace viral",
    "jewelry haul tiktok shop",
    "tiktok shop earrings trending",
    "tiktok shop bags purse viral",
    "tiktok shop sunglasses finds",
    "best tiktok shop accessories",
    "tiktok shop rings stackable",
    "tiktok shop watch viral",
    "waterproof jewelry tiktok shop",
    "tiktok shop hair accessories viral",
  ],
  "baby-kids": [
    "tiktok shop baby products viral",
    "tiktok made me buy it baby",
    "viral baby finds tiktok shop",
    "tiktok shop toddler must haves",
    "montessori toys tiktok shop",
    "tiktok shop maternity pregnancy",
    "baby essentials tiktok shop",
    "tiktok shop kids products viral",
    "momcozy tiktok shop",
    "tiktok shop nursery organization",
    "best tiktok shop baby",
    "tiktok shop pregnancy pillow",
    "sensory toys tiktok shop",
    "tiktok shop baby gadgets viral",
  ],
  "toys-games": [
    "tiktok shop toys viral",
    "tiktok made me buy it toys",
    "viral fidget toys tiktok shop",
    "tiktok shop squishies trending",
    "satisfying toys tiktok shop",
    "tiktok shop plushies viral",
    "stress relief toys tiktok shop",
    "tiktok shop trading cards",
    "kids toys tiktok shop viral",
    "tiktok shop collectibles trending",
    "best tiktok shop toys",
    "tiktok shop board games viral",
    "bubble wand tiktok shop",
    "mystery squishy tiktok shop",
  ],
  "fragrance": [
    "tiktok shop perfume viral",
    "tiktok made me buy it perfume",
    "viral fragrance tiktok shop",
    "tiktok shop perfume dupes",
    "long lasting perfume tiktok shop",
    "tiktok shop cologne men",
    "perfume haul tiktok shop",
    "tiktok shop body mist viral",
    "best tiktok shop perfume",
    "tiktok shop fragrance finds",
    "viral cologne tiktok affiliate",
    "tiktok shop perfume women trending",
  ],
  "supplements": [
    "sea moss gel",
    "magnesium glycinate",
    "collagen powder",
    "greens powder",
    "shilajit",
    "liquid multivitamin",
    "gut health supplement",
    "ashwagandha",
    "creatine gummies",
    "debloat powder",
  ],
  "mens-grooming": [
    "based bodyworks",
    "texture powder",
    "sea salt spray men",
    "pomade",
    "mens skincare",
    "mens face wash",
    "magnesium deodorant",
    "mens hair powder",
    "beard care",
    "hair clay",
  ],
  "haircare": [
    "hair growth serum",
    "heatless curls",
    "bond repair",
    "scalp treatment",
    "hair mask",
    "wig install",
    "hair extensions",
    "rosemary oil hair",
    "hair oil",
    "dry shampoo",
  ],
  "makeup": [
    "lip liner",
    "blush",
    "mascara",
    "foundation",
    "lip stain",
    "contour",
    "brow gel",
    "setting spray",
    "lip oil",
    "eyeshadow palette",
  ],
};

const SHOP_SEARCH_TERMS = {
  "collectibles": ["trading cards", "collectibles", "funko pop", "pokemon cards"],
  "beauty-skincare": ["skincare", "beauty", "makeup", "serum", "moisturizer"],
  "gym-fitness": [
    "gym equipment",
    "fitness",
    "workout",
    "protein",
    "exercise",
    "resistance bands",
    "dumbbells",
    "yoga mat",
    "creatine",
    "pre workout",
    "leggings gym",
    "sports bra",
    "massage gun",
    "foam roller",
  ],
  "health-wellness": [
    "health supplements",
    "wellness",
    "vitamins",
    "self care",
    "essential oil",
  ],
  "womens-wear": [
    "womens dress",
    "womens fashion",
    "womens clothing",
    "blouse",
    "skirt",
  ],
  "mens-wear": [
    "mens clothing",
    "mens fashion",
    "streetwear",
    "mens shirt",
    "mens pants",
  ],
  "tech-gadgets": [
    "gadgets",
    "tech accessories",
    "electronics",
    "smart home",
    "phone accessories",
  ],
  "pet-products": [
    "dog products",
    "cat products",
    "pet accessories",
    "pet toys",
    "pet grooming",
  ],
  "home-kitchen": [
    "kitchen gadgets",
    "cleaning supplies",
    "home organization",
    "storage containers",
    "kitchen tools",
    "home decor",
    "egg cooker",
    "vacuum sealer",
  ],
  "food-beverage": [
    "snacks",
    "freeze dried candy",
    "chips",
    "candy",
    "boba",
    "energy drink",
    "exotic snacks",
    "seasoning",
  ],
  "shoes-footwear": [
    "sneakers",
    "womens boots",
    "sandals",
    "slippers",
    "crocs",
    "mens shoes",
    "clogs",
    "running shoes",
  ],
  "accessories-jewelry": [
    "jewelry",
    "necklace",
    "earrings",
    "rings",
    "handbag",
    "sunglasses",
    "watch",
    "hair accessories",
  ],
  "baby-kids": [
    "baby products",
    "baby toys",
    "maternity",
    "pregnancy pillow",
    "montessori toys",
    "toddler",
    "nursery",
    "baby essentials",
  ],
  "toys-games": [
    "fidget toys",
    "squishies",
    "plush toys",
    "stress relief toys",
    "trading cards",
    "collectibles",
    "board games",
    "kids toys",
  ],
  "fragrance": [
    "perfume",
    "cologne",
    "fragrance",
    "body mist",
    "perfume dupe",
    "eau de parfum",
  ],
  "supplements": [
    "sea moss",
    "magnesium glycinate",
    "collagen powder",
    "greens powder",
    "shilajit",
    "ashwagandha",
  ],
  "mens-grooming": [
    "mens grooming",
    "texture powder",
    "sea salt spray",
    "pomade",
    "beard care",
    "magnesium deodorant",
  ],
  "haircare": [
    "hair growth serum",
    "heatless curls",
    "bond repair",
    "scalp treatment",
    "hair mask",
    "rosemary oil hair",
  ],
  "makeup": [
    "lip liner",
    "blush",
    "mascara",
    "foundation",
    "eyeshadow palette",
    "setting spray",
  ],
};

// ---------------------------------------------------------------------------
// Phase 1 — Keyword Video Discovery
// ---------------------------------------------------------------------------

async function phase1() {
  console.log("\n========== PHASE 1: Keyword Video Discovery ==========\n");

  const videosToUpsert = [];
  const productsToUpsert = [];

  for (const [nicheSlug, queries] of Object.entries(KEYWORD_QUERIES)) {
    const nicheLabel = NICHE_LABELS[nicheSlug];
    console.log(`  Niche: ${nicheLabel} (${queries.length} queries)`);

    for (const query of queries) {
      try {
        const data = await apiFetch(
          `/v1/tiktok/search/keyword?query=${encodeURIComponent(query)}&count=30`
        );
        await sleep(RATE_LIMIT_MS);

        // API returns search_item_list, each item wrapped in aweme_info
        const rawItems = data?.search_item_list || data?.data || [];
        if (!Array.isArray(rawItems)) continue;

        for (const rawItem of rawItems) {
          const video = rawItem?.aweme_info || rawItem;
          const viewCount =
            video?.statistics?.play_count ??
            video?.stats?.playCount ??
            video?.play_count ??
            0;
          if (viewCount < 1000) continue;

          // Look for TikTok Shop product anchor.
          // anchors[].extra is an ARRAY of objects, not a single object.
          const anchors = video?.anchors || video?.anchor_list || [];
          let productId = null;
          let shopExtra = null;
          for (const anchor of anchors) {
            const extras = Array.isArray(anchor?.extra) ? anchor.extra : [anchor?.extra].filter(Boolean);
            const match = extras.find((e) => e?.type === 33);
            if (match) {
              productId = match.id || match.product_id;
              shopExtra = match;
              break;
            }
          }
          // Fallback: check shop_product_url for product ID
          if (!productId && video?.shop_product_url) {
            const m = video.shop_product_url.match(/\/(\d{10,})/);
            if (m) productId = m[1];
          }
          if (!productId) continue;

          const videoUrl =
            `https://www.tiktok.com/@${video?.author?.unique_id || video?.author?.uniqueId || "user"}/video/${video?.aweme_id || video?.id}`;
          const videoId = extractVideoId(videoUrl);

          // Skip videos whose id can't be extracted (malformed URL): they can't
          // be deduplicated against the (product_id, video_id) unique index and
          // would otherwise slip in as un-dedupable rows.
          if (videoId) {
            videosToUpsert.push({
              product_id: String(productId),
              video_id: videoId,
              video_url: videoUrl,
              // Stamped at insert time. The migration backfilled this column
              // once and installed no trigger, so a row inserted without it
              // stays unkeyed forever — and precompute-creators drops unkeyed
              // rows, which quietly starved the creator leaderboard of every
              // video discovered after 2026-07-28.
              creator_key: deriveCreatorKey(videoUrl),
              view_count: viewCount,
              author_name:
                video?.author?.nickname ||
                video?.author?.unique_id ||
                null,
              author_avatar_url:
                video?.author?.avatar_medium?.url_list?.[0] ||
                video?.author?.avatar_thumb?.url_list?.[0] ||
                null,
              cover_image_url:
                video?.video?.cover?.url_list?.[0] ||
                video?.video?.origin_cover?.url_list?.[0] ||
                null,
            });
          }

          // Extract product info from anchor
          const productTitle = shopExtra?.keyword || shopExtra?.title || null;
          productsToUpsert.push({
            product_id: String(productId),
            title: productTitle,
            niche_slug: nicheSlug,
            niche_label: nicheLabel,
            image_url: video?.video?.cover?.url_list?.[0] || null,
            product_url: video?.shop_product_url || `https://www.tiktok.com/shop/pdp/${productId}`,
          });
        }
      } catch (err) {
        recordApiFailure(err);
        console.warn(`    [WARN] Query failed "${query}": ${err.message}`);
      }
    }
  }

  // Upsert products
  if (productsToUpsert.length > 0) {
    // Dedupe by product_id
    const dedupedProducts = Object.values(
      productsToUpsert.reduce((acc, p) => {
        acc[p.product_id] = { ...acc[p.product_id], ...p, updated_at: new Date().toISOString() };
        return acc;
      }, {})
    );

    const { error } = await supabase
      .from("products")
      .upsert(dedupedProducts, { onConflict: "product_id", ignoreDuplicates: false });
    if (error) console.error("  [ERROR] Products upsert:", error.message);
    else stats.phase1_products = dedupedProducts.length;
  }

  // Insert videos
  if (videosToUpsert.length > 0) {
    // Dedupe by (product_id, video_id) — the real unique key. The same video's
    // URL differs by source (@handle vs @author_id, share params), so a
    // video_url check misses already-stored duplicates; the extracted video_id
    // does not.
    const dedupedVideos = Object.values(
      videosToUpsert.reduce((acc, v) => {
        acc[`${v.product_id}:${v.video_id}`] = v;
        return acc;
      }, {})
    );

    // Insert in chunks; on a unique-violation (a video_id already stored for
    // this product) retry the chunk row-by-row so the duplicate is skipped
    // without aborting — and dropping — the chunk's genuinely-new rows. The
    // (product_id, video_id) unique index is partial (video_id IS NOT NULL), so
    // ON CONFLICT / upsert can't target it; this mirrors the related_videos path.
    for (let i = 0; i < dedupedVideos.length; i += 500) {
      const chunk = dedupedVideos.slice(i, i + 500);
      const { error } = await supabase.from("product_videos").insert(chunk);
      if (!error) { stats.phase1_videos += chunk.length; continue; }
      if (error.code === "23505") {
        for (const row of chunk) {
          const { error: e2 } = await supabase.from("product_videos").insert(row);
          if (!e2) stats.phase1_videos++;
          else if (e2.code !== "23505") console.error("  [WARN] video insert:", e2.message);
        }
      } else {
        console.error("  [ERROR] Videos insert:", error.message);
      }
    }
  }

  console.log(
    `  Phase 1 done: ${stats.phase1_products} products, ${stats.phase1_videos} videos`
  );
}

// ---------------------------------------------------------------------------
// Phase 2 — Shop Search Enrichment
// ---------------------------------------------------------------------------

async function phase2() {
  console.log("\n========== PHASE 2: Shop Search Enrichment ==========\n");

  const productsToUpsert = [];

  for (const [nicheSlug, terms] of Object.entries(SHOP_SEARCH_TERMS)) {
    const nicheLabel = NICHE_LABELS[nicheSlug];
    console.log(`  Niche: ${nicheLabel} (${terms.length} search terms)`);

    for (const term of terms) {
      try {
        const data = await apiFetch(
          `/v1/tiktok/shop/search?query=${encodeURIComponent(term)}`
        );
        await sleep(RATE_LIMIT_MS);

        const products =
          data?.data?.products || data?.products || data?.data || [];
        if (!Array.isArray(products)) continue;

        for (const p of products) {
          const productId =
            p?.product_id || p?.id || p?.item_id;
          if (!productId) continue;

          // Extract price from product_price_info. Verified against the live
          // shop-search response: the real keys are sale_price_decimal /
          // origin_price_decimal (NOT min_price / original_price).
          const priceInfo = p?.product_price_info;
          const parsePrice = (v) =>
            v != null ? parseFloat(String(v).replace(/[^0-9.]/g, '')) || null : null;
          const salePrice =
            parsePrice(priceInfo?.sale_price_decimal) ??
            parsePrice(priceInfo?.sale_price_format) ??
            parsePrice(priceInfo?.single_product_price_decimal) ??
            (p?.sale_price != null ? parseFloat(p.sale_price) || null : null);
          const originalPrice =
            parsePrice(priceInfo?.origin_price_decimal) ??
            parsePrice(priceInfo?.origin_price_format) ??
            (p?.original_price != null ? parseFloat(p.original_price) || null : null);

          // Extract sold count from sold_info — verified correct against live API.
          const soldCount = p?.sold_info?.sold_count ?? p?.sold_count ?? null;

          productsToUpsert.push({
            product_id: String(productId),
            title: p?.title || p?.name || null,
            niche_slug: nicheSlug,
            niche_label: nicheLabel,
            image_url:
              p?.image?.url_list?.[0] ||
              p?.image_url ||
              null,
            sale_price: salePrice,
            original_price: originalPrice,
            sold_count: soldCount ?? p?.sold_count ?? null,
            rating: p?.rate_info?.score != null ? parseFloat(p.rate_info.score) : (p?.rating ?? null),
            review_count: p?.rate_info?.review_count ?? p?.review_count ?? null,
            seller_name: p?.seller_info?.shop_name || p?.seller_info?.name || p?.seller?.name || null,
            seller_id: p?.seller_info?.seller_id || p?.seller?.id || null,
            product_url: `https://www.tiktok.com/shop/pdp/${productId}`,
            updated_at: new Date().toISOString(),
          });
        }
      } catch (err) {
        recordApiFailure(err);
        console.warn(`    [WARN] Shop search failed "${term}": ${err.message}`);
      }
    }
  }

  if (productsToUpsert.length > 0) {
    const dedupedProducts = Object.values(
      productsToUpsert.reduce((acc, p) => {
        acc[p.product_id] = { ...acc[p.product_id], ...p };
        return acc;
      }, {})
    );

    // Identify the genuinely-new ones BEFORE the upsert, so they can be given a
    // birth snapshot below.
    const newIds = await findNewProductIds(dedupedProducts.map((p) => p.product_id));

    for (let i = 0; i < dedupedProducts.length; i += 500) {
      const chunk = dedupedProducts.slice(i, i + 500);
      const { error } = await supabase
        .from("products")
        .upsert(chunk, { onConflict: "product_id", ignoreDuplicates: false });
      if (error) console.error("  [ERROR] Shop products upsert:", error.message);
      else stats.phase2_products += chunk.length;
    }

    if (newIds.size) {
      stats.phase2_birth_snapshots = await seedBirthSnapshots(
        dedupedProducts.filter((p) => newIds.has(p.product_id))
      );
      console.log(
        `  Phase 2 birth snapshots: ${stats.phase2_birth_snapshots} seeded ` +
        `(of ${newIds.size} new products; the rest had no sold_count)`
      );
    }
  }

  console.log(`  Phase 2 done: ${stats.phase2_products} products upserted`);
}

// ---------------------------------------------------------------------------
// Phase 3 — Snapshot All Products (and mine related_videos, a bonus payload
// already present in each Product Details response — see upsertRelatedVideos).
// ---------------------------------------------------------------------------

// Raw product-detail fetch (does not throw on non-2xx) so we can distinguish
// 404s from transient errors. Mirrors the backfill script's approach.
async function fetchProductDetailRaw(productId) {
  const productUrl = `https://www.tiktok.com/shop/pdp/${productId}`;
  const path = `/v1/tiktok/product?url=${encodeURIComponent(productUrl)}&region=${encodeURIComponent(REGION)}`;
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { "x-api-key": SCRAPECREATORS_API_KEY },
    });
    const text = await res.text().catch(() => "");
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json };
  } catch (e) {
    return { status: 0, json: null, err: e.message };
  }
}

// Bounded-concurrency pool (never Promise.all the whole list).
async function snapshotPool(items, concurrency, worker) {
  let next = 0;
  async function runner() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i]);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, runner));
}

// --- related_videos mining helpers -----------------------------------------
// The Product Details response (fetched for every tracked product in Phase 3)
// carries a `related_videos` array — the videos TikTok associates with the
// product. We persist it into product_videos at zero extra API cost.

// Numeric TikTok video id from a video URL. This is the dedup key (NOT the full
// URL): the same video's URL differs by source — related_videos uses
// @<author_id> while keyword rows use @<handle> — but the /video/<id> segment is
// identical. Validated: 100% of a 500-row live sample matched, all 19-digit ids.
function extractVideoId(url) {
  const m = String(url || "").match(/video\/(\d+)/);
  return m ? m[1] : null;
}

const toIntOrNull = (v) => {
  const n = Number(String(v ?? "").replace(/[^0-9]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
};

// related_videos.upload_time is unix SECONDS (string) -> ISO timestamptz, or null.
function uploadTimeToISO(v) {
  const s = Number(String(v ?? "").replace(/[^0-9]/g, ""));
  if (!Number.isFinite(s) || s <= 0) return null;
  const d = new Date(s * 1000);
  const y = d.getUTCFullYear();
  if (y < 2015 || y > 2035) return null; // guard against junk timestamps
  return d.toISOString();
}

// Persist related_videos into product_videos. Dedup is keyed on the numeric
// video id (video_id column, backfilled + a unique index on (product_id,
// video_id)), so related rows correctly match keyword rows for the same video
// despite differing URL formats. INSERTs new videos with
// discovery_source='related_videos' and video_id set; a unique-constraint hit
// (concurrent/edge case) is a benign skip (ON CONFLICT DO NOTHING). UPDATEs
// existing rows' view/like counts ONLY when the incoming value is higher
// (monotonic). Never downgrades counts, never rewrites
// video_url/discovery_source/posted_at on existing rows, never deletes.
// Idempotent across same-day re-runs. Returns aggregate + per-product stats.
async function upsertRelatedVideos(relatedByProduct) {
  const s = { products: relatedByProduct.size, candidates: 0, inserted: 0, updated: 0, skipped: 0, constraintSkipped: 0, perProduct: [] };
  if (relatedByProduct.size === 0) return s;

  // 1. Build candidate rows, deduped per product by video id.
  const byProduct = new Map(); // productId -> Map<videoId, candidate row>
  for (const [productId, entries] of relatedByProduct) {
    const m = new Map();
    for (const e of entries || []) {
      const videoId = e?.item_id ? String(e.item_id) : extractVideoId(e?.url);
      if (!videoId) continue;
      const url = e?.url || `https://www.tiktok.com/@${e?.author_id || "user"}/video/${videoId}`;
      const cand = {
        product_id: String(productId),
        video_id: videoId, // explicit — column is plain (backfilled), unique (product_id, video_id)
        video_url: url,
        creator_key: deriveCreatorKey(url), // see the phase-1 insert for why
        view_count: toIntOrNull(e?.play_count),
        like_count: toIntOrNull(e?.like_count),
        author_name: e?.author_name || null,
        author_avatar_url: e?.author_avatar_url || null,
        cover_image_url: e?.cover_image_url || null,
        ad_label: e?.bc_ad_label_text || null,
        posted_at: uploadTimeToISO(e?.upload_time),
        discovery_source: "related_videos",
      };
      const prev = m.get(videoId); // keep higher-count copy if duplicated in payload
      if (!prev || (cand.view_count || 0) > (prev.view_count || 0)) m.set(videoId, cand);
    }
    if (m.size) { byProduct.set(String(productId), m); s.candidates += m.size; }
  }
  if (byProduct.size === 0) return s;

  // 2. Fetch existing rows for these products (indexed by product_id) and map
  //    them by extracted video id so dedup ignores URL-format differences.
  // A tracked product can have hundreds of existing videos, and a chunk of
  // products can total far more than PostgREST's 1000-row default cap — so we
  // MUST paginate each chunk with .range(), or the dedup map silently misses
  // rows and misclassifies existing videos as inserts.
  const productIds = [...byProduct.keys()];
  const existing = new Map(); // productId -> Map<videoId, { id, view_count, like_count }>
  const PAGE = 1000;
  for (let i = 0; i < productIds.length; i += 100) {
    const chunk = productIds.slice(i, i + 100);
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from("product_videos")
        .select("id, product_id, video_id, video_url, view_count, like_count")
        .in("product_id", chunk)
        .range(from, from + PAGE - 1);
      if (error) throw new Error("fetch existing: " + error.message);
      if (!data?.length) break;
      for (const row of data) {
        // Prefer the DB video_id (matches the unique index); fall back to URL
        // extraction for any keyword rows still carrying a null video_id.
        const vid = row.video_id || extractVideoId(row.video_url);
        if (!vid) continue;
        if (!existing.has(row.product_id)) existing.set(row.product_id, new Map());
        existing.get(row.product_id).set(vid, row);
      }
      if (data.length < PAGE) break;
    }
  }

  // 3. Partition into inserts (new id) and monotonic updates (count rose),
  //    tracking per-product counts (before = existing video coverage).
  const inserts = [];
  const updates = []; // { id, fields }
  for (const [productId, m] of byProduct) {
    const ex = existing.get(productId) || new Map();
    let pi = 0, pu = 0, pun = 0;
    for (const [videoId, cand] of m) {
      const prior = ex.get(videoId);
      if (!prior) { inserts.push(cand); pi++; continue; }
      const fields = {};
      if (cand.view_count != null && cand.view_count > (prior.view_count || 0)) fields.view_count = cand.view_count;
      if (cand.like_count != null && cand.like_count > (prior.like_count || 0)) fields.like_count = cand.like_count;
      if (Object.keys(fields).length) { updates.push({ id: prior.id, fields }); pu++; }
      else { s.skipped++; pun++; }
    }
    s.perProduct.push({ productId, before: ex.size, inserts: pi, updates: pu, unchanged: pun });
  }

  // 4. Insert new rows in chunks. App-level dedup (step 3) already excludes any
  //    existing (product_id, video_id), so plain inserts succeed. The unique
  //    index is a physical backstop: a genuine duplicate (concurrent/edge) raises
  //    23505, which we treat as a benign skip by retrying that chunk row-by-row.
  //    (We deliberately avoid PostgREST's onConflict arbiter inference, which is
  //    fragile right after the index DDL — stale schema cache -> 42P10.)
  for (let i = 0; i < inserts.length; i += 500) {
    const chunk = inserts.slice(i, i + 500);
    const { error } = await supabase.from("product_videos").insert(chunk);
    if (!error) { s.inserted += chunk.length; continue; }
    if (error.code === "23505") {
      for (const row of chunk) {
        const { error: e2 } = await supabase.from("product_videos").insert(row);
        if (!e2) s.inserted++;
        else if (e2.code === "23505") s.constraintSkipped++; // row exists = benign skip
        else console.error("  [WARN] related insert row failed:", e2.message);
      }
    } else {
      console.error("  [WARN] related insert chunk failed:", error.message);
    }
  }

  // 5. Apply monotonic count updates via a bounded pool (PK-indexed, parallel).
  await snapshotPool(updates, SNAPSHOT_CONCURRENCY, async (u) => {
    const { error } = await supabase.from("product_videos").update(u.fields).eq("id", u.id);
    if (error) console.error("  [WARN] related update failed:", error.message);
    else s.updated++;
  });

  return s;
}

// Page the eligible pool under one ordering. Eligibility is identical for both
// tiers — a positive lifetime sold_count, and not already marked unfetchable.
// The product_id tiebreak matters: thousands of rows share a last_snapshot_date,
// and without a stable secondary sort the paginated reads can return an
// arbitrary slice of that tie each run, starving the rest of the group.
// Returns { ids, error } — the caller decides whether a failure is fatal.
async function fetchEligible({ column, ascending, nullsFirst, limit, label }) {
  const ids = [];
  for (let from = 0; ids.length < limit; from += 1000) {
    const { data, error } = await supabase
      .from("products")
      .select("product_id")
      .gt("sold_count", 0)
      .or("price_unavailable.is.null,price_unavailable.eq.false")
      .order(column, { ascending, nullsFirst })
      .order("product_id", { ascending: true })
      .range(from, from + 999);
    if (error) {
      console.error(`  [ERROR] Fetching ${label} set:`, error.message);
      return { ids, error };
    }
    if (!data || data.length === 0) break;
    ids.push(...data.map((r) => r.product_id));
    if (data.length < 1000) break;
  }
  return { ids: ids.slice(0, limit), error: null };
}

// Membership MONITOR. Products served from rankings_cache are not a fetch tier
// (see the config block for the span math); rotation is expected to keep them
// fresh enough on its own. This checks whether that is actually true, rather
// than assuming it — it reads the cursor for every served product and reports
// the age distribution against the MAX_SPAN_RATIO ceiling.
//
// Deliberately never fails the run: aging members self-heal, because rotation
// orders by last_snapshot_date ASC NULLS FIRST, so the stalest members are
// exactly what the next run picks up first. The banner is a signal to raise
// SNAPSHOT_ROTATION_LIMIT (or add per-niche hot coverage), not an incident.
async function reportMembershipAges() {
  // Chunked by cache_key, because the whole view cannot be read inside the 8s
  // statement_timeout that PostgREST's `authenticator` role carries. Measured
  // on production: the full view is 11.9s, deduping first is 6.7s, a
  // server-side loop is 11.0s — and a single key is 10ms. Same cap and same
  // shape of fix as refresh_creator_counts. See the 2026-08-15 migration.
  //
  // The other half of the bug was worse than the timeout: this function used to
  // `return` on failure while stats.phase3_member_max_age sat at its
  // initialiser, so the summary printed "Member max age: 0d (>9d: 0)" — the
  // best possible number, produced by the check not running. Ages now start
  // UNKNOWN and only a completed sweep may set them.
  const CHUNK_KEYS = 2; // 400 rows per key; two stays under the 1000-row cap

  let keys;
  {
    const { data, error } = await supabase
      .from("rankings_cache")
      .select("cache_key")
      .order("cache_key");
    if (error) return monitorFailed(`could not list cache keys: ${error.message}`);
    keys = (data || []).map((r) => r.cache_key);
  }
  if (!keys.length) {
    console.log("  Membership monitor: rankings_cache is empty — nothing to check");
    stats.phase3_member_ages_known = true;
    stats.phase3_member_max_age = 0;
    stats.phase3_members_over_warn = 0;
    return;
  }

  // product_id -> last_snapshot_date. A product sits in many payloads; the Map
  // is what makes the counts distinct members rather than payload rows.
  const seen = new Map();
  const startedAt = Date.now();
  for (let i = 0; i < keys.length; i += CHUNK_KEYS) {
    const batch = keys.slice(i, i + CHUNK_KEYS);
    const { data, error } = await supabase.rpc("rankings_member_ages", {
      p_keys: batch,
    });
    if (error) {
      return monitorFailed(
        `chunk ${i / CHUNK_KEYS + 1}/${Math.ceil(keys.length / CHUNK_KEYS)} ` +
        `(${batch.join(", ")}) failed: ${error.message}`
      );
    }
    for (const r of data || []) seen.set(r.product_id, r.last_snapshot_date);
  }
  const sweepSecs = ((Date.now() - startedAt) / 1000).toFixed(1);

  // Age in days from the cursor. A null cursor means never snapshotted, which
  // is unbounded staleness, not zero — score it as Infinity so it cannot hide
  // inside a percentile.
  const todayMs = Date.parse(today());
  const aged = [...seen.entries()]
    .map(([product_id, last]) => ({
      product_id,
      age: last ? (todayMs - Date.parse(last)) / 86400000 : Infinity,
    }))
    .sort((a, b) => a.age - b.age);

  const never = aged.filter((a) => a.age === Infinity).length;
  const finite = aged.filter((a) => a.age !== Infinity);
  const p95 = aged[Math.min(aged.length - 1, Math.floor(aged.length * 0.95))].age;
  const max = aged[aged.length - 1].age;
  const overWarn = aged.filter((a) => a.age > MEMBER_AGE_WARN_DAYS).length;
  const breaching = aged.filter((a) => a.age > MEMBER_AGE_SLA_DAYS);

  const fmt = (v) => (v === Infinity ? "never" : `${v.toFixed(1)}d`);
  stats.phase3_member_ages_known = true;
  stats.phase3_member_max_age = max === Infinity ? -1 : Math.round(max * 10) / 10;
  stats.phase3_members_over_warn = overWarn;

  console.log(
    `  Membership monitor: ${aged.length} served products in ${keys.length} payloads ` +
    `(${sweepSecs}s) | max ${fmt(max)} | p95 ${fmt(p95)} | ` +
    `>${MEMBER_AGE_WARN_DAYS}d: ${overWarn}` +
    (never ? ` | never snapshotted: ${never}` : "") +
    (finite.length ? ` | median ${fmt(finite[Math.floor(finite.length / 2)].age)}` : "")
  );

  if (breaching.length) {
    const worst = breaching
      .slice(-5)
      .reverse()
      .map((a) => `${a.product_id} (${fmt(a.age)})`)
      .join(", ");
    console.error(
      `\n  ${"!".repeat(60)}\n` +
      `  SLA BREACH: ${breaching.length} served products exceed ${MEMBER_AGE_SLA_DAYS}d\n` +
      `  since their last snapshot. Past that span api/top-products.ts rejects\n` +
      `  their 7-day delta (MAX_SPAN_RATIO=1.5) and they fall back to estimates.\n` +
      `  Worst: ${worst}\n` +
      `  This self-heals — rotation takes the stalest first — but if it persists,\n` +
      `  add per-niche hot coverage or raise SNAPSHOT_ROTATION_LIMIT.\n` +
      `  ${"!".repeat(60)}\n`
    );
  }
}

/**
 * The only exit for a monitor that did not finish. Loud, and it leaves the
 * stats UNKNOWN rather than at a healthy-looking default — a broken alarm must
 * never be indistinguishable from a clean result.
 */
function monitorFailed(why) {
  stats.phase3_member_ages_known = false;
  stats.phase3_monitor_error = why;
  console.error(
    `\n  ${"!".repeat(60)}\n` +
    `  MONITOR FAILED — ages UNKNOWN\n` +
    `  ${why}\n` +
    `  Snapshot ages for ranked products were NOT measured this run. This is\n` +
    `  not a clean result; nothing here says the SLA is being met.\n` +
    `  ${"!".repeat(60)}\n`
  );
}

async function phase3(limitOverride) {
  console.log("\n========== PHASE 3: Snapshot All Products ==========\n");

  const snapshotDate = today();

  // Budget split. limitOverride (--phase3-only N) and the legacy
  // SNAPSHOT_TRACKED_LIMIT both cap the COMBINED set; the tiers keep their
  // configured ratio so a scoped test run still exercises both paths.
  const hardCap = limitOverride ?? (SNAPSHOT_TRACKED_LIMIT || null);
  const hotShare =
    SNAPSHOT_HOT_LIMIT / (SNAPSHOT_HOT_LIMIT + SNAPSHOT_ROTATION_LIMIT);
  const hotLimit = hardCap
    ? Math.max(1, Math.round(hardCap * hotShare))
    : SNAPSHOT_HOT_LIMIT;
  const rotationLimit = hardCap
    ? Math.max(0, hardCap - hotLimit)
    : SNAPSHOT_ROTATION_LIMIT;

  // Tier 1 — hot: highest lifetime sold_count. We re-fetch FRESH values for
  // these (not the stale stored row) so snapshots actually move day-over-day
  // and the delta model can compute real units sold.
  const hot = await fetchEligible({
    column: "sold_count",
    ascending: false,
    nullsFirst: false,
    limit: hotLimit,
    label: "hot",
  });

  // Tier 2 — rotation: least-recently-snapshotted first, NULLs (never
  // snapshotted) ahead of everything else, so the backlog drains before the
  // already-covered products are revisited.
  let rotation = { ids: [], error: null };
  if (rotationLimit > 0) {
    rotation = await fetchEligible({
      column: "last_snapshot_date",
      ascending: true,
      nullsFirst: true,
      limit: rotationLimit,
      label: "rotation",
    });
  }

  // The rotation tier depends on products.last_snapshot_date, added by
  // pipeline/last-snapshot-date.sql. If that migration has not been applied,
  // degrade to top-by-sold_count for the rotation slot rather than collapsing
  // to a partial run — but say so loudly, because coverage silently reverts.
  let degraded = false;
  if (rotation.error) {
    degraded = true;
    const fallbackLimit = rotationLimit || SNAPSHOT_ROTATION_LIMIT;
    console.error(
      `\n  ${"!".repeat(60)}\n` +
      `  ROTATION TIER UNAVAILABLE — products.last_snapshot_date is not queryable.\n` +
      `  Run pipeline/last-snapshot-date.sql in the Supabase SQL editor.\n` +
      `  Falling back to top-${fallbackLimit}-by-sold_count for this run: the long\n` +
      `  tail will NOT be snapshotted and cannot earn hasRealDelta.\n` +
      `  ${"!".repeat(60)}\n`
    );
    const fallback = await fetchEligible({
      column: "sold_count",
      ascending: false,
      nullsFirst: false,
      limit: fallbackLimit,
      label: "fallback",
    });
    rotation = { ids: fallback.ids, error: null };
  }

  // Union, hot first — a product can legitimately appear in both tiers (a
  // served product that is also overdue); it must still only be fetched once.
  // In steady state the hot set carries a fresh cursor and so sorts last in
  // rotation, which drives the overlap toward zero on its own.
  const seen = new Set();
  const trackedSet = [];
  for (const id of [...hot.ids, ...rotation.ids]) {
    if (seen.has(id)) continue;
    seen.add(id);
    trackedSet.push(id);
    if (hardCap && trackedSet.length >= hardCap) break;
  }

  const overlap = hot.ids.length + rotation.ids.length - trackedSet.length;
  console.log(
    `  Tracked set: ${trackedSet.length} products (` +
    `${hot.ids.length} hot by sold_count + ` +
    `${rotation.ids.length} ${degraded ? "FALLBACK top-by-sold" : "rotation by oldest snapshot"}, ` +
    `${overlap} overlap) | concurrency ${SNAPSHOT_CONCURRENCY}`
  );

  const parseNum = (v) =>
    v != null ? parseFloat(String(v).replace(/[^0-9.]/g, "")) || null : null;

  const snapshots = [];
  const deadIds = [];
  const relatedByProduct = new Map(); // productId -> related_videos[] (bonus payload)
  let fetched = 0, p404 = 0, errors = 0, credit402 = 0;
  // answered = HTTP 200 with a JSON body; unusable = answered but carrying no
  // sold count, price or stock. A run of nothing-but-unusable answers means
  // the response shape changed, and `aborted` stops paying for more of them.
  let answered = 0, unusable = 0, skippedAfterAbort = 0;
  let aborted = false;

  await snapshotPool(trackedSet, SNAPSHOT_CONCURRENCY, async (productId) => {
    if (aborted) { skippedAfterAbort++; return; }
    const r = await fetchProductDetailRaw(productId);
    if (r.status === 404) { p404++; deadIds.push(productId); return; }
    if (r.status === 402) { credit402++; stats.api_failures++; stats.api_402++; return; }
    if (r.status !== 200 || !r.json) { errors++; stats.api_failures++; return; }

    // Stash related_videos from the SAME response (zero extra API cost). Fully
    // guarded so nothing here can disrupt snapshot capture below. Written to the
    // DB only after snapshots are persisted (see below).
    // The response is read in ONE place (product-response.js). This block used
    // to read product_base and skus off the top level; the vendor moved both
    // under product_info while the job was down, and every product would have
    // come back as "nothing usable" — about 6,000 credits a night for no
    // sales reading at all.
    const read = readProductResponse(r.json);
    answered++;
    try {
      const rv = read.relatedVideos;
      if (Array.isArray(rv) && rv.length) relatedByProduct.set(String(productId), rv);
    } catch { /* related_videos is a bonus; never let it affect snapshots */ }

    const soldCount = read.soldCount;
    const salePrice = read.minSkuPrice;
    // Total inventory across all SKUs (skus[].stock); null if no SKUs present.
    const stock = read.stock;

    if (soldCount == null && salePrice == null && stock == null) {
      errors++;
      unusable++;
      if (!aborted && shouldAbortSnapshots({ answered, usable: fetched })) {
        aborted = true;
        console.error(
          `\n  ${"!".repeat(60)}\n` +
          `  STOPPING SNAPSHOTS: the first ${answered} product answers carried no sold\n` +
          `  count, price or stock (response layout "${read.layout}").\n` +
          `  The vendor's response shape has probably changed. Not spending the\n` +
          `  remaining credits on calls that cannot be read.\n` +
          `  Fix pipeline/product-response.js, then re-run.\n` +
          `  ${"!".repeat(60)}\n`
        );
      }
      return;
    }
    snapshots.push({
      product_id: String(productId),
      sold_count: soldCount,
      sale_price: salePrice,
      stock_quantity: stock,
      snapshot_date: snapshotDate,
    });
    fetched++;
  });

  console.log(`  Fetched fresh: ${fetched} | 404 (marked): ${p404} | transient errors: ${errors} | 402 credit failures: ${credit402}`);
  if (unusable || skippedAfterAbort) {
    console.log(`  Answered but unreadable: ${unusable} | not attempted after early stop: ${skippedAfterAbort}`);
  }

  // A night that reads no sales is a failed night, and must look like one.
  // A credit wall has its own, more specific message in main().
  const phase3Failure = credit402 > 0
    ? null
    : snapshotFailure({
        selectionError: hot.error ? hot.error.message : null,
        tracked: trackedSet.length,
        usable: fetched,
        notFound: p404,
        aborted,
      });
  if (phase3Failure) {
    stats.phase3_failure = phase3Failure;
    console.error(
      `\n  ${"!".repeat(60)}\n` +
      `  NO SALES READINGS: ${phase3Failure}.\n` +
      `  Every revenue and units figure on the site is built from these readings.\n` +
      `  Exiting NON-ZERO so this run shows red and the rankings are not rebuilt\n` +
      `  on top of old sales data as if it were new.\n` +
      `  ${"!".repeat(60)}\n`
    );
    process.exitCode = 1;
  }

  // Write snapshots (preserve composite-key upsert + insert fallback).
  // Track which ones actually landed — only those may advance the rotation
  // cursor, or a failed write would move a product to the back of the queue
  // without a snapshot to show for it.
  const written = [];
  for (let i = 0; i < snapshots.length; i += 500) {
    const chunk = snapshots.slice(i, i + 500);
    const { error } = await supabase.from("product_snapshots").upsert(chunk, {
      onConflict: "product_id,snapshot_date",
      ignoreDuplicates: false,
    });
    if (error) {
      const { error: insertErr } = await supabase
        .from("product_snapshots")
        .insert(chunk);
      if (insertErr)
        console.error("  [ERROR] Snapshots insert:", insertErr.message);
      else {
        stats.phase3_snapshots += chunk.length;
        written.push(...chunk.map((s) => s.product_id));
      }
    } else {
      stats.phase3_snapshots += chunk.length;
      written.push(...chunk.map((s) => s.product_id));
    }
  }

  // Advance the rotation cursor for everything captured this run. Products that
  // failed transiently are deliberately left untouched: they keep their old
  // last_snapshot_date, stay near the front of the queue, and are retried on the
  // next run rather than waiting out a full cycle. Skipped when the column is
  // missing — the degraded path above already explained why.
  if (!degraded && written.length) {
    let advanced = 0;
    for (let i = 0; i < written.length; i += 500) {
      const chunk = written.slice(i, i + 500);
      const { error } = await supabase
        .from("products")
        .update({ last_snapshot_date: snapshotDate })
        .in("product_id", chunk);
      if (error)
        console.error("  [ERROR] Advancing rotation cursor:", error.message);
      else advanced += chunk.length;
    }
    stats.phase3_rotation_advanced = advanced;
    console.log(`  Rotation cursor advanced for ${advanced} products`);
  }

  // Mark permanently-unavailable products — but only on the SECOND consecutive
  // 404. A single 404 is a strike; price_unavailable is a hard latch that drops
  // a product from ranking and snapshotting, and one transient 404 used to be
  // enough to set it (probes/SNAPSHOT-COVERAGE.md §8 found a live product
  // behind the flag). Strikes live in the products table, not the fail-tracker
  // file, because the runner is a fresh checkout every night — see
  // pipeline/price-strikes.js.
  const dead = await recordDead404s(supabase, deadIds);
  if (dead.error) console.error("  [ERROR] mark unavailable:", dead.error);
  stats.phase3_404_flagged = dead.flagged;
  stats.phase3_404_first_strike = dead.firstStrike;
  if (deadIds.length) {
    console.log(
      `  404s: ${dead.flagged} flagged unavailable (${STRIKES_TO_FLAG}nd consecutive), ` +
      `${dead.firstStrike} on a first strike (retried next run)`
    );
  }

  // A product that answered is alive: wipe any strike it was carrying, so the
  // two must be CONSECUTIVE rather than merely cumulative over months.
  const revivedStrikes = await clearStrikes(supabase, written);
  if (revivedStrikes.error)
    console.error("  [ERROR] clear 404 strikes:", revivedStrikes.error);
  else if (revivedStrikes.cleared)
    console.log(`  404 strikes cleared for ${revivedStrikes.cleared} products that answered`);

  // Bonus payload: persist related_videos mined from the Product Details
  // responses we already paid for. Fully isolated — any failure here (including
  // the new columns not yet existing) logs and continues; the snapshots written
  // above are the crown jewels and are never affected.
  try {
    const rel = await upsertRelatedVideos(relatedByProduct);
    stats.phase3_related_inserted = rel.inserted;
    stats.phase3_related_updated = rel.updated;
    console.log(
      `  Phase 3 related_videos: ${rel.inserted} inserted, ${rel.updated} updated, ${rel.skipped} unchanged, ` +
      `${rel.constraintSkipped} dup-skipped (from ${rel.products} products, ${rel.candidates} candidate videos)`
    );
    // On scoped verification runs (--phase3-only N), print a per-product table
    // and a before/after ≥1-video coverage summary. Suppressed on full cron runs.
    if (limitOverride != null && rel.perProduct.length) {
      const withCoverageBefore = rel.perProduct.filter((p) => p.before > 0).length;
      const withCoverageAfter = rel.perProduct.filter((p) => p.before + p.inserts > 0).length;
      console.log(`\n  --- per-product (${rel.perProduct.length} products) ---`);
      console.log("  product_id            before  inserts  updates  unchanged  after");
      for (const p of rel.perProduct.sort((a, b) => b.inserts - a.inserts)) {
        console.log(
          `  ${String(p.productId).padEnd(20)} ${String(p.before).padStart(6)} ${String(p.inserts).padStart(8)} ` +
          `${String(p.updates).padStart(8)} ${String(p.unchanged).padStart(10)} ${String(p.before + p.inserts).padStart(6)}`
        );
      }
      console.log(`\n  Coverage (>=1 video): before ${withCoverageBefore}/${rel.perProduct.length} -> after ${withCoverageAfter}/${rel.perProduct.length}`);
    }
  } catch (e) {
    console.error("  [WARN] related_videos mining failed (snapshots unaffected):", e.message);
  }

  console.log(`  Phase 3 done: ${stats.phase3_snapshots} snapshots created (fresh-fetched)`);
}

// ---------------------------------------------------------------------------
// Phase 4 — Fill Missing Prices
// ---------------------------------------------------------------------------

async function phase4() {
  console.log("\n========== PHASE 4: Fill Missing Prices ==========\n");

  // Load fail tracker
  const failTrackerPath = join(__dirname, "price-fail-tracker.json");
  let failTracker = {};
  if (existsSync(failTrackerPath)) {
    try {
      failTracker = JSON.parse(readFileSync(failTrackerPath, "utf8"));
    } catch {
      failTracker = {};
    }
  }

  // Fetch products missing price OR sold_count — limit to 200 per run to stay
  // within GitHub Actions timeout (one API call per product with 250ms delay).
  const MAX_LOOKUPS = 200;
  const { data: products, error } = await supabase
    .from("products")
    .select("product_id, sale_price, sold_count, price_unavailable")
    .or("sale_price.is.null,sale_price.eq.0,sold_count.is.null,sold_count.eq.0")
    .limit(MAX_LOOKUPS);

  if (error) {
    console.error("  [ERROR] Fetching products needing enrichment:", error.message);
    return;
  }

  console.log(`  Found ${products?.length || 0} products needing price/sold data (max ${MAX_LOOKUPS} per run)`);

  let filled = 0;
  let revived = 0;
  for (const p of products || []) {
    // Skip if failed 3+ times
    if ((failTracker[p.product_id] || 0) >= 3) continue;

    try {
      // API expects a URL, not a bare product_id. region pins the price to
      // the US market (does not affect whether the product resolves).
      const productUrl = `https://www.tiktok.com/shop/pdp/${p.product_id}`;
      const data = await apiFetch(
        `/v1/tiktok/product?url=${encodeURIComponent(productUrl)}&region=${encodeURIComponent(REGION)}`
      );
      await sleep(RATE_LIMIT_MS);

      // Read through product-response.js: these fields moved under
      // product_info in 2026, and a top-level read finds none of them.
      const read = readProductResponse(data);
      const price = read.minSkuPrice;
      const updateFields = { updated_at: new Date().toISOString() };
      let hasUpdate = false;

      // Reaching here means apiFetch got a 2xx — the listing resolves, so the
      // product is NOT dead. price_unavailable was a one-way latch: it is set
      // on a single unconfirmed 404 (phase3, and backfill-prices.js) and
      // nothing ever cleared it, so one transient 404 removed a product from
      // ranking and snapshotting permanently.
      //
      // Verified 2026-07-27: product 1730154985083670905 was flagged, yet a
      // live fetch returned 200 with sold_count 137,916 against 134,044 stored
      // — 3,872 units sold while it was excluded as "dead".
      //
      // Phase 4 is the right place for this: its query filters on
      // sale_price/sold_count only, so it still fetches flagged products every
      // run. Phase 3 cannot host the clear — its tracked set excludes
      // price_unavailable rows by construction, so flagged products are never
      // fetched there and the latch could never open.
      if (p.price_unavailable === true) {
        updateFields.price_unavailable = false;
        hasUpdate = true;
        revived++;
      }

      // Fill price if available
      if (price != null && parseFloat(price) > 0) {
        updateFields.sale_price = parseFloat(price);
        hasUpdate = true;
      }
      if (read.originalPrice != null) { updateFields.original_price = read.originalPrice; hasUpdate = true; }
      // Fill sold_count if available
      if (read.soldCount != null && read.soldCount > 0) {
        updateFields.sold_count = read.soldCount;
        hasUpdate = true;
      }
      // Fill other fields
      if (read.title) { updateFields.title = read.title; hasUpdate = true; }
      if (read.imageUrl) { updateFields.image_url = read.imageUrl; hasUpdate = true; }
      if (read.sellerName) { updateFields.seller_name = read.sellerName; hasUpdate = true; }
      if (read.sellerId) { updateFields.seller_id = String(read.sellerId); hasUpdate = true; }

      if (hasUpdate) {
        const { error: updateErr } = await supabase
          .from("products")
          .update(updateFields)
          .eq("product_id", p.product_id);

        if (!updateErr) {
          filled++;
          delete failTracker[p.product_id];
        }
      } else {
        failTracker[p.product_id] = (failTracker[p.product_id] || 0) + 1;
      }
    } catch (err) {
      const credit = recordApiFailure(err);
      console.warn(
        `    [WARN] Price fetch failed for ${p.product_id}: ${err.message}`
      );
      // A credit wall is not this product's fault — don't spend one of its
      // three fail-tracker strikes on an account-level outage.
      if (!credit) failTracker[p.product_id] = (failTracker[p.product_id] || 0) + 1;
    }
  }

  // Save fail tracker
  writeFileSync(failTrackerPath, JSON.stringify(failTracker, null, 2));

  stats.phase4_prices_filled = filled;
  if (revived) {
    console.log(
      `  Phase 4 revived ${revived} products: fetch returned 200, so a stale ` +
      `price_unavailable latch was cleared (they re-enter ranking + snapshotting)`
    );
  }
  stats.phase4_revived = revived;
  console.log(`  Phase 4 done: ${filled} prices filled`);
}

// ---------------------------------------------------------------------------
// Phase 5 — Refresh Thumbnails
// ---------------------------------------------------------------------------

async function phase5() {
  console.log("\n========== PHASE 5: Refresh Thumbnails ==========\n");

  const { data: videos, error } = await supabase
    .from("product_videos")
    .select("id, video_url")
    .order("view_count", { ascending: false })
    .limit(200);

  if (error) {
    console.error("  [ERROR] Fetching top videos:", error.message);
    return;
  }

  console.log(`  Refreshing thumbnails for ${videos?.length || 0} videos`);

  let updated = 0;
  for (const v of videos || []) {
    try {
      const oembedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(v.video_url)}`;
      const res = await fetch(oembedUrl);
      await sleep(RATE_LIMIT_MS);

      if (!res.ok) continue;

      const data = await res.json();
      const thumbnailUrl = data?.thumbnail_url;
      if (!thumbnailUrl) continue;

      const { error: updateErr } = await supabase
        .from("product_videos")
        .update({ cover_image_url: thumbnailUrl })
        .eq("id", v.id);

      if (!updateErr) updated++;
    } catch (err) {
      console.warn(
        `    [WARN] oEmbed failed for video ${v.id}: ${err.message}`
      );
    }
  }

  stats.phase5_thumbnails = updated;
  console.log(`  Phase 5 done: ${updated} thumbnails refreshed`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const startTime = Date.now();
  console.log(`tikbase daily refresh started at ${new Date().toISOString()}`);

  await phase1();
  await phase2();
  await phase3();
  await phase4();
  await phase5();

  // Runs after phase3 has advanced the cursor, so it measures the state the
  // next run will actually inherit. Never throws the run — see the function.
  await reportMembershipAges();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log("\n========== SUMMARY ==========\n");
  console.log(`  Phase 1 — Videos discovered:    ${stats.phase1_videos}`);
  console.log(`  Phase 1 — Products from videos: ${stats.phase1_products}`);
  console.log(`  Phase 2 — Products from shop:   ${stats.phase2_products}`);
  console.log(`  Phase 2 — Birth snapshots:      ${stats.phase2_birth_snapshots}`);
  console.log(`  Phase 3 — Snapshots created:    ${stats.phase3_snapshots}`);
  console.log(`  Phase 3 — Rotation advanced:    ${stats.phase3_rotation_advanced}`);
  console.log(
    `  Phase 3 — Member max age:       ` +
    (!stats.phase3_member_ages_known
      ? `UNKNOWN — MONITOR FAILED (${stats.phase3_monitor_error || "see above"})`
      : (stats.phase3_member_max_age < 0
          ? "never-snapshotted present"
          : stats.phase3_member_max_age + "d") +
        ` (>${MEMBER_AGE_WARN_DAYS}d: ${stats.phase3_members_over_warn})`)
  );
  console.log(`  Phase 3 — 404 flagged/1st strike: ${stats.phase3_404_flagged} / ${stats.phase3_404_first_strike}`);
  console.log(`  Phase 3 — Related vids inserted: ${stats.phase3_related_inserted}`);
  console.log(`  Phase 3 — Related vids updated:  ${stats.phase3_related_updated}`);
  console.log(`  Phase 4 — Prices filled:        ${stats.phase4_prices_filled}`);
  console.log(`  Phase 4 — Revived (flag cleared): ${stats.phase4_revived}`);
  console.log(`  Phase 5 — Thumbnails refreshed: ${stats.phase5_thumbnails}`);
  console.log(`  API failures:                   ${stats.api_failures} (402 / credit wall: ${stats.api_402})`);
  if (stats.phase3_failure) {
    console.log(`  Phase 3 — FAILED:               ${stats.phase3_failure}`);
  }
  console.log(`\n  Total time: ${elapsed}s`);

  // A credit wall silently zeroes every phase above. Make it impossible to miss.
  if (stats.api_402 > 0) {
    console.error(
      `\n  ${"!".repeat(60)}\n` +
      `  CREDIT WALL: ${stats.api_402} ScrapeCreators calls failed with HTTP 402.\n` +
      `  402 = out of credits OR an invalid/revoked API key (the vendor returns it for both).\n` +
      `  The phase counts above are INCOMPLETE — snapshots/prices/videos were skipped.\n` +
      `  Top up credits and re-run before trusting today's data.\n` +
      `  Exiting NON-ZERO so this run shows red in Actions.\n` +
      `  ${"!".repeat(60)}`
    );
    // Exit red. Before this, a fully credit-starved run reported success: on
    // 2026-07-20 every phase finished at 0 and the job was still green, so the
    // outage was invisible until someone read the logs.
    //
    // Safe to fail loudly because the run is resumable by construction —
    // rotation orders by last_snapshot_date ASC NULLS FIRST and the cursor only
    // advances for products whose snapshot row actually landed. Whatever a
    // credit-starved run failed to fetch keeps its old (or NULL) cursor and is
    // therefore at the FRONT of the queue on the next run. No state to unwind,
    // no manual catch-up: topping up credits and letting the next cron fire is
    // the whole recovery procedure.
    process.exitCode = 1;
  }
  // ---- Credit early warning -------------------------------------------
  // Reports the balance and what this run actually burned, then projects how
  // many more runs fit. The existing block above only speaks once 402s have
  // already happened; by then a day of collection is gone. This speaks while
  // there is still time to top up.
  if (stats.credits_remaining !== null) {
    const burned =
      stats.credits_at_start !== null
        ? Math.max(0, stats.credits_at_start - stats.credits_remaining)
        : null;
    const runsLeft = burned && burned > 0
      ? Math.floor(stats.credits_remaining / burned)
      : null;
    console.log(
      `\nCredits: ${stats.credits_remaining.toLocaleString()} remaining` +
      (burned !== null ? ` | this run burned ~${burned.toLocaleString()} over ${stats.api_calls} calls` : '') +
      (runsLeft !== null ? ` | ~${runsLeft} more run(s) at this rate` : ''),
    );
    // Two runs of headroom: enough to notice on a weekday and act before the
    // next cron fires. Warn loudly but do NOT fail the run — the data collected
    // is still good, and a red build for a balance that is merely low would
    // train people to ignore red builds.
    if (runsLeft !== null && runsLeft <= 2) {
      console.warn(
        `\n  ${"!".repeat(60)}\n` +
        `  CREDIT WARNING: only ~${runsLeft} run(s) of headroom left ` +
        `(${stats.credits_remaining.toLocaleString()} credits, ~${burned.toLocaleString()}/run).\n` +
        `  Top up before the next scheduled run or it will starve mid-way, as on\n` +
        `  2026-07-19/20 and again 2026-07-31..08-02.\n` +
        `  ${"!".repeat(60)}`,
      );
    }
  } else {
    console.warn('\nCredits: balance unknown — no vendor response carried credits_remaining.');
  }

  console.log(`\ntikbase daily refresh completed at ${new Date().toISOString()}`);
}

// Entry: the daily cron runs the full pipeline. `--phase3-only [N]` runs just
// Phase 3 (optionally on the first N tracked products) for isolated testing —
// the cron command is unchanged, so this does not affect scheduled runs.
if (process.argv.includes("--phase3-only")) {
  const n = process.argv.slice(2).find((a) => /^\d+$/.test(a));
  phase3(n ? Number(n) : undefined)
    .then(() => process.exit(stats.api_402 > 0 ? 1 : 0))
    .catch((err) => { console.error("Fatal error:", err); process.exit(1); });
} else {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
