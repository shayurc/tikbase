/**
 * backfill-prices.js
 *
 * Standalone, on-demand backfill for products with null/zero sale_price.
 * NOT part of the daily cron. Pages through the FULL null-price backlog and
 * fetches each via the ScrapeCreators product-detail endpoint with bounded
 * concurrency (max 10 in flight), then writes price/sold_count/title/seller.
 *
 * Products that 404 TWICE IN A ROW are marked `price_unavailable = true` so
 * future runs skip them; a single 404 only records a strike, because the flag
 * is a hard latch and one transient 404 used to be enough to set it (see
 * pipeline/price-strikes.js). Junk (non-numeric product_id) is still marked on
 * sight — it can never resolve, so there is nothing to confirm. Resumable: a
 * re-run only re-fetches products that are still null and not yet marked.
 *
 * Usage:
 *   node --env-file=.env pipeline/backfill-prices.js          # full backlog
 *   node --env-file=.env pipeline/backfill-prices.js 500      # first 500 only
 *
 * Requires: SCRAPECREATORS_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * Optional: SCRAPECREATORS_REGION (default "US")
 *
 * Prerequisite for marking:
 *   ALTER TABLE products ADD COLUMN price_unavailable boolean DEFAULT false;
 *   ALTER TABLE products ADD COLUMN price_404_strikes smallint NOT NULL DEFAULT 0;
 * If the column is absent the script still backfills prices but logs would-be
 * marks instead of writing them.
 */

import { createClient } from "@supabase/supabase-js";
import { recordDead404s, clearStrikes, STRIKES_TO_FLAG } from "./price-strikes.js";
import { readProductResponse } from "./product-response.js";

const SCRAPECREATORS_API_KEY = process.env.SCRAPECREATORS_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SCRAPECREATORS_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    "Missing required env vars: SCRAPECREATORS_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY"
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const API_BASE = "https://api.scrapecreators.com";
const REGION = process.env.SCRAPECREATORS_REGION || "US";
const CONCURRENCY = 10; // bounded in-flight requests
const REQ_TIMEOUT_MS = 20000; // safety: stop one hung socket stalling the pool
const PROGRESS_EVERY = 500;

// Optional positional limit, e.g. `node pipeline/backfill-prices.js 500`
const limitArg = process.argv.slice(2).find((a) => /^\d+$/.test(a));
const LIMIT = limitArg ? Number(limitArg) : Infinity;
// Pass `latest` (or BACKFILL_ORDER=desc) to process newest product_ids first.
const ORDER_DESC = process.argv.slice(2).includes("latest") || process.env.BACKFILL_ORDER === "desc";

const isNumericId = (id) => /^\d+$/.test(String(id));

