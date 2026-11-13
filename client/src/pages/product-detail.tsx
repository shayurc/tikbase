import { useState, useEffect } from 'react';
import { useRoute, Link } from 'wouter';
import { formatViews, authHeader } from '@/lib/supabase';
import { useSubscription } from '@/hooks/use-subscription';
import { InfoTip } from '@/components/InfoTip';
import { LoadingBar } from '@/components/LoadingBar';
import { ConfidenceDot } from '@/components/ConfidenceDot';
import { creatorProfilePath } from '@/components/CreatorSearch';
import { brandProfilePath } from '@/components/GlobalSearch';
import { ScriptButton } from '@/components/ScriptPanel';
import {
  ArrowLeft, ExternalLink, Lock, PackageSearch, AlertCircle, Play,
  Video, Users, Eye, Percent, BadgeDollarSign,
} from 'lucide-react';
import { decodeRouteParam } from '@/lib/route-param';

interface WindowStats {
  videos: number;
  creators: number;
  views: number;
  affiliateIntensity: number | null;
}
interface ProductVideoRow {
  video_id: string | null;
  video_url: string | null;
  creator_key: string | null;
  author_name: string | null;
  avatar_url: string | null;
  view_count: number;
  like_count: number;
  commissioned: boolean;
  posted_at: string | null;
}
interface DetailData {
  product: {
    product_id: string;
    title: string;
    seller_name: string | null;
    seller_id: string | null;
    seller_tiktok_url: string | null;
    product_url: string | null;
    niche_slug: string | null;
    niche_label: string | null;
    image_url: string;
    sale_price: number | null;
    original_price: number | null;
    sold_count: number;
    stock_quantity: number | null;
    rating: number | null;
    review_count: number;
    first_seen: string | null;
  };
  windows: { 7: WindowStats | null; 30: WindowStats | null };
  totals: { videos: number; creators: number; views: number };
  gmv?: { estRevenue: number; hasRealDelta: boolean; days: number };
  videos: ProductVideoRow[];
  videosTotal: number;
  videosShown: number;
  tier: 'free' | 'paid';
}

