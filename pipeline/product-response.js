/**
 * Reading the vendor's product-page response, whatever shape it arrives in.
 *
 * WHY THIS FILE EXISTS
 * Until August 2026 `GET /v1/tiktok/product` answered with `product_base`,
 * `skus` and `seller` at the top level, and three places read them there. While
 * the nightly job was down the vendor moved them one level down:
 *
 *   measured 2026-11-13, one live call, product 1729508370969629931
 *   top-level keys: success, credits_remaining, credits_charged, categories,
 *     sale_region, error_code, error_message, product_info, shop_performance,
 *     shop_info, shop_review_entry, related_videos
 *   product_info keys: product_id, status, seller, product_base, sale_props,
 *     skus, product_detail_review, seller_id
 *   product_info.product_base.sold_count = 1208758, price.min_sku_price = 27.30
 *
 * With the old top-level read every product came back as "nothing usable": a
 * night would have spent about 6,000 credits, stored no sales reading at all,
 * counted them as transient errors and finished green.
 *
 * So the shape is decided HERE, once, and every caller asks this file. All
 * three layouts ever seen are accepted (top level, under `product_info`, and
 * the `data`-wrapped form phase 4 already tolerated), so a vendor that moves
 * it back does not break the job a second time.
 *
 * Pure: no network, no database. Tested in product-response.test.js.
 */

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * TikTok's exact lifetime sold counter, as an integer, or null.
 *
 * Only a plain number or a string of digits counts. The response also carries
 * rounded display strings ("1.2M", "10K+" in format_sold_count); parsing one of
 * those as a number would store 1 or 10 as a product's lifetime sales and turn
 * the next reading into a huge fake jump, so anything that is not purely
 * digits is refused rather than guessed at.
 */
export function toExactCount(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }
  return null;
}

/** "$27.30" / "27.30" / 27.3 -> 27.3, or null when there is no positive price. */
export function toPrice(value) {
  if (value === null || value === undefined) return null;
  const n = Number.parseFloat(String(value).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Pull the fields the pipeline uses out of one product-page response.
 * Never throws; a response it cannot read comes back with layout
 * "unrecognised" and every field null, which callers must treat as
 * "no reading", never as zero.
 */
export function readProductResponse(json) {
  const root = isObject(json) ? json : {};
  const wrapped = isObject(root.data) ? root.data : null;

  // Most specific first. `root` is tried before the wrapper so the layout the
  // job ran on for months keeps its exact old behaviour.
  const holders = [
    ["product_info", root.product_info],
    ["top_level", root],
    ["data_product_info", wrapped?.product_info],
    ["data_wrapped", wrapped],
  ];
  let layout = "unrecognised";
  let holder = null;
  for (const [name, candidate] of holders) {
    if (isObject(candidate) && isObject(candidate.product_base)) {
      layout = name;
      holder = candidate;
      break;
    }
  }

  const base = holder ? holder.product_base : null;
  const skus = holder && Array.isArray(holder.skus) ? holder.skus : null;
  const seller = (holder && isObject(holder.seller) ? holder.seller : null)
    || (isObject(root.seller) ? root.seller : null);
  const shop = (isObject(root.shop_info) ? root.shop_info : null)
    || (wrapped && isObject(wrapped.shop_info) ? wrapped.shop_info : null);
  const related = Array.isArray(root.related_videos)
    ? root.related_videos
    : wrapped && Array.isArray(wrapped.related_videos)
      ? wrapped.related_videos
      : [];

  return {
    layout,
    soldCount: toExactCount(base?.sold_count),
    minSkuPrice: toPrice(base?.price?.min_sku_price),
    originalPrice: toPrice(base?.price?.original_price),
    title: typeof base?.title === "string" && base.title ? base.title : null,
    imageUrl: base?.images?.[0]?.url_list?.[0] || null,
    // Total inventory across all SKUs; null when the response has no SKU list
    // (which is "not stated", not "out of stock").
    stock: skus ? skus.reduce((sum, s) => sum + (Number(s?.stock) || 0), 0) : null,
    skuCount: skus ? skus.length : null,
    sellerName: seller?.name || shop?.shop_name || null,
    sellerId: seller?.seller_id || holder?.seller_id || shop?.seller_id || null,
    relatedVideos: related,
  };
}

/**
 * Should the snapshot phase stop spending credits?
 *
 * Each product read costs one credit whether or not anything usable comes
 * back. If the first answers are all HTTP 200 and not one carries a sold count,
 * price or stock, the response shape has changed again and the remaining
 * thousands of calls would buy nothing. Forty is enough to rule out a run of
 * genuinely odd products and costs forty credits to find out.
 */
export const LAYOUT_CHECK_AFTER = 40;

export function shouldAbortSnapshots({ answered, usable }) {
  return answered >= LAYOUT_CHECK_AFTER && usable === 0;
}

/**
 * Did the snapshot phase do its job? Returns null when it did, or a sentence
 * saying why not. A night that reads no sales must not look like a success:
 * on 2026-11-13 both product-selection queries timed out, the tracked set was
 * empty, zero snapshots were stored, and the run finished green and rebuilt
 * every ranking on three-month-old sales.
 */
export function snapshotFailure({ selectionError, tracked, usable, notFound, aborted }) {
  if (aborted) {
    return (
      "the vendor's product response carried no sold count, price or stock in any of the " +
      "first answers, so the layout has probably changed; stopped early to save credits"
    );
  }
  if (tracked === 0) {
    return selectionError
      ? `could not choose which products to read (${selectionError})`
      : "no products were selected for a sales reading";
  }
  const reachable = tracked - notFound;
  if (reachable > 0 && usable === 0) {
    return `none of the ${reachable} products read returned a usable sales reading`;
  }
  // A handful of failures is normal; losing most of the night is not.
  if (reachable >= 100 && usable < reachable * 0.5) {
    return `only ${usable} of ${reachable} products read returned a usable sales reading`;
  }
  return null;
}