async function apiFetchRaw(productId) {
  const url = `https://www.tiktok.com/shop/pdp/${productId}`;
  const path = `/v1/tiktok/product?url=${encodeURIComponent(url)}&region=${encodeURIComponent(REGION)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { "x-api-key": SCRAPECREATORS_API_KEY },
      signal: ctrl.signal,
    });
    const text = await res.text().catch(() => "");
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json };
  } catch (e) {
    return { status: 0, json: null, err: e.name === "AbortError" ? "timeout" : e.message };
  } finally {
    clearTimeout(timer);
  }
}

// Extraction goes through product-response.js, the one place that knows the
// vendor's response layout (it moved under product_info in 2026).
// Returns the fields to update, or null if no usable price was found.
function extractFields(data) {
  const read = readProductResponse(data);
  const fields = { updated_at: new Date().toISOString() };
  let hasPrice = false;

  if (read.minSkuPrice != null) {
    fields.sale_price = read.minSkuPrice;
    hasPrice = true;
  }
  if (read.originalPrice != null) fields.original_price = read.originalPrice;
  if (read.soldCount != null && read.soldCount > 0) fields.sold_count = read.soldCount;
  if (read.title) fields.title = read.title;
  if (read.imageUrl) fields.image_url = read.imageUrl;
  if (read.sellerName) fields.seller_name = read.sellerName;
  if (read.sellerId) fields.seller_id = String(read.sellerId);

  return hasPrice ? fields : null;
}

// Bounded-concurrency pool — never Promise.all the whole list.
async function runPool(items, concurrency, worker, onProgress) {
  let next = 0, done = 0;
  async function runner() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i]);
      done++;
      if (onProgress && done % PROGRESS_EVERY === 0) onProgress(done, items.length);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, runner));
}

// Both columns the marking path needs: the latch and the strike counter it is
// now gated on. Missing either one disables marking rather than half-applying
// the rule.
async function columnExists() {
  const { error } = await supabase
    .from("products")
    .select("price_unavailable, price_404_strikes")
    .limit(1);
  return !error;
}

// Page through ALL null/zero-price products not already marked unavailable.
async function fetchBacklog(canMark, limit) {
  const ids = [];
  const PAGE = 1000;
  for (let from = 0; ids.length < limit; from += PAGE) {
    let q = supabase
      .from("products")
      .select("product_id")
      .or("sale_price.is.null,sale_price.eq.0")
      .order("product_id", { ascending: !ORDER_DESC })
      .range(from, from + PAGE - 1);
    if (canMark) q = q.or("price_unavailable.is.null,price_unavailable.eq.false");
    const { data, error } = await q;
    if (error) throw new Error("Fetch backlog: " + error.message);
    if (!data?.length) break;
    ids.push(...data.map((r) => r.product_id));
    if (data.length < PAGE) break;
  }
  return ids.slice(0, limit === Infinity ? undefined : limit);
}

async function markUnavailable(ids, canMark) {
  if (!canMark || ids.length === 0) return;
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const { error } = await supabase
      .from("products")
      .update({ price_unavailable: true })
      .in("product_id", chunk);
    if (error) console.error("  [ERROR] mark unavailable:", error.message);
  }
}

async function main() {
  const startedAt = Date.now();
  console.log(`backfill-prices started ${new Date().toISOString()} | region=${REGION} | concurrency=${CONCURRENCY} | limit=${LIMIT === Infinity ? "ALL" : LIMIT} | order=${ORDER_DESC ? "newest-first" : "oldest-first"}`);

  const canMark = await columnExists();
  if (!canMark) {
    console.warn(
      "  [WARN] products.price_unavailable or price_404_strikes is MISSING — marking disabled.\n" +
      "         Run: ALTER TABLE products ADD COLUMN price_unavailable boolean DEFAULT false;\n" +
      "              ALTER TABLE products ADD COLUMN price_404_strikes smallint NOT NULL DEFAULT 0;\n" +
      "         (Prices are still backfilled; 404/junk are only counted as would-be marks.)"
    );
  }

  const backlog = await fetchBacklog(canMark, LIMIT);
  console.log(`  Backlog to process this run: ${backlog.length}\n`);

  const stats = { attempted: 0, priced: 0, p404: 0, error: 0, skippedJunk: 0 };
  const deadIds = [];  // 404 -> one strike, flagged on the second
  const junkIds = [];  // non-numeric ids -> flagged immediately
  const aliveIds = []; // answered -> any strike is wiped

  await runPool(
    backlog,
    CONCURRENCY,
    async (productId) => {
      stats.attempted++;

      // Junk (non-numeric) ids can never resolve — mark, don't call the API.
      // Deterministic, so it needs no second opinion and skips the strike path.
      if (!isNumericId(productId)) {
        stats.skippedJunk++;
        junkIds.push(productId);
        return;
      }

      const r = await apiFetchRaw(productId);

      if (r.status === 404) {
        stats.p404++;
        deadIds.push(productId);
        return;
      }
      if (r.status !== 200 || !r.json) {
        stats.error++; // transient (timeout/5xx) — leave for a future run
        return;
      }

      const fields = extractFields(r.json);
      if (!fields) {
        stats.error++; // 200 but no usable price — do not mark permanently
        return;
      }

      const { error } = await supabase
        .from("products")
        .update(fields)
        .eq("product_id", productId);
      if (error) {
        stats.error++;
        console.error(`  [ERROR] update ${productId}: ${error.message}`);
      } else {
        stats.priced++;
        aliveIds.push(productId);
      }
    },
    (done, total) => {
      const rate = (done / ((Date.now() - startedAt) / 1000)).toFixed(1);
      console.log(`  ...${done}/${total} processed | priced=${stats.priced} 404=${stats.p404} err=${stats.error} junk=${stats.skippedJunk} | ${rate} req/s`);
    }
  );

  await markUnavailable(junkIds, canMark);

  // 404s: a strike each, the latch only on the second consecutive one.
  const dead = canMark
    ? await recordDead404s(supabase, deadIds)
    : { flagged: 0, firstStrike: 0, error: null };
  if (dead.error) console.error("  [ERROR] record 404 strikes:", dead.error);
  // A product that priced successfully is alive — clear whatever it carried.
  const revived = canMark
    ? await clearStrikes(supabase, aliveIds)
    : { cleared: 0, error: null };
  if (revived.error) console.error("  [ERROR] clear 404 strikes:", revived.error);

  const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n=== SUMMARY ===`);
  console.log(`  attempted:      ${stats.attempted}`);
  console.log(`  priced:         ${stats.priced}`);
  console.log(`  404:            ${stats.p404}`);
  console.log(`  error (transient): ${stats.error}`);
  console.log(`  skipped-junk:   ${stats.skippedJunk}`);
  console.log(`  404 flagged (${STRIKES_TO_FLAG}nd strike): ${canMark ? dead.flagged : `0 (would mark — column missing)`}`);
  console.log(`  404 first strike (retry later): ${canMark ? dead.firstStrike : stats.p404}`);
  console.log(`  strikes cleared (priced OK):   ${revived.cleared}`);
  console.log(`  junk marked unavailable:       ${canMark ? junkIds.length : `0 (would mark ${junkIds.length} — column missing)`}`);
  console.log(`  wall-clock:     ${secs}s  (${(stats.attempted / secs).toFixed(1)} req/s)`);
  console.log(`backfill-prices done ${new Date().toISOString()}`);
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
