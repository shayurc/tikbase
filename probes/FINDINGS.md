# Probe findings — commission rate & video transcripts

**Date:** 2026-07-28
**Scope:** read-only data probes against ScrapeCreators + Supabase. No app code changed.
**Credits spent:** **5 of 20** budgeted (balance 21779 → 21774, every call `credits_charged: 1`)

| # | Call | Credits |
|---|---|---|
| 1–3 | `/v1/tiktok/product` × 3 (commission payloads) | 3 |
| 4–5 | `/v1/tiktok/video/transcript` × 2 | 2 |
| — | 3 earlier calls returned HTTP 401 (bad env sourcing) — **not charged**, no `credits_charged` field | 0 |
| — | Supabase queries, vendor docs | 0 |

Raw responses: `probes/commission/*.json` (3), `probes/transcripts/*.json` (2).

---

## PROBE 1 — Commission rate

### Verdict: **ABSENT — vendor gap**

No commission, affiliate-rate, or creator-earnings figure exists anywhere in the Product
Details payload, and no ScrapeCreators endpoint exposes one.

### Populated-rows count: 3,008 rows — but all are `0`

```
products total                : 44,935
commission_rate IS NOT NULL   :  3,008
  of which = 0                :  3,008
  of which > 0                :      0   <-- never once populated with a real value
```

The column was written exactly once in history, by `cac4d88` (2026-04-15):

```js
commission_rate: p?.commission_rate ?? null,   // from the shop-search payload
```

The vendor field never existed, so it stored `0` for every row it touched, and that writer
was later removed. Nothing in the current pipeline references `commission` at all — the only
surviving mention is the type declaration at `client/src/lib/supabase.ts:85`. **Treat the
column as unpopulated, not partially populated:** a `commission_rate = 0` row is an artifact,
not a product with zero commission.

### Products fetched

| product_id | niche | sold_count | price | bytes |
|---|---|---|---|---|
| 1729401873273951198 | health-wellness | 2,812,836 | $15.28 | 169,144 |
| 1729490308077163248 | mens-wear | 40,464 | $16.98 | 400,598 |
| 1729388303591248135 | beauty-skincare | 1,492,283 | $9.49 | 197,175 |

### Deep search — all nesting levels, keys matching `commission|rate|affiliate|earn|promot|plan|open_collab`

27 / 27 / 137 key matches respectively, and **not one is a commission rate**. Every match is
one of three unrelated things:

| Path | Value | What it actually is |
|---|---|---|
| `$.seller.exp_rate_percentile` | `96`, `96`, `72` | seller experience percentile |
| `$.seller.shop_performance_info.performance_metrics[].platform_rate_type` | `0` | metric enum |
| `$.product_base.desc_video.video_infos[].bitrate` | `1385595` | video bitrate |
| `$.product_base.promotion_extra_info` | `{"promotion_type":1,"da_info":"{}"}` | consumer discount |
| `$.sku_common_config.pdp_promotion_items…` | `"Extra 60% off"`, `"Free shipping"` | consumer coupons |
| `$.promotion_logos[]`, `$.promotion_waist`, `$.promotion_label_info` | — | PDP banner styling |

A raw-text scan (catching values, not just keys) found `commission` 11–20× per payload and
`affiliate` exactly once. Both are dead ends:

- **`commission`** is always the literal UI badge string
  `"bc_ad_label_text": "Creator earns commission"` on entries in `related_videos[]`. It is a
  disclosure label, not a number.
- **`affiliate`** is always `affiliate_creator_id: 0` inside the escaped
  `pass_through_source_info` tracking blob. Always `0`, in all three payloads.
- `open_collab`, `creator_fee`, `collab`: **0 occurrences** in all three.

### Other endpoints (docs check, 0 credits)

