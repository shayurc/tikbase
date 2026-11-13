// Direct Supabase REST API client without the SDK
// (SDK uses localStorage/sessionStorage which are blocked in sandboxed iframes)

import { supabaseAuth } from './supabaseAuth';

// Bearer header for our own /api/* endpoints so the server can resolve the
// caller's tier (top-products / top-videos gate on this). Anonymous callers
// send no token and are served the free tier. Never throws.
export async function authHeader(): Promise<Record<string, string>> {
  try {
    const { data } = await supabaseAuth.auth.getSession();
    const token = data.session?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

/**
 * Whose data a cached response is.
 *
 * The page caches below were keyed on the query alone — niche, days, page — and
 * lived for 30 minutes, so they outlasted the session that filled them: sign
 * out, sign in as someone else on the same browser, and the first account's
 * rows (a Pro ranking, say) were served to the second from memory without a
 * request. Every key now starts with the account it was fetched for.
 */
export async function cacheScope(): Promise<string> {
  try {
    const { data } = await supabaseAuth.auth.getSession();
    return data.session?.user?.id ?? 'anon';
  } catch {
    return 'anon';
  }
}

// Simple in-memory cache for expensive queries
const queryCache = new Map<string, { data: any; timestamp: number }>();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes (data changes daily, no need to refetch often)

function getCached<T>(key: string): T | null {
  const entry = queryCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    queryCache.delete(key);
    return null;
  }
  return entry.data as T;
}

function setCache(key: string, data: any): void {
  queryCache.set(key, { data, timestamp: Date.now() });
}

// What used to sit here: a REST client that read `products`,
// `product_snapshots` and `product_videos` straight from the browser with the
// public key, and two fetchers built on it. Nothing has called them since the
// pages moved to /api/*, and row-level security now answers the public key
// with zero rows (measured 2026-11-12), so they could only ever return empty.
// Removed rather than left as a map of the tables for anyone reading the bundle.

export interface Product {
  id: number;
  product_id: string;
  title: string;
  niche_slug: string;
  niche_label: string;
  image_url: string;
  sale_price: number;
  original_price: number;
  discount_percent: number;
  currency: string;
  sold_count: number;
  stock_quantity: number;
  rating: number;
  review_count: number;
  commission_rate: number;
  seller_name: string;
  seller_id: string;
  seller_product_count: number;
  seller_location: string;
  seller_tiktok_url: string;
  region: string;
  product_url: string;
  created_at: string;
  updated_at: string;
}

export interface ProductVideo {
  id: number;
  product_id: string;
  video_url: string;
  view_count: number;
  author_name: string;
  author_avatar_url: string;
  /** Stable identity for /api/avatar. Null on payloads written before 2026-08-15. */
  creator_key?: string | null;
  created_at: string;
  cover_image_url: string;
}

export interface VideoWithProduct extends ProductVideo {
  product?: Product;
}

export const NICHES = [
  { slug: 'all', label: 'All Categories' },
  { slug: 'beauty-skincare', label: 'Beauty & Skincare' },
  { slug: 'gym-fitness', label: 'Gym & Fitness' },
  { slug: 'health-wellness', label: 'Health & Wellness' },
  { slug: 'mens-wear', label: "Men's Wear" },
  { slug: 'womens-wear', label: "Women's Wear" },
  { slug: 'tech-gadgets', label: 'Tech Gadgets' },
  { slug: 'pet-products', label: 'Pet Products' },
  { slug: 'home-kitchen', label: 'Home & Kitchen' },
  { slug: 'food-beverage', label: 'Food & Beverage' },
  { slug: 'shoes-footwear', label: 'Shoes & Footwear' },
  { slug: 'accessories-jewelry', label: 'Accessories & Jewelry' },
  { slug: 'baby-kids', label: 'Baby & Kids' },
  { slug: 'toys-games', label: 'Toys & Games' },
  { slug: 'fragrance', label: 'Fragrance & Perfume' },
  { slug: 'supplements', label: 'Supplements & Wellness' },
  { slug: 'mens-grooming', label: "Men's Grooming" },
  { slug: 'haircare', label: 'Haircare' },
  { slug: 'makeup', label: 'Makeup & Cosmetics' },
  { slug: 'collectibles', label: 'Collectibles & Trading Cards' },
];

// Niches without the 'all' option (for Videos page which doesn't support all)
export const NICHES_NO_ALL = NICHES.filter(n => n.slug !== 'all');

export const TIMEFRAMES = [
  { label: '1 Week', days: 7 },
  { label: '2 Weeks', days: 14 },
  { label: '1 Month', days: 30 },
  { label: '3 Months', days: 90 },
  { label: '6 Months', days: 180 },
  { label: '1 Year', days: 365 },
];

export function getCutoffDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

// Extract actual TikTok post date from video URL using snowflake ID
export function extractPostDate(videoUrl: string): Date | null {
  if (!videoUrl) return null;
  const match = videoUrl.match(/video\/(\d+)/);
  if (!match) return null;
  try {
    const videoId = BigInt(match[1]);
    const timestamp = Number(videoId >> 32n);
    const date = new Date(timestamp * 1000);
    // Not a literal year: `> 2027` would have emptied Top Videos on 2028-01-01.
    if (date.getFullYear() < 2020 || date.getTime() > Date.now() + 86_400_000) return null;
    return date;
  } catch {
    return null;
  }
}

export function formatViews(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return n.toString();
}

export function formatRevenue(n: number): string {
  if (n >= 1_000_000) return '$' + (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return '$' + (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return '$' + n.toFixed(2);
}

export function timeAgo(dateStr: string): string {
  const now = new Date();
  const date = new Date(dateStr);
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);
  const diffWeeks = Math.floor(diffDays / 7);
  const diffMonths = Math.floor(diffDays / 30);

  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffWeeks < 5) return `${diffWeeks}w ago`;
  return `${diffMonths}mo ago`;
}

// Fetch top videos via the server-side /api/top-videos endpoint.
// The heavy computation (42K video fetch + snowflake filtering + product join)
// is done server-side with 1-hour caching. The frontend just receives the
// paginated, pre-filtered result.
export async function fetchTopVideos(
  nicheSlug: string,
  days: number,
  page: number = 1,
  limit: number = 50
): Promise<{ videos: VideoWithProduct[]; total: number }> {
  // Client-side cache (5 min) to avoid redundant API calls during tab switching
  const cacheKey = `${await cacheScope()}:videos:${nicheSlug}:${days}:${page}:${limit}`;
  type VideoCache = { videos: VideoWithProduct[]; total: number };
  const cached = getCached<VideoCache>(cacheKey);
  if (cached) return cached;

  const params = new URLSearchParams({
    niche: nicheSlug,
    days: String(days),
    page: String(page),
    limit: String(limit),
  });

  const res = await fetch(`/api/top-videos?${params}`, { headers: await authHeader() });
  if (!res.ok) {
    throw new Error(`Failed to fetch videos: ${res.status}`);
  }

  const data = await res.json();
  const result = {
    videos: (data.videos || []) as VideoWithProduct[],
    total: data.total || 0,
  };

  setCache(cacheKey, result);
  return result;
}
