/**
 * What the thumbnail and avatar proxies are willing to fetch and store.
 *
 * Both endpoints are unauthenticated, run with the service-role key, and write
 * to a public Storage bucket. Before this file they would:
 *   - take ANY run of five or more digits as a video id, ask TikTok about it,
 *     and store whatever came back — so anyone could fill the bucket, one
 *     request per object, with ids TikBase has never tracked;
 *   - store the response under whatever Content-Type the origin claimed, with
 *     no size limit. The URLs come from scraped rows; a row pointing somewhere
 *     else would have its HTML or SVG served from our bucket.
 *
 * Pure functions, so every rule is tested.
 */

/** Largest image worth caching. Real covers and avatars are tens of kilobytes. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Does this look like a real TikTok video id? They are snowflakes: the top 32
 * bits are the post time. A made-up number decodes to a date outside TikTok
 * Shop's lifetime.
 */
export function plausibleVideoId(vid: string, now: number = Date.now()): boolean {
  if (!/^\d{15,20}$/.test(vid)) return false;
  try {
    const seconds = Number(BigInt(vid) >> 32n);
    const ms = seconds * 1000;
    return ms >= Date.UTC(2020, 0, 1) && ms <= now + 86_400_000;
  } catch {
    return false;
  }
}

/** The raster format these bytes are, or null. First bytes only. */
export function sniffImage(buf: Uint8Array): string | null {
  const b = buf;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  const ascii = (from: number, to: number) => String.fromCharCode(...b.slice(from, to));
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (b.length >= 12 && ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (brand === 'heic' || brand === 'heix' || brand === 'mif1') return 'image/heic';
  }
  return null;
}

export type ImageVerdict =
  | { ok: true; contentType: string }
  | { ok: false; reason: 'empty' | 'too-large' | 'not-an-image' };

/**
 * May these bytes be stored and served as an image? Decided from the bytes,
 * not from the header: the header is the origin's claim, and the stored type
 * is what a browser will later be told to trust.
 */
export function acceptableImage(buf: Uint8Array): ImageVerdict {
  if (buf.byteLength === 0) return { ok: false, reason: 'empty' };
  if (buf.byteLength > MAX_IMAGE_BYTES) return { ok: false, reason: 'too-large' };
  const type = sniffImage(buf);
  if (!type) return { ok: false, reason: 'not-an-image' };
  return { ok: true, contentType: type };
}