Full TikTok Shop surface is: `/v1/tiktok/shop/search`, `/v1/tiktok/shop/products`,
`/v1/tiktok/product`, `/v1/tiktok/shop/product/reviews`, `/v1/tiktok/user/showcase`.
**None documents commission, affiliate, or earnings data.** `/v1/tiktok/user/showcase` is the
only conceivable candidate (a creator's promoted-product list) and it was **not called** — it
would surface which products a creator promotes, not the rate they earn, so it cannot satisfy
the requirement.

### Partial substitute that already exists

`related_videos[].bc_ad_label_text` is a reliable *binary* commissioned-content flag: 20/20,
11/12 and 18/19 related videos carried `"Creator earns commission"`. **The pipeline already
stores this** — `product_videos.ad_label` is populated on 66,186 of 196,105 rows (34%), values
`Creator earns commission` (dominant), `Promotional content`, `Paid partnership`.

So "is this product being pushed by commissioned creators, and how heavily" is answerable
today with zero new API spend. "What % commission does it pay" is not answerable at all.

### Recommendation: **vendor gap**

Do not build a commission-rate feature against this vendor. The number is not in the payload,
not in any other endpoint, and TikTok does not expose affiliate rates on the public PDP that
ScrapeCreators scrapes — so this is unlikely to appear without ScrapeCreators adding a
Seller-Center-authenticated product, which is a different class of integration.

Two concrete follow-ups instead:
1. **Drop or comment `commission_rate` in `client/src/lib/supabase.ts:85`.** It currently
   implies a field the product cannot deliver, and 3,008 rows of `0` will read as real data to
   the next person who touches it.
2. **Ship the affiliate-intensity angle instead** — % of a product's videos carrying
   `ad_label = 'Creator earns commission'` is a genuine, already-collected signal about how
   affiliate-driven a product's growth is. It answers the adjacent question ("is this an
   affiliate play?") without the number that does not exist.

---

## PROBE 2 — Video transcripts

### Verdict: **EXISTS — build now**

**Endpoint:** `GET /v1/tiktok/video/transcript`
**Auth:** `x-api-key` header (same as every other call)
**Cost:** **1 credit per request.** Documented verbatim: *"1 credit per request"*, with an
optional AI fallback that *"Costs 10 credits to use this feature"*.

| Param | Required | Notes |
|---|---|---|
| `url` | yes | full TikTok video URL |
| `language` | no | 2-letter code (`en`,`es`,`fr`,`de`,`it`,`ja`,`ko`,`zh`) |
| `use_ai_as_fallback` | no | `'true'` → **10 credits**, videos under 2 min only |

**The AI fallback was deliberately not tested** — at 10 credits it is 10× the base call, and
both plain calls succeeded, so there was no gap to fall back from.

### Live test — 2 videos, both succeeded

| video_id | views | HTTP | latency | credits | transcript |
|---|---|---|---|---|---|
| 7534139099037306167 | 169.6M | 200 | 5.58s | 1 | 1,655 chars / 68 lines |
| 7573080707619130655 | 114.3M | 200 | 6.84s | 1 | 2,536 chars / 104 lines |

**Quality: real speech, not auto-junk.** WebVTT with millisecond cue timing:

```
WEBVTT

00:00:00.020 --> 00:00:02.220
Why does it feel like someone at medicube made a mistake?

00:00:02.221 --> 00:00:03.661
Like, this is actually insane.
```

Coherent sentences, correct brand nouns (`medicube`), clean cue boundaries. This is usable
as-is for a "study the script" panel.

**Language field: absent.** `language` is a *request* parameter only. The response is exactly
`{success, credits_remaining, credits_charged, id, url, transcript}` — there is no returned
language code or confidence score, so the app cannot tell whether a transcript is English
without inspecting the text itself.

**Latency: 5.6–6.8s** — 2–3× the ~2.3s Product Details call. Too slow for a synchronous
on-click panel with no loading state; fine for on-click with a spinner, better pre-fetched.

### Recommendation: **build now**

The endpoint delivers exactly the feature: 1 credit, real speech, timestamped, no AI fallback
needed for normal videos. Three notes that should shape the build:

1. **Fetch on click and cache permanently, never in the daily pipeline.** A video's transcript
   never changes, so it is a write-once row. Blanket-fetching the 163,311 videos with a
   `video_id` would cost 163k credits — ~27× the entire current daily snapshot budget. On-click
   with a `video_transcripts` cache table makes cost scale with what users actually open.
2. **Budget guard before shipping.** Credits ran out entirely on 2026-07-19/20 (see
   `probes/SNAPSHOT-COVERAGE.md` §7). A user-triggered endpoint spends from the same pool as
   the pipeline, so it needs a per-user or per-day ceiling, or a popular product can starve
   the nightly refresh.
3. **Handle the no-transcript case explicitly.** Both samples were high-view, caption-heavy
   videos — a deliberately favourable sample. The failure shape for a music-only or silent
   video is **untested**, and it determines whether the UI shows "no transcript available" or
   an error. Worth one probe call on a low-view video before building the panel.

### Caption text — related, cheaper, currently discarded

`product_videos` has **no caption/description column**. But `related_videos[].title` in the
Product Details payload *is* the caption, and it is already being paid for on every Phase 3
fetch:

```
'My entire routine on whitening day!! 🦷 #oralroutine #teethwhitening #whiteteeth …'
'Teeth whitening made easy #dentalhygienist #teethwhitening #whitestrips #gurunanda …'
```

Not a substitute for a transcript — a caption is marketing copy, a transcript is the spoken
script — but it is free hashtag/hook data currently thrown away. Persisting it alongside
`ad_label` is a zero-credit change worth doing regardless of the transcript decision.
