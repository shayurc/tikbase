import { useState, useEffect } from 'react';
import { useRoute, Link } from 'wouter';
import { formatViews, authHeader } from '@/lib/supabase';
import { useSubscription } from '@/hooks/use-subscription';
import { InfoTip } from '@/components/InfoTip';
import { LoadingBar } from '@/components/LoadingBar';
import {
  ArrowLeft, ExternalLink, Lock, UserX, AlertCircle, Video, Package, Eye, Percent,
} from 'lucide-react';
import { decodeRouteParam } from '@/lib/route-param';

interface WindowStats {
  videos: number;
  products: number;
  views: number;
  affiliateIntensity: number | null;
}
interface ProfileProduct {
  product_id: string;
  title: string | null;
  niche_slug: string | null;
  image_url: string | null;
  videos: number;
  views: number;
}
interface ProfileVideo {
  video_id: string | null;
  video_url: string | null;
  view_count: number;
  cover_image_url: string | null;
  posted_at: string | null;
  product_id: string | null;
}
interface ProfileData {
  creator: {
    creator_key: string;
    display_name: string | null;
    handle: string | null;
    author_id: string | null;
    tiktok_url: string | null;
    avatar_url: string;
    first_seen: string | null;
    last_seen: string | null;
    videos_count: number;
    products_count: number;
  };
  windows: { 7: WindowStats | null; 30: WindowStats | null };
  lifetimeViews: number;
  gmv?: { attributedGmv: number; gmvConfidence: number; niche: string; days: number };
  products: ProfileProduct[];
  productsTotal: number;
  productsPage: number;
  productsLimit: number;
  topVideos: ProfileVideo[];
  tier: 'free' | 'paid';
}

