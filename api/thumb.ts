// Cache-through thumbnail proxy.
//
// TikTok CDN thumbnail URLs are signed and expire in ~a day, so stored
// cover_image_url values go dead. This endpoint resolves a stable image per
// video and caches it in Supabase Storage so oEmbed is called at most once per
// video, ever:
//   1. Storage hit  -> redirect to the permanent public URL (immutable cache).
//   2. Storage miss -> server-side oEmbed (no browser CORS), fetch the image
//      bytes, upload to Storage, redirect to the stored URL.
//   3. Any failure  -> a neutral placeholder image (never 500s the <img> tag).
//
// Usage: <img src="/api/thumb?vid=<tiktok video id>">

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { acceptableImage, plausibleVideoId } from './_lib/image-guard.js';

const BUCKET = 'thumbnails';
const OEMBED_TIMEOUT_MS = 8000;
const IMG_TIMEOUT_MS = 8000;

function admin() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing Supabase env vars');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

// Neutral dark placeholder with a small play glyph. Short cache so a later
// request can retry resolving the real thumbnail.
function sendPlaceholder(res: VercelResponse) {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="356" viewBox="0 0 200 356">' +
    '<rect width="200" height="356" fill="#18181b"/>' +
    '<circle cx="100" cy="178" r="26" fill="#27272a"/>' +
    '<path d="M92 166l20 12-20 12z" fill="#52525b"/></svg>';
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.setHeader('X-Thumb-Source', 'placeholder');
  res.status(200).send(svg);
}

async function fetchWithTimeout(url: string, ms: number) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Cache-through for a PRODUCT image.
 *
 * Same shape as the video path below, different source: the URL comes from
 * products.image_url rather than oEmbed. It exists because 7,591 of 48,706
 * product images are signed CDN URLs carrying x-expires, and those 403 once
 * stale — one product in six would render broken.
 *
 * This also makes `/api/thumb?product_id=` real. Two shipped call sites
 * (the leaderboard's expanded panel and the creator profile's product table)
 * already request it; until now the endpoint only understood `vid`, so they
 * silently got the placeholder.
 */
async function serveProductThumb(
  supabase: ReturnType<typeof admin>,
  productId: string,
  res: VercelResponse,
) {
  const path = `products/${productId}.jpg`;
  const publicUrl = supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;

  const redirectTo = (target: string, source: string, longCache: boolean) => {
    res.setHeader('X-Thumb-Source', source);
    res.setHeader(
      'Cache-Control',
      longCache
        ? 'public, max-age=86400, s-maxage=31536000, immutable'
        : 'public, max-age=3600',
    );
    res.setHeader('Location', target);
    res.status(302).end();
  };

  try {
    const { data: list } = await supabase.storage
      .from(BUCKET)
      .list('products', { limit: 1, search: `${productId}.jpg` });
    if (list && list.some((f) => f.name === `${productId}.jpg`)) {
      return redirectTo(publicUrl, 'storage', true);
    }
  } catch {
    /* fall through to the miss path */
  }

  try {
    const { data: row } = await supabase
      .from('products')
      .select('image_url')
      .eq('product_id', productId)
      .maybeSingle();
    const src = (row as any)?.image_url as string | undefined;
    if (!src) return sendPlaceholder(res);

    const img = await fetchWithTimeout(src, IMG_TIMEOUT_MS);
    if (!img.ok) return sendPlaceholder(res);
    const buf = Buffer.from(await img.arrayBuffer());
    // Stored under the type the BYTES are, not the type the origin claimed.
    const verdict = acceptableImage(buf);
    if (!verdict.ok) return sendPlaceholder(res);
    const contentType = verdict.contentType;

    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(path, buf, { contentType, upsert: true, cacheControl: '31536000' });
    if (upErr) {
      // Couldn't store it, but this URL works right now. Short cache, because
      // if it is a signed one it will expire.
      return redirectTo(src, 'origin-nostore', false);
    }
    return redirectTo(publicUrl, 'origin', true);
  } catch {
    return sendPlaceholder(res);
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const productId = String(req.query.product_id || '');
  const vid = String(req.query.vid || '');

  let supabase;
  try {
    supabase = admin();
  } catch {
    return sendPlaceholder(res);
  }

  // product_id and vid are separate sources; product_id wins when both appear.
  if (productId) {
    if (!/^[A-Za-z0-9_-]{5,64}$/.test(productId)) return sendPlaceholder(res);
    return serveProductThumb(supabase, productId, res);
  }

  if (!plausibleVideoId(vid)) return sendPlaceholder(res);

  const path = `thumbs/${vid}.jpg`;
  const publicUrl = supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;

  const redirectTo = (target: string, source: string, longCache: boolean) => {
    res.setHeader('X-Thumb-Source', source);
    res.setHeader(
      'Cache-Control',
      longCache
        ? 'public, max-age=86400, s-maxage=31536000, immutable'
        : 'public, max-age=3600',
    );
    res.setHeader('Location', target);
    res.status(302).end();
  };

  // 1. Storage hit?
  try {
    const { data: list } = await supabase.storage
      .from(BUCKET)
      .list('thumbs', { limit: 1, search: `${vid}.jpg` });
    if (list && list.some((f) => f.name === `${vid}.jpg`)) {
      return redirectTo(publicUrl, 'storage', true);
    }
  } catch {
    /* fall through to miss path */
  }

  // 2. Miss -> oEmbed once, fetch bytes, upload to Storage.
  try {
    // An existence check against product_videos was tried here and removed:
    // measured 2026-11-13, both `video_id = $1` and the video_url match timed
    // out at the 10s gateway limit on the 656k-row table while the nightly
    // refresh was running. It would have turned every uncached thumbnail into
    // a placeholder. What limits abuse instead is plausibleVideoId above (the
    // old rule took any five digits) and acceptableImage below.
    const oembedUrl = `https://www.tiktok.com/oembed?url=https://www.tiktok.com/@t/video/${vid}`;
    const o = await fetchWithTimeout(oembedUrl, OEMBED_TIMEOUT_MS);
    if (!o.ok) return sendPlaceholder(res);
    const j: any = await o.json().catch(() => null);
    const thumb: string | undefined = j?.thumbnail_url;
    if (!thumb) return sendPlaceholder(res);

    const img = await fetchWithTimeout(thumb, IMG_TIMEOUT_MS);
    if (!img.ok) return sendPlaceholder(res);
    const buf = Buffer.from(await img.arrayBuffer());
    const verdict = acceptableImage(buf);
    if (!verdict.ok) return sendPlaceholder(res);
    const contentType = verdict.contentType;

    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(path, buf, { contentType, upsert: true, cacheControl: '31536000' });

    if (upErr) {
      // Couldn't store it, but we have a fresh signed URL — use it directly
      // (short cache, since it will expire).
      return redirectTo(thumb, 'oembed-nostore', false);
    }
    return redirectTo(publicUrl, 'oembed', true);
  } catch {
    return sendPlaceholder(res);
  }
}
