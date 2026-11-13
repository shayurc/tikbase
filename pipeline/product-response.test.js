/**
 * product-response.js — reading the vendor's product page, in every layout it
 * has been seen in, and noticing when a night reads nothing.
 *
 * The fixtures are trimmed copies of real shapes. The "product_info" one is the
 * layout measured live on 2026-11-13; the "top_level" one is the layout the job
 * ran on until August 2026. No network, no database.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  readProductResponse,
  toExactCount,
  toPrice,
  shouldAbortSnapshots,
  snapshotFailure,
  LAYOUT_CHECK_AFTER,
} from "./product-response.js";

const BASE = {
  title: "Cooling Mattress Topper",
  sold_count: 1208758,
  price: { min_sku_price: "27.30", original_price: "$59.99" },
  images: [{ url_list: ["https://example.test/a.webp"] }],
};
const SKUS = [{ stock: 120 }, { stock: 30 }, { stock: "50" }, {}];
const RELATED = [{ item_id: "7412345678901234567", play_count: 9000 }];

// Measured 2026-11-13: everything about the product is under product_info.
const NEW_LAYOUT = {
  success: true,
  credits_remaining: 24079,
  product_info: {
    product_id: "1729508370969629931",
    seller: { name: "Bedlore", seller_id: "7495514739648989419" },
    product_base: BASE,
    skus: SKUS,
    seller_id: "7495514739648989419",
  },
  shop_info: { seller_id: "7495514739648989419", shop_name: "Bedlore Shop", format_sold_count: "1.2M" },
  related_videos: RELATED,
};

// Until August 2026: the same things at the top level.
const OLD_LAYOUT = {
  product_base: BASE,
  skus: SKUS,
  seller: { name: "Bedlore", seller_id: "7495514739648989419" },
  related_videos: RELATED,
};

const expectFull = (read, layout) => {
  assert.equal(read.layout, layout);
  assert.equal(read.soldCount, 1208758);
  assert.equal(read.minSkuPrice, 27.3);
  assert.equal(read.originalPrice, 59.99);
  assert.equal(read.title, "Cooling Mattress Topper");
  assert.equal(read.imageUrl, "https://example.test/a.webp");
  assert.equal(read.stock, 200);
  assert.equal(read.skuCount, 4);
  assert.equal(read.sellerName, "Bedlore");
  assert.equal(read.sellerId, "7495514739648989419");
  assert.deepEqual(read.relatedVideos, RELATED);
};

test("THE BUG: the layout the vendor serves now (under product_info) is read in full", () => {
  // The old code read json.product_base and json.skus, both undefined here, so
  // every product was dropped as "nothing usable".
  assert.equal(NEW_LAYOUT.product_base, undefined);
  assert.equal(NEW_LAYOUT.skus, undefined);
  expectFull(readProductResponse(NEW_LAYOUT), "product_info");
});

test("the layout the job ran on until August 2026 still reads the same", () => {
  expectFull(readProductResponse(OLD_LAYOUT), "top_level");
});

test("a data-wrapped response is read too, in either inner shape", () => {
  expectFull(readProductResponse({ data: OLD_LAYOUT }), "data_wrapped");
  expectFull(readProductResponse({ data: NEW_LAYOUT }), "data_product_info");
});

test("the seller falls back to shop_info when the product carries none", () => {
  const read = readProductResponse({
    product_info: { product_base: BASE },
    shop_info: { seller_id: "42", shop_name: "Shop Forty-Two" },
  });
  assert.equal(read.sellerName, "Shop Forty-Two");
  assert.equal(read.sellerId, "42");
});

test("an unreadable response is 'no reading', never zero, and never throws", () => {
  for (const junk of [null, undefined, "", "error", 7, [], {}, { success: false }, { product_info: null }, { product_info: { skus: SKUS } }]) {
    const read = readProductResponse(junk);
    assert.equal(read.layout, "unrecognised");
    assert.equal(read.soldCount, null);
    assert.equal(read.minSkuPrice, null);
    assert.equal(read.stock, null); // not 0: an absent SKU list is not "out of stock"
    assert.deepEqual(read.relatedVideos, []);
  }
});

test("related videos survive even when the product part is unreadable", () => {
  const read = readProductResponse({ related_videos: RELATED });
  assert.equal(read.layout, "unrecognised");
  assert.deepEqual(read.relatedVideos, RELATED);
});

test("no SKU list is null stock; an empty SKU list is zero stock", () => {
  assert.equal(readProductResponse({ product_info: { product_base: BASE } }).stock, null);
  assert.equal(readProductResponse({ product_info: { product_base: BASE, skus: [] } }).stock, 0);
});

test("toExactCount takes the exact counter and refuses the rounded display string", () => {
  assert.equal(toExactCount(1208758), 1208758);
  assert.equal(toExactCount("1208758"), 1208758);
  assert.equal(toExactCount(0), 0);
  assert.equal(toExactCount(12.9), 12);
  // "1.2M" parsed as a number would store 1 as lifetime sales.
  for (const rounded of ["1.2M", "10K+", "1,208,758", "12 sold", "", " ", null, undefined, NaN, -5, {}, []]) {
    assert.equal(toExactCount(rounded), null, String(rounded));
  }
});

test("toPrice reads the formats the vendor uses and has no zero price", () => {
  assert.equal(toPrice("27.30"), 27.3);
  assert.equal(toPrice("$59.99"), 59.99);
  assert.equal(toPrice(12), 12);
  for (const none of [null, undefined, "", "0", 0, "free", "$0.00"]) {
    assert.equal(toPrice(none), null, String(none));
  }
});

test("snapshots stop early only when a full first batch is all unreadable", () => {
  assert.equal(shouldAbortSnapshots({ answered: LAYOUT_CHECK_AFTER, usable: 0 }), true);
  assert.equal(shouldAbortSnapshots({ answered: LAYOUT_CHECK_AFTER * 10, usable: 0 }), true);
  // Too early to tell, or at least one product read fine: keep going.
  assert.equal(shouldAbortSnapshots({ answered: LAYOUT_CHECK_AFTER - 1, usable: 0 }), false);
  assert.equal(shouldAbortSnapshots({ answered: 5000, usable: 1 }), false);
});

test("snapshotFailure: a healthy night is not a failure", () => {
  assert.equal(snapshotFailure({ selectionError: null, tracked: 6000, usable: 5700, notFound: 120, aborted: false }), null);
  // A small night with a few misses is fine too.
  assert.equal(snapshotFailure({ selectionError: null, tracked: 50, usable: 30, notFound: 5, aborted: false }), null);
});

test("snapshotFailure: 13 Nov 2026 — selection timed out, nothing tracked, run was green", () => {
  const why = snapshotFailure({
    selectionError: "canceling statement due to statement timeout",
    tracked: 0, usable: 0, notFound: 0, aborted: false,
  });
  assert.match(why, /could not choose which products to read \(canceling statement/);
  assert.match(snapshotFailure({ selectionError: null, tracked: 0, usable: 0, notFound: 0, aborted: false }), /no products were selected/);
});

test("snapshotFailure: every answer unreadable, or most of the night lost", () => {
  assert.match(snapshotFailure({ selectionError: null, tracked: 6000, usable: 0, notFound: 0, aborted: true }), /layout has probably changed/);
  assert.match(snapshotFailure({ selectionError: null, tracked: 300, usable: 0, notFound: 20, aborted: false }), /none of the 280 products/);
  assert.match(snapshotFailure({ selectionError: null, tracked: 6000, usable: 1200, notFound: 100, aborted: false }), /only 1200 of 5900/);
});

test("snapshotFailure: a night where every product is simply gone is not this failure", () => {
  // All 404s is handled by the 404 strike logic, not reported as a layout fault.
  assert.equal(snapshotFailure({ selectionError: null, tracked: 40, usable: 0, notFound: 40, aborted: false }), null);
});