// Same rule as the leaderboard: a creator with no modelled figure gets an em
// dash, never "$0" — that would read as "sold nothing" rather than "not
// modelled".
function formatGmv(n: number | undefined): string {
  if (n === undefined || !(n > 0)) return '—';
  if (n >= 1_000_000) return '$' + (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return '$' + (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return '$' + n.toFixed(0);
}

// product_videos.video_id is NULL on a large share of keyword-discovered rows,
// so the id has to come off the URL as a fallback. Without this the strip
// rendered <img src=""> — a broken-image glyph, not a placeholder.
function videoIdOf(v: ProfileVideo): string | null {
  if (v.video_id && /^\d{5,}$/.test(v.video_id)) return v.video_id;
  const m = v.video_url?.match(/\/video\/(\d{5,})/);
  return m ? m[1] : null;
}

function formatDate(s: string | null): string {
  if (!s) return '—';
  const t = Date.parse(s);
  if (Number.isNaN(t)) return '—';
  return new Date(t).toISOString().slice(0, 10);
}

function StatCard({
  label, value, icon, hint, muted,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  hint?: React.ReactNode;
  muted?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border bg-card px-5 py-4">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground mb-1.5">
        {icon}
        <span>{label}</span>
        {hint}
      </div>
      <div
        className={`font-mono text-lg font-semibold ${muted ? 'text-muted-foreground' : 'text-foreground'}`}
      >
        {value}
      </div>
    </div>
  );
}

export default function CreatorProfilePage() {
  const [, params] = useRoute('/dashboard/creator/:key');
  const { isPaid, showPaywall } = useSubscription();
  const [data, setData] = useState<ProfileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [page, setPage] = useState(1);

  // The route param is URL-encoded because half of all keys are 'id:<digits>'.
  const key = decodeRouteParam(params?.key);

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    setLoading(true);
    setError(false);
    setNotFound(false);

    (async () => {
      try {
        const res = await fetch(
          `/api/creator-profile?key=${encodeURIComponent(key)}&page=${page}`,
          { headers: await authHeader() },
        );
        if (cancelled) return;
        if (res.status === 404) {
          setNotFound(true);
          return;
        }
        if (!res.ok) throw new Error('failed');
        const json = await res.json();
        if (!cancelled) setData(json);
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [key, page]);

  const w30 = data?.windows?.[30] ?? null;
  const name = data?.creator.display_name || data?.creator.handle || key;
  const totalPages = data
    ? Math.max(1, Math.ceil(data.productsTotal / Math.max(1, data.productsLimit)))
    : 1;

  return (
    <div className="p-5 md:p-8 max-w-[1400px] mx-auto">
      <Link
        href="/dashboard/creators"
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors mb-4"
        data-testid="creator-profile-back"
      >
        <ArrowLeft size={13} />
        Top Affiliates
      </Link>

      {loading && <LoadingBar loading={loading} />}

      {!loading && notFound && (
        <div className="flex flex-col items-center text-center py-20 px-6" data-testid="creator-profile-404">
          <div className="w-11 h-11 rounded-full bg-secondary/60 flex items-center justify-center mb-3">
            <UserX size={20} className="text-muted-foreground" />
          </div>
          <p className="text-sm font-medium text-foreground mb-1">Creator not found</p>
          <p className="text-xs text-muted-foreground max-w-xs font-mono break-all">{key}</p>
        </div>
      )}

      {!loading && error && (
        <div className="flex flex-col items-center text-center py-20 px-6" data-testid="creator-profile-error">
          <div className="w-11 h-11 rounded-full bg-secondary/60 flex items-center justify-center mb-3">
            <AlertCircle size={20} className="text-muted-foreground" />
          </div>
          <p className="text-sm font-medium text-foreground mb-1">Couldn't load this creator</p>
          <p className="text-xs text-muted-foreground max-w-xs">
            Something went wrong. Try reloading the page.
          </p>
        </div>
      )}

      {!loading && !error && !notFound && data && (
        <>
          {/* Identity */}
          <div className="flex items-start gap-5 mb-8">
            <img
              src={data.creator.avatar_url}
              alt=""
              className="h-20 w-20 md:h-24 md:w-24 rounded-full object-cover bg-secondary flex-shrink-0"
              data-testid="creator-profile-avatar"
            />
            <div className="min-w-0 flex-1">
              <h1 className="text-2xl font-semibold text-foreground truncate tracking-tight">{name}</h1>
              {/* Numeric-key creators have no handle and therefore no profile to
                  link to — show the key rather than inventing an @id: URL. */}
              {data.creator.tiktok_url ? (
                <a
                  href={data.creator.tiktok_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs font-mono text-muted-foreground hover:text-primary transition-colors"
                  data-testid="creator-profile-tiktok"
                >
                  @{data.creator.handle}
                  <ExternalLink size={10} />
                </a>
              ) : (
                <span className="text-xs font-mono text-muted-foreground" data-testid="creator-profile-nohandle">
                  {data.creator.creator_key}
                </span>
              )}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-[11px] text-muted-foreground">
                <span>
                  First seen <span className="font-mono text-foreground">{formatDate(data.creator.first_seen)}</span>
                </span>
                <span>
                  Last seen <span className="font-mono text-foreground">{formatDate(data.creator.last_seen)}</span>
                </span>
                <span>
                  <span className="font-mono text-foreground">{data.creator.videos_count.toLocaleString()}</span> videos all time
                </span>
                <span>
                  <span className="font-mono text-foreground">{formatViews(data.lifetimeViews)}</span> lifetime views
                </span>
              </div>
            </div>
          </div>

          {/* 30-day stat cards */}
          <div className="flex items-center gap-2 mb-2">
            <h2 className="text-sm font-semibold text-foreground">Last 30 days</h2>
            <InfoTip size={12}>
              Computed live from this creator's videos. A video counts toward a window by
              its post date; views are lifetime counts on videos posted in that window.
            </InfoTip>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4 mb-8">
            <StatCard
              label="Videos" icon={<Video size={11} />}
              value={(w30?.videos ?? 0).toLocaleString()}
            />
            <StatCard
              label="Products" icon={<Package size={11} />}
              value={(w30?.products ?? 0).toLocaleString()}
            />
            <StatCard
              label="Views" icon={<Eye size={11} />}
              value={formatViews(w30?.views ?? 0)}
            />
            <StatCard
              label="Affiliate" icon={<Percent size={11} />}
              value={
                w30 && w30.affiliateIntensity !== null
                  ? `${Math.round(w30.affiliateIntensity * 100)}%`
                  : '—'
              }
              muted={!w30 || w30.affiliateIntensity === null}
            />
            <StatCard
              label="Est. GMV"
              icon={<Lock size={11} className={isPaid ? 'opacity-0' : ''} />}
              value={formatGmv(data.gmv?.attributedGmv)}
              muted={!data.gmv}
              hint={
                <InfoTip size={11}>
                  Modeled attribution, not measured payouts — the product's estimated
                  revenue split across the creators who posted about it.
                  {!isPaid && ' Available on Pro.'}
                  {data.gmv?.gmvConfidence !== undefined && (
                    <> Confidence {Math.round(data.gmv.gmvConfidence * 100)}%: the share
                    backed by measured sales deltas.</>
                  )}
                </InfoTip>
              }
            />
          </div>

          {/* Products */}
          <div className="flex items-center gap-2 mb-2">
            <h2 className="text-sm font-semibold text-foreground">Products promoted</h2>
            <span className="text-xs text-muted-foreground font-mono">
              {data.productsTotal.toLocaleString()} total
            </span>
          </div>
          {data.products.length === 0 ? (
            <div className="rounded-lg border border-border px-4 py-8 text-center text-xs text-muted-foreground mb-6">
              No products recorded for this creator.
            </div>
          ) : (
            <div className="rounded-lg border border-border overflow-x-auto mb-3">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-card/50 text-[11px] uppercase tracking-wide text-muted-foreground">
                    <th className="text-left font-medium py-3 pl-5 pr-3">Product</th>
                    <th className="text-right font-medium py-3 px-3 whitespace-nowrap">Videos</th>
                    <th className="text-right font-medium py-3 px-5 whitespace-nowrap">Views</th>
                  </tr>
                </thead>
                <tbody data-testid="creator-profile-products">
                  {data.products.map(p => (
                    <tr key={p.product_id} className="border-b border-border/60 last:border-0">
                      <td className="py-3.5 pl-5 pr-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <img
                            src={`/api/thumb?product_id=${encodeURIComponent(p.product_id)}`}
                            alt=""
                            loading="lazy"
                            className="h-12 w-12 rounded-md object-cover bg-secondary flex-shrink-0"
                            onError={e => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }}
                          />
                          {/* Bounded so a 200-character product title cannot
                              push Videos/Views out of the viewport. */}
                          <div className="min-w-0 max-w-[520px]">
                            <div className="text-xs text-foreground truncate">
                              {p.title || p.product_id}
                            </div>
                            {p.niche_slug && (
                              <div className="text-[11px] text-muted-foreground font-mono">{p.niche_slug}</div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="py-3.5 px-3 text-right font-mono text-xs text-foreground">
                        {p.videos.toLocaleString()}
                      </td>
                      <td className="py-3.5 px-5 text-right font-mono text-xs text-foreground">
                        {formatViews(p.views)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Free tier is served the first 3 products by the API — the upsell
              promises only what Pro can actually deliver. */}
          {!isPaid && data.productsTotal > data.products.length ? (
            <button
              onClick={() => showPaywall('creator_profile_products')}
              className="w-full mb-6 rounded-lg border border-primary/30 bg-primary/5 hover:bg-primary/10 transition-colors px-6 py-5 flex items-center justify-center gap-3 cursor-pointer"
              data-testid="upsell-creator-products"
            >
              <Lock size={16} className="text-primary" />
              <span className="text-sm font-semibold text-foreground">
                Unlock all {data.productsTotal.toLocaleString()} products and this creator's
                modeled GMV
              </span>
            </button>
          ) : isPaid && totalPages > 1 ? (
            <div className="flex items-center justify-center gap-2 mb-6">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="h-9 px-3 rounded-md border border-border text-xs text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-30 disabled:pointer-events-none transition-colors"
              >
                Previous
              </button>
              <span className="text-xs font-mono text-muted-foreground px-2">
                {page} / {totalPages}
              </span>
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="h-9 px-3 rounded-md border border-border text-xs text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-30 disabled:pointer-events-none transition-colors"
              >
                Next
              </button>
            </div>
          ) : null}

          {/* Videos */}
          {data.topVideos.length > 0 && (
            <>
              <h2 className="text-sm font-semibold text-foreground mb-2">Top videos</h2>
              <div className="flex gap-4 overflow-x-auto pb-2" data-testid="creator-profile-videos">
                {data.topVideos.map((v, i) => {
                  const vid = videoIdOf(v);
                  return (
                    <a
                      key={v.video_id || v.video_url || i}
                      href={v.video_url || '#'}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group flex-shrink-0 w-[140px]"
                    >
                      <div className="relative rounded-md overflow-hidden bg-secondary aspect-[9/16]">
                        {vid && (
                          <img
                            src={`/api/thumb?vid=${encodeURIComponent(vid)}`}
                            alt=""
                            loading="lazy"
                            className="h-full w-full object-cover group-hover:opacity-80 transition-opacity"
                          />
                        )}
                      </div>
                      <div className="mt-1 text-[11px] font-mono text-muted-foreground">
                        {formatViews(v.view_count)} views
                      </div>
                    </a>
                  );
                })}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