// Same rule as every other surface: an absent figure is an em dash, never $0 —
// "$0" claims the product sold nothing, which is a different statement from
// "this product is not ranked, so we have no revenue model for it".
function formatGmv(n: number | undefined): string {
  if (n === undefined || !(n > 0)) return '—';
  if (n >= 1_000_000) return '$' + (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return '$' + (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return '$' + n.toFixed(0);
}

function compact(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

function daysAgo(s: string | null): string {
  if (!s) return '';
  const t = Date.parse(s);
  if (Number.isNaN(t)) return '';
  const d = Math.floor((Date.now() - t) / 86400000);
  if (d < 1) return 'today';
  if (d === 1) return '1d ago';
  if (d < 30) return `${d}d ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

/** video_id is null on many keyword-discovered rows; recover it from the URL. */
function videoIdOf(v: ProductVideoRow): string | null {
  if (v.video_id && /^\d{5,}$/.test(v.video_id)) return v.video_id;
  const m = v.video_url?.match(/\/video\/(\d{5,})/);
  return m ? m[1] : null;
}

function StatCard({ label, value, icon, muted, hint }: {
  label: string; value: string; icon: React.ReactNode; muted?: boolean; hint?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-card px-5 py-4">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground mb-1.5">
        {icon}<span>{label}</span>{hint}
      </div>
      <div className={`font-mono text-lg font-semibold ${muted ? 'text-muted-foreground' : 'text-foreground'}`}>
        {value}
      </div>
    </div>
  );
}

export default function ProductDetailPage() {
  const [, params] = useRoute('/dashboard/product/:id');
  const { isPaid, showPaywall } = useSubscription();
  const [data, setData] = useState<DetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [notFound, setNotFound] = useState(false);

  const id = decodeRouteParam(params?.id);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true); setError(false); setNotFound(false);
    (async () => {
      try {
        const res = await fetch(`/api/product-detail?id=${encodeURIComponent(id)}`, {
          headers: await authHeader(),
        });
        if (cancelled) return;
        if (res.status === 404) { setNotFound(true); return; }
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
  }, [id]);

  const w30 = data?.windows?.[30] ?? null;
  const p = data?.product;

  return (
    <div className="p-5 md:p-8 max-w-[1400px] mx-auto">
      <Link
        href="/dashboard/products"
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors mb-4"
        data-testid="product-detail-back"
      >
        <ArrowLeft size={13} /> Top Products
      </Link>

      {loading && <LoadingBar loading={loading} />}

      {!loading && notFound && (
        <div className="flex flex-col items-center text-center py-20 px-6" data-testid="product-detail-404">
          <div className="w-11 h-11 rounded-full bg-secondary/60 flex items-center justify-center mb-3">
            <PackageSearch size={20} className="text-muted-foreground" />
          </div>
          <p className="text-sm font-medium text-foreground mb-1">Product not found</p>
          <p className="text-xs text-muted-foreground max-w-xs font-mono break-all">{id}</p>
        </div>
      )}

      {!loading && error && (
        <div className="flex flex-col items-center text-center py-20 px-6" data-testid="product-detail-error">
          <div className="w-11 h-11 rounded-full bg-secondary/60 flex items-center justify-center mb-3">
            <AlertCircle size={20} className="text-muted-foreground" />
          </div>
          <p className="text-sm font-medium text-foreground mb-1">Couldn't load this product</p>
          <p className="text-xs text-muted-foreground max-w-xs">Something went wrong. Try reloading.</p>
        </div>
      )}

      {!loading && !error && !notFound && data && p && (
        <>
          {/* Identity */}
          <div className="flex flex-col sm:flex-row items-start gap-5 mb-8">
            <img
              src={p.image_url}
              alt=""
              className="h-32 w-32 md:h-44 md:w-44 rounded-xl object-cover bg-secondary flex-shrink-0 border border-border"
              data-testid="product-detail-image"
            />
            <div className="min-w-0 flex-1">
              <h1 className="text-xl md:text-2xl font-semibold text-foreground leading-snug tracking-tight">{p.title}</h1>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-xs text-muted-foreground">
                {p.seller_name && (
                  p.seller_id ? (
                    <Link
                      href={brandProfilePath(p.seller_id)}
                      className="text-foreground hover:text-primary transition-colors"
                      data-testid="product-detail-brand-link"
                    >
                      {p.seller_name}
                    </Link>
                  ) : (
                    <span className="text-foreground">{p.seller_name}</span>
                  )
                )}
                {p.niche_label && (
                  <span className="px-1.5 py-0.5 rounded border border-border text-[10px] uppercase tracking-wide">
                    {p.niche_label}
                  </span>
                )}
                {p.product_url && (
                  <a
                    href={isPaid ? p.product_url : undefined}
                    onClick={e => { if (!isPaid) { e.preventDefault(); showPaywall('product_detail'); } }}
                    target="_blank" rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-primary hover:underline cursor-pointer"
                  >
                    <ExternalLink size={10} /> View on TikTok Shop
                  </a>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-[11px] text-muted-foreground">
                <span>
                  Price{' '}
                  <span className="font-mono text-foreground">
                    {p.sale_price != null && p.sale_price > 0 ? `$${p.sale_price.toFixed(2)}` : '—'}
                  </span>
                </span>
                <span>
                  Total sold <span className="font-mono text-foreground">{p.sold_count > 0 ? compact(p.sold_count) : '—'}</span>
                </span>
                <span>
                  {/* 0 is indistinguishable from "not reported" for 96% of the
                      catalogue, so it is served as null and shown as a dash. */}
                  In stock <span className="font-mono text-foreground">{p.stock_quantity != null ? compact(p.stock_quantity) : '—'}</span>
                </span>
                {p.rating != null && p.rating > 0 && (
                  <span>Rating <span className="font-mono text-foreground">{p.rating.toFixed(1)}</span></span>
                )}
              </div>
            </div>
          </div>

          {/* 30-day stats */}
          <div className="flex items-center gap-2 mb-2">
            <h2 className="text-sm font-semibold text-foreground">Last 30 days</h2>
            <InfoTip size={12}>
              Computed live from this product's videos. A video counts toward a window by its
              post date; views are lifetime counts on videos posted in that window.
            </InfoTip>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4 mb-8">
            <StatCard label="Videos" icon={<Video size={11} />} value={(w30?.videos ?? 0).toLocaleString()} />
            <StatCard label="Creators" icon={<Users size={11} />} value={(w30?.creators ?? 0).toLocaleString()} />
            <StatCard label="Views" icon={<Eye size={11} />} value={formatViews(w30?.views ?? 0)} />
            <StatCard
              label="Affiliate" icon={<Percent size={11} />}
              value={w30 && w30.affiliateIntensity !== null ? `${Math.round(w30.affiliateIntensity * 100)}%` : '—'}
              muted={!w30 || w30.affiliateIntensity === null}
              hint={
                <InfoTip size={11}>
                  Share of this window's videos carrying TikTok's “Creator earns commission”
                  label. A lower bound — only about half of video rows carry any ad label, and a
                  missing label is not proof a video was unpaid.
                </InfoTip>
              }
            />
            <StatCard
              label="Est. GMV" icon={<BadgeDollarSign size={11} />}
              value={formatGmv(data.gmv?.estRevenue)}
              muted={!data.gmv}
              hint={
                <InfoTip size={11}>
                  Modeled revenue for the last 30 days, read from the nightly ranking — not
                  measured payouts.{!isPaid && ' Available on Pro.'}
                  {!data.gmv && isPaid && ' This product is not ranked in the last 30 days, so there is no figure.'}
                </InfoTip>
              }
            />
          </div>

          {/* THE POINT OF THE PAGE: the videos already working for this product. */}
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <h2 className="text-sm font-semibold text-foreground">Videos driving this product</h2>
            <span className="text-xs text-muted-foreground font-mono">
              {data.videosTotal.toLocaleString()} total · {data.totals.creators.toLocaleString()} creators · {formatViews(data.totals.views)} views
            </span>
          </div>
          <p className="text-xs text-muted-foreground mb-3">
            Ranked by views, highest first — the formats already working. Open one to see how it's shot.
          </p>

          {data.videos.length === 0 ? (
            <div className="rounded-lg border border-border px-4 py-10 text-center" data-testid="product-detail-no-videos">
              <Play size={18} className="text-muted-foreground mx-auto mb-2" />
              <p className="text-sm text-foreground mb-1">No videos recorded for this product yet</p>
              <p className="text-xs text-muted-foreground max-w-sm mx-auto">
                We've seen the product but not yet any TikToks promoting it. Video coverage grows
                each night.
              </p>
            </div>
          ) : (
            <div
              className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3"
              data-testid="product-detail-videos"
            >
              {data.videos.map((v, i) => {
                const vid = videoIdOf(v);
                return (
                  // A div, not an anchor: the footer carries a link to the
                  // creator's profile, and an <a> inside an <a> is invalid HTML
                  // that browsers silently un-nest. The thumbnail is the link
                  // out to TikTok; the profile link sits beside it.
                  <div
                    key={v.video_id || v.video_url || i}
                    className="group relative rounded-lg border border-border bg-card hover:border-primary/40 transition-colors"
                  >
                    <a
                      href={v.video_url || '#'}
                      target="_blank" rel="noopener noreferrer"
                      className="block relative aspect-[9/16] bg-secondary overflow-hidden rounded-t-lg"
                      data-testid="product-video-tile"
                    >
                      {vid && (
                        <img
                          src={`/api/thumb?vid=${encodeURIComponent(vid)}`}
                          alt=""
                          loading="lazy"
                          className="h-full w-full object-cover group-hover:opacity-80 transition-opacity"
                        />
                      )}
                      <div className="absolute bottom-1 left-1 px-1.5 py-0.5 rounded bg-black/75 text-[10px] font-mono text-white">
                        {formatViews(v.view_count)}
                      </div>
                      {v.commissioned && (
                        <div
                          className="absolute top-1 right-1 px-1 py-0.5 rounded bg-primary text-[9px] font-bold text-primary-foreground"
                          title="This video carries TikTok's “Creator earns commission” label."
                        >
                          $
                        </div>
                      )}
                    </a>
                    <div className="p-2">
                      <div className="flex items-center gap-1.5 min-w-0">
                        {v.avatar_url && (
                          <img src={v.avatar_url} alt="" loading="lazy"
                            className="h-5 w-5 rounded-full object-cover bg-secondary flex-shrink-0" />
                        )}
                        <span className="text-[11px] text-foreground truncate">
                          {v.author_name || v.creator_key || 'Unknown'}
                        </span>
                      </div>
                      <div className="flex items-center justify-between mt-1">
                        <span className="text-[10px] text-muted-foreground font-mono">
                          {daysAgo(v.posted_at)}
                        </span>
                        {/* Straight to the creator's profile — the other half of
                            "copy what's already working" is knowing who did it. */}
                        {v.creator_key && (
                          <Link
                            href={creatorProfilePath(v.creator_key)}
                            className="text-[10px] text-muted-foreground hover:text-primary transition-colors"
                          >
                            profile
                          </Link>
                        )}
                      </div>
                      <div className="mt-1.5">
                        <ScriptButton videoId={vid} videoUrl={v.video_url} />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Free tier is served three videos by the API; the upsell promises
              only what Pro can actually deliver. */}
          {!isPaid && data.videosTotal > data.videosShown && (
            <button
              onClick={() => showPaywall('product_videos')}
              className="w-full mt-4 mb-4 rounded-lg border border-primary/30 bg-primary/5 hover:bg-primary/10 transition-colors px-6 py-5 flex items-center justify-center gap-3 cursor-pointer"
              data-testid="upsell-product-videos"
            >
              <Lock size={16} className="text-primary" />
              <span className="text-sm font-semibold text-foreground">
                Unlock all {data.videosTotal.toLocaleString()} videos for this product — and its modeled GMV
              </span>
            </button>
          )}
        </>
      )}
    </div>
  );
}
