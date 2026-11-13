import { useState, useEffect, type ReactNode } from 'react';
import { Link } from 'wouter';
import {
  TIMEFRAMES,
  fetchTopVideos,
  formatViews,
  timeAgo,
  extractPostDate,
  authHeader,
  type VideoWithProduct,
  type Product,
} from '@/lib/supabase';
import { formatCompactNumber, type ProductEstimates } from '@/lib/estimates';
import { useSubscription } from '@/hooks/use-subscription';
import { LoadingBar } from '@/components/LoadingBar';
import { ConfidenceDot } from '@/components/ConfidenceDot';
import { ArrowRight, Eye, ExternalLink, Package, Play } from 'lucide-react';

interface EnrichedProduct extends Product {
  metrics: ProductEstimates;
  topVideos: { video_url: string; view_count: number; cover_image_url: string }[];
}

function formatRevenue(n: number): string {
  if (n >= 1_000_000) return '$' + (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return '$' + (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  if (n > 0) return '$' + n.toFixed(2);
  return '--';
}

async function fetchTop5Products(niche: string, days: number): Promise<EnrichedProduct[]> {
  const params = new URLSearchParams({
    niche, days: String(days), page: '1', limit: '5', sort: 'estRevenue', dir: 'desc',
  });
  const res = await fetch(`/api/top-products?${params}`, { headers: await authHeader() });
  if (!res.ok) throw new Error('Failed to fetch products');
  const data = await res.json();
  return data.products || [];
}

function EmptyRow({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-6">
      <div className="w-9 h-9 rounded-full bg-secondary/60 flex items-center justify-center">{icon}</div>
      <span className="text-sm text-muted-foreground">{text}</span>
    </div>
  );
}

export default function OverviewPage() {
  const { isPaid, showPaywall } = useSubscription();
  // Match the other pages' defaults: paid -> 2 Weeks, free -> 1 Week
  // (free is server-pinned to all/7d; the overview mirrors that window).
  const timeframe = isPaid
    ? TIMEFRAMES[1]
    : (TIMEFRAMES.find(t => t.label === '1 Week') || TIMEFRAMES[0]);

  const [products, setProducts] = useState<EnrichedProduct[]>([]);
  const [videos, setVideos] = useState<VideoWithProduct[]>([]);
  const [loading, setLoading] = useState(true);
  // A failed half is remembered as failed, not swallowed into an empty list
  // that then renders as "No products in this view yet".
  const [productsFailed, setProductsFailed] = useState(false);
  const [videosFailed, setVideosFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      fetchTop5Products('all', timeframe.days).then(p => ({ ok: true, rows: p })).catch(() => ({ ok: false, rows: [] as EnrichedProduct[] })),
      fetchTopVideos('all', timeframe.days, 1, 5).then(r => ({ ok: true, rows: r.videos })).catch(() => ({ ok: false, rows: [] as VideoWithProduct[] })),
    ]).then(([p, v]) => {
      if (!cancelled) {
        setProducts(p.rows); setProductsFailed(!p.ok);
        setVideos(v.rows); setVideosFailed(!v.ok);
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [timeframe.days]);

  return (
    <div className="p-5 md:p-8" data-testid="overview-page">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-foreground mb-1">Overview</h1>
        <p className="text-sm text-muted-foreground">
          Your top performers at a glance — the 5 highest-revenue products and the 5 most-viewed videos{' '}
          <span className="text-zinc-500">({timeframe.label.toLowerCase()})</span>.
        </p>
      </div>

      {loading && <LoadingBar loading={loading} />}

      {!loading && (
        <div className="space-y-8">
          {/* Top 5 Products */}
          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <Package size={15} className="text-primary" /> Top 5 Products
              </h2>
              <Link href="/dashboard/products" className="flex items-center gap-1 text-xs text-primary hover:underline no-underline" data-testid="overview-view-all-products">
                View all <ArrowRight size={12} />
              </Link>
            </div>

            {products.length === 0 ? (
              <EmptyRow icon={<Package size={18} className="text-muted-foreground" />} text={productsFailed ? "Couldn't load products. This is a problem on our side, not an empty result." : "No products in this view yet"} />
            ) : (
              <div className="rounded-lg border border-border bg-card overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-[11px] text-muted-foreground">
                      <th className="text-left py-2.5 px-3 w-10">#</th>
                      <th className="text-left py-2.5 px-3 min-w-[220px]">Product</th>
                      <th className="text-right py-2.5 px-3">Revenue</th>
                      <th className="text-right py-2.5 px-3">Units</th>
                      <th className="text-right py-2.5 px-3">Views</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {products.map((product, idx) => {
                      const rank = idx + 1;
                      const m = product.metrics;
                      return (
                        <tr key={product.product_id} className="hover:bg-secondary/30 transition-colors" data-testid={`overview-product-${rank}`}>
                          <td className="py-2.5 px-3">
                            <span
                              className={`inline-flex items-center justify-center w-6 h-6 rounded text-[10px] font-mono font-bold ${
                                rank <= 3 ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}
                            >
                              {rank}
                            </span>
                          </td>
                          <td className="py-2.5 px-3">
                            <div className="flex items-center gap-3">
                              <div className="w-10 h-10 rounded border border-border flex-shrink-0 overflow-hidden bg-zinc-800">
                                {/* Proxied, same reason as the products table. */}
                                <img src={`/api/thumb?product_id=${encodeURIComponent(product.product_id)}`} alt="" className="w-full h-full object-cover" loading="lazy" onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                              </div>
                              <div className="min-w-0">
                                <p className="text-xs font-medium text-foreground line-clamp-2 leading-snug">{product.title}</p>
                                {product.product_url && (
                                  <a
                                    href={isPaid ? product.product_url : undefined}
                                    onClick={e => { if (!isPaid) { e.preventDefault(); showPaywall('product_detail'); } }}
                                    target="_blank" rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1 text-[10px] text-primary hover:underline mt-0.5 cursor-pointer"
                                  >
                                    <ExternalLink size={9} /> View
                                  </a>
                                )}
                              </div>
                            </div>
                          </td>
                          <td className="py-2.5 px-3 text-right">
                            {(m.estRevenue ?? 0) > 0 ? (
                              // Same confidence marker as the products table, so
                              // a number does not look more solid here than it
                              // does there.
                              <span className="inline-flex items-center justify-end gap-1.5">
                                <ConfidenceDot hasRealDelta={m.hasRealDelta} hasRealPrice={m.hasRealPrice} />
                                <span className="font-mono text-xs font-semibold text-primary">{!m.hasRealPrice ? '≈ ' : ''}{formatRevenue(m.estRevenue!)}</span>
                              </span>
                            ) : (
                              <span className="text-zinc-500 text-xs">—</span>
                            )}
                          </td>
                          <td className="py-2.5 px-3 text-right">
                            <span className="font-mono text-xs text-foreground">{m.estPeriodUnitsSold == null ? '—' : `${m.hasRealDelta ? '' : '≈ '}${m.estPeriodUnitsSold.toLocaleString()}`}</span>
                          </td>
                          <td className="py-2.5 px-3 text-right">
                            <span className="font-mono text-xs text-foreground">
                              {(m.periodViews ?? 0) > 0 ? formatCompactNumber(m.periodViews!) : ((m.totalViews ?? 0) > 0 ? formatCompactNumber(m.totalViews!) : '--')}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Top 5 Videos */}
          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <Play size={15} className="text-primary" /> Top 5 Videos
              </h2>
              <Link href="/dashboard" className="flex items-center gap-1 text-xs text-primary hover:underline no-underline" data-testid="overview-view-all-videos">
                View all <ArrowRight size={12} />
              </Link>
            </div>

            {videos.length === 0 ? (
              <EmptyRow icon={<Eye size={18} className="text-muted-foreground" />} text={videosFailed ? "Couldn't load videos. This is a problem on our side, not an empty result." : "No videos in this view yet"} />
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                {videos.map((video, idx) => {
                  const rank = idx + 1;
                  const postDate = extractPostDate(video.video_url);
                  const vidId = video.video_url?.match(/video\/(\d+)/)?.[1];
                  return (
                    <div key={vidId ?? `rank-${rank}`} className="rounded-lg border border-border bg-card overflow-hidden" data-testid={`overview-video-${rank}`}>
                      <div className="relative aspect-[9/16] max-h-[220px] overflow-hidden bg-muted">
                        {(vidId || video.cover_image_url) ? (
                          <img src={vidId ? `/api/thumb?vid=${vidId}` : (video.cover_image_url || '')} alt="" className="w-full h-full object-cover" loading="lazy" onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                        ) : (
                          <div className="w-full h-full bg-gradient-to-b from-zinc-800 to-zinc-900" />
                        )}
                        <div className="absolute top-2 left-2 px-2 py-0.5 rounded font-mono text-xs font-bold bg-primary text-primary-foreground" >#{rank}</div>
                        <div className="absolute bottom-2 left-2 flex items-center gap-1 px-2 py-0.5 rounded bg-black/70 backdrop-blur-sm">
                          <Eye size={12} className="text-white/80" />
                          <span className="text-[11px] font-mono font-medium text-white">{formatViews(video.view_count || 0)}</span>
                        </div>
                        {video.video_url && (
                          <a
                            href={isPaid ? video.video_url : undefined}
                            onClick={e => { if (!isPaid) { e.preventDefault(); showPaywall('video_detail'); } }}
                            target="_blank" rel="noopener noreferrer"
                            className="absolute bottom-2 right-2 w-7 h-7 rounded-full flex items-center justify-center bg-black/50 backdrop-blur-sm hover:bg-black/70 transition-colors cursor-pointer"
                          >
                            <ExternalLink size={12} className="text-white/70" />
                          </a>
                        )}
                      </div>
                      <div className="p-2.5">
                        <div className="flex items-center gap-1.5 mb-1">
                          {video.creator_key ? (
                            /* Proxied: the payload's author_avatar_url is a signed
                               CDN link that 403s within a day — 20 of 20 measured
                               dead. A stored avatar always renders. */
                            <img src={`/api/avatar?key=${encodeURIComponent(video.creator_key)}`} alt="" loading="lazy" className="w-5 h-5 rounded-full object-cover flex-shrink-0 bg-muted" />
                          ) : (
                            <div className="w-5 h-5 rounded-full bg-muted flex-shrink-0" />
                          )}
                          <span className="text-[11px] font-medium text-foreground truncate">{video.author_name || 'Unknown'}</span>
                        </div>
                        {video.product && (
                          <p className="text-[10px] text-muted-foreground line-clamp-1">{video.product.title}</p>
                        )}
                        <span className="text-[9px] text-zinc-500">
                          {postDate ? timeAgo(postDate.toISOString()) : timeAgo(video.created_at)}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
