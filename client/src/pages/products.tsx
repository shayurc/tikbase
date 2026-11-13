import { useState, useEffect, type ReactNode } from 'react';
import {
  NICHES,
  TIMEFRAMES,
  formatViews,
  authHeader,
  type Product,
  type ProductVideo,
} from '@/lib/supabase';
import { formatCompactNumber, type ProductEstimates } from '@/lib/estimates';
import { InfoTip } from '@/components/InfoTip';
import { useBookmarks } from '@/lib/bookmarks';
import { useSubscription } from '@/hooks/use-subscription';
import { Bookmark, ChevronLeft, ChevronRight, ExternalLink, ChevronUp, ChevronDown, TrendingUp, Lock, Package, Sparkles } from 'lucide-react';
import { LoadingBar } from '@/components/LoadingBar';
import { ConfidenceDot } from '@/components/ConfidenceDot';
import { Link } from 'wouter';
import { brandProfilePath } from '@/components/GlobalSearch';
import { productDetailPath } from '@/components/ProductSearch';

/** One window's revenue block, as merged server-side by /api/top-products. */
interface WindowRevenue {
  revenue: number;
  unitsSold: number;
  hasRealDelta: boolean;
  hasRealPrice: boolean;
}

interface EnrichedProduct extends Product {
  metrics: ProductEstimates;
  topVideos: { video_url: string; view_count: number; cover_image_url: string }[];
  // null when the product is not ranked in that window — rendered as an em
  // dash, never $0.
  windows?: Record<string, WindowRevenue | null>;
  distinct_creators?: number;
  window_video_count?: number;
  affiliate_intensity?: number | null;
  opportunity?: boolean;
}

type SortKey =
  | 'periodViews' | 'sold_count' | 'estRevenue' | 'stock_quantity' | 'sale_price'
  | 'revenue7d' | 'revenue30d' | 'total_sold' | 'distinct_creators';
type SortDir = 'asc' | 'desc';

// Client-side cache for product API responses
const productCache = new Map<string, { data: any; timestamp: number }>();
const PRODUCT_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

async function fetchProducts(
  niche: string, days: number, page: number, limit: number, sort: string, dir: string
): Promise<{ products: EnrichedProduct[]; total: number }> {
  const cacheKey = `${niche}:${days}:${page}:${limit}:${sort}:${dir}`;
  const cached = productCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < PRODUCT_CACHE_TTL) return cached.data;

  const params = new URLSearchParams({ niche, days: String(days), page: String(page), limit: String(limit), sort, dir });
  const res = await fetch(`/api/top-products?${params}`, { headers: await authHeader() });
  if (!res.ok) throw new Error('Failed to fetch products');
  const data = await res.json();
  const result = { products: data.products || [], total: data.total || 0 };
  productCache.set(cacheKey, { data: result, timestamp: Date.now() });
  return result;
}

function formatRevenue(n: number): string {
  if (n >= 1_000_000) return '$' + (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return '$' + (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  if (n > 0) return '$' + n.toFixed(2);
  return '--';
}

// Windows that are always columns, whatever the ranking window is.
const BASE_WINDOWS = [7, 30];

/**
 * One window's GMV cell.
 *
 * null window => the product is not in that window's ranked payload. That means
 * "not ranked", NOT "sold nothing", so it renders an em dash. Printing $0 would
 * assert a fact we do not have.
 */
function GmvCell({ w }: { w: WindowRevenue | null | undefined }) {
  if (!w) {
    return (
      <span
        className="text-zinc-600 text-xs font-mono"
        title="Not ranked in this window — no figure, which is not the same as zero sales."
      >
        —
      </span>
    );
  }
  return (
    <div
      className="flex items-center justify-end gap-1.5"
      title={
        `${w.unitsSold.toLocaleString()} units in window` +
        (w.hasRealPrice ? '' : ' · price estimated from category median')
      }
    >
      <ConfidenceDot hasRealDelta={w.hasRealDelta} hasRealPrice={w.hasRealPrice} />
      <span className="font-mono text-xs font-semibold text-foreground">
        {w.revenue > 0 ? `${w.hasRealPrice ? '' : '≈'}${formatRevenue(w.revenue)}` : '—'}
      </span>
    </div>
  );
}



export default function ProductsPage() {
  const [niche, setNiche] = useState(NICHES[0].slug);
  const { isPaid, showPaywall } = useSubscription();
  const [timeframe, setTimeframe] = useState(TIMEFRAMES[1]); // "2 Weeks"
  const [pageProducts, setPageProducts] = useState<EnrichedProduct[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>('estRevenue');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [mode, setMode] = useState<'bestsellers' | 'trending'>('bestsellers');
  const [page, setPage] = useState(1);

  // Ranking presets. Best Sellers = actual performance (revenue from real/
  // estimated units sold in the window). Trending = fastest-rising video
  // attention. Both are just a default sort over the same data; users can
  // still click any column to re-sort.
  function applyMode(next: 'bestsellers' | 'trending') {
    setMode(next);
    setSortKey(next === 'bestsellers' ? 'estRevenue' : 'periodViews');
    setSortDir('desc');
  }
  const { isProductBookmarked, toggleProductBookmark } = useBookmarks();

  const limit = 50;
  const totalPages = Math.ceil(total / limit);

  // 7d and 30d are permanent columns. Any other selected timeframe earns an
  // extra column after 30d rather than replacing one, so switching the ranking
  // window never hides the two windows the hierarchy is built around.
  const extraWindow = BASE_WINDOWS.includes(timeframe.days) ? null : timeframe.days;

  // Free users get the real top 10 on the 1 Week window (server enforces
  // all/7d/top-10; align the UI so the active pill matches what's returned).
  useEffect(() => {
    if (!isPaid) {
      const oneWeek = TIMEFRAMES.find(t => t.label === '1 Week');
      if (oneWeek) setTimeframe(oneWeek);
    }
  }, [isPaid]);

  useEffect(() => { setPage(1); }, [timeframe, sortKey, sortDir]);

  // Fetch products from server-side endpoint
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchProducts(niche, timeframe.days, page, limit, sortKey, sortDir)
      .then(res => {
        if (!cancelled) {
          setPageProducts(res.products);
          setTotal(res.total);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [niche, timeframe, page, sortKey, sortDir]);

  // Pre-fetch the OTHER timeframes for snappier tab switching — but only after
  // the current view has loaded, and sequentially, so we don't fire several
  // heavy uncached computations at once and starve the foreground request.
  useEffect(() => {
    if (loading) return;
    let cancelled = false;
    const others = TIMEFRAMES.filter(t => t.days !== timeframe.days);
    (async () => {
      for (const t of others) {
        if (cancelled) return;
        await fetchProducts(niche, t.days, 1, limit, sortKey, sortDir).catch(() => {});
      }
    })();
    return () => { cancelled = true; };
  }, [niche, loading]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    else { setSortKey(key); setSortDir('desc'); }
  }

  function SortHeader({ label, sortKeyVal, tip, className = '' }: { label: string; sortKeyVal: SortKey; tip?: ReactNode; className?: string }) {
    const active = sortKey === sortKeyVal;
    return (
      <th
        className={`py-3 px-3 font-medium text-[11px] cursor-pointer select-none hover:text-foreground transition-colors ${active ? 'text-primary' : 'text-muted-foreground'} ${className}`}
        onClick={() => toggleSort(sortKeyVal)}
      >
        <div className={`flex items-center gap-1 ${className.includes('text-left') ? '' : 'justify-end'}`}>
          {label}
          {tip && <InfoTip size={11}>{tip}</InfoTip>}
          {active && (sortDir === 'desc' ? <ChevronDown size={12} className="text-primary" /> : <ChevronUp size={12} className="text-primary" />)}
        </div>
      </th>
    );
  }

  return (
    <div className="p-5 md:p-8" data-testid="products-page">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-foreground mb-1">Top Products</h1>
        <p className="text-sm text-muted-foreground">
          {mode === 'bestsellers'
            ? 'The best-performing products in your selected timeframe, ranked by revenue from units sold.'
            : 'Products with the fastest-rising TikTok video attention in your selected timeframe.'}
        </p>
      </div>


      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-3">
        {/* Ranking-mode toggle */}
        <div className="flex items-center gap-1 bg-card rounded-lg p-1 border border-border max-w-full overflow-x-auto [&>button]:flex-shrink-0">
          {([['bestsellers', 'Best Sellers'], ['trending', 'Trending']] as const).map(([val, label]) => (
            <button
              key={val}
              onClick={() => applyMode(val)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${mode === val ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              data-testid={`mode-${val}`}
            >
              {label}
            </button>
          ))}
          <InfoTip size={12} className="mx-1">
            <span className="font-semibold text-foreground">Best Sellers</span> ranks by
            actual revenue from units sold in the window (real sales when available,
            otherwise estimated). <span className="font-semibold text-foreground">Trending</span> ranks
            by fastest-rising video views. Click any column to re-sort.
          </InfoTip>
        </div>

        <select value={niche} onChange={e => {
            if (!isPaid && e.target.value !== 'all') {
              e.target.value = 'all';
              showPaywall('category_filter');
              return;
            }
            setNiche(e.target.value);
          }}
          className="h-9 px-3 rounded-md text-sm font-medium border border-border bg-card text-foreground focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer">
          {NICHES.map(n => (
            <option key={n.slug} value={n.slug} disabled={!isPaid && n.slug !== 'all'}>
              {n.label}{!isPaid && n.slug !== 'all' ? ' (Pro)' : ''}
            </option>
          ))}
        </select>

        <div className="flex items-center gap-1 bg-card rounded-lg p-1 border border-border max-w-full overflow-x-auto [&>button]:flex-shrink-0">
          {TIMEFRAMES.map(tf => {
            const isLocked = !isPaid && tf.label !== '1 Week';
            return (
              <button key={tf.label}
                onClick={() => {
                  if (isLocked) { showPaywall('timeframe'); return; }
                  setTimeframe(tf);
                }}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${timeframe.label === tf.label ? 'bg-primary text-primary-foreground' : isLocked ? 'text-zinc-600' : 'text-muted-foreground hover:text-foreground'}`}>
                {tf.label}
                {isLocked && <Lock size={8} className="inline ml-1 opacity-50" />}
              </button>
            );
          })}
        </div>

        <span className="text-xs text-muted-foreground font-mono ml-auto">
          {loading ? '...' : `${total.toLocaleString()} products`}
        </span>
      </div>

      {/* Info banner */}
      <div className="flex items-center gap-2 mb-4 px-3 py-2 rounded-md bg-zinc-900/60 border border-zinc-800 text-[11px] text-zinc-400">
        <TrendingUp size={13} className="text-zinc-500 flex-shrink-0" />
        <span>
          {mode === 'bestsellers'
            ? 'Ranked by revenue from units sold in the selected timeframe. Rows marked “in period” use real day-over-day sales; “estimated” rows are modeled from views until more sales history accrues.'
            : 'Ranked by views from TikTok videos posted within the selected timeframe. Products with no recent video activity rank lower.'}
        </span>
      </div>

      {loading && <LoadingBar loading={loading} />}

      {!loading && total === 0 && (
        <div className="flex flex-col items-center text-center py-20 px-6">
          <div className="w-11 h-11 rounded-full bg-secondary/60 flex items-center justify-center mb-3">
            <Package size={20} className="text-muted-foreground" />
          </div>
          <p className="text-sm font-medium text-foreground mb-1">No products in this view yet</p>
          <p className="text-xs text-muted-foreground max-w-xs">
            No products have recent video activity for this niche and timeframe. Try a
            broader timeframe (like 1 Year) or switch niche to <span className="text-foreground">All</span>.
          </p>
        </div>
      )}

      {!loading && pageProducts.length > 0 && (
        <>
          {/* MOBILE — the #27 deferral. A 12-column metrics table cannot be made
              readable at 390px by shrinking it, so below md the same rows
              render as cards: thumb, name, the 30-day figure with its
              confidence dot and badge, then price / 7d / creators underneath.
              The desktop table below is structurally untouched. */}
          <div className="md:hidden space-y-3">
            {pageProducts.map((product, idx) => {
              const rank = (page - 1) * limit + idx + 1;
              const price = product.sale_price || 0;
              const w30 = product.windows?.['30'];
              const w7 = product.windows?.['7'];
              return (
                <Link
                  key={product.product_id}
                  href={productDetailPath(product.product_id)}
                  className="block rounded-lg border border-border bg-card p-4 no-underline active:bg-secondary/30 transition-colors"
                  data-testid={`product-card-${product.product_id}`}
                >
                  <div className="flex gap-3.5">
                    <div className="w-16 h-16 rounded-md border border-border flex-shrink-0 overflow-hidden bg-zinc-800">
                      <img
                        src={`/api/thumb?product_id=${encodeURIComponent(product.product_id)}`}
                        alt="" loading="lazy" className="w-full h-full object-cover"
                        onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start gap-2">
                        <span className={`inline-flex items-center justify-center w-5 h-5 rounded text-[10px] font-mono font-bold flex-shrink-0 ${
                          rank <= 3 ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}>
                          {rank}
                        </span>
                        <p className="text-[13px] font-medium text-foreground leading-snug line-clamp-2 min-w-0">
                          {product.title}
                        </p>
                      </div>
                      {product.seller_name && (
                        <p className="text-[11px] text-muted-foreground truncate mt-1">{product.seller_name}</p>
                      )}
                      <div className="flex items-center gap-2 mt-2">
                        {/* The headline number, at the size it deserves. */}
                        {w30 ? (
                          <span className="inline-flex items-center gap-1.5">
                            <ConfidenceDot hasRealDelta={w30.hasRealDelta} hasRealPrice={w30.hasRealPrice} />
                            <span className="font-mono text-base font-semibold text-foreground">
                              {w30.revenue > 0 ? `${w30.hasRealPrice ? '' : '≈'}${formatRevenue(w30.revenue)}` : '—'}
                            </span>
                          </span>
                        ) : (
                          <span className="font-mono text-base text-zinc-600">—</span>
                        )}
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">30d</span>
                        {product.opportunity && (
                          <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wide border border-primary/40 text-primary-bright bg-primary/10">
                            <Sparkles size={8} /> Opportunity
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 mt-3.5 pt-3 border-t border-border/60 text-[11px]">
                    <span className="text-muted-foreground">
                      Price <span className="font-mono text-foreground ml-0.5">{price > 0 ? `$${price.toFixed(2)}` : '—'}</span>
                    </span>
                    <span className="text-muted-foreground">
                      7d <span className="font-mono text-foreground ml-0.5">{w7 && w7.revenue > 0 ? formatRevenue(w7.revenue) : '—'}</span>
                    </span>
                    <span className="text-muted-foreground">
                      Creators <span className="font-mono text-foreground ml-0.5">
                        {product.distinct_creators == null ? '—' : product.distinct_creators.toLocaleString()}
                      </span>
                    </span>
                  </div>
                </Link>
              );
            })}
          </div>

          <div className="hidden md:block rounded-lg border border-border bg-card overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-3.5 px-4 font-medium text-[11px] text-muted-foreground w-12">#</th>
                  <th className="text-left py-3.5 px-4 font-medium text-[11px] text-muted-foreground min-w-[260px]">Product</th>
                  <SortHeader
                    label="Price"
                    sortKeyVal="sale_price"
                    tip="Current listed sale price on TikTok Shop (US region)."
                  />
                  <SortHeader
                    label="7d GMV"
                    sortKeyVal="revenue7d"
                    tip={<>Revenue from units sold in the last 7 days. The dot is confidence:
                      <span className="text-primary-bright">violet</span> = measured from a real
                      sales snapshot, <span className="text-warning">amber</span> = modeled from views.
                      “—” means the product isn’t ranked in that window, which is not the same as
                      zero sales.</>}
                  />
                  <SortHeader
                    label="30d GMV"
                    sortKeyVal="revenue30d"
                    tip="Revenue from units sold in the last 30 days, same confidence rules as 7d."
                  />
                  {/* A ranking window outside 7/30 earns its own column, after
                      30d, so the selected timeframe is never invisible. */}
                  {extraWindow && (
                    <SortHeader
                      label={`${extraWindow}d GMV`}
                      sortKeyVal="estRevenue"
                      tip={`Revenue from units sold in the last ${extraWindow} days — the window you have selected, which is also what the ranking uses.`}
                    />
                  )}
                  <SortHeader
                    label="Total Sold"
                    sortKeyVal="total_sold"
                    tip="Lifetime units sold as reported by TikTok Shop — not the window figure."
                  />
                  <SortHeader
                    className="hidden md:table-cell"
                    label="In Stock"
                    sortKeyVal="stock_quantity"
                    tip={<>Units currently in stock, when TikTok reports them. Mostly it does not:
                      46,195 of 47,962 products report 0, which is indistinguishable from “not
                      reported”, so 0 renders as “—” rather than claiming the item is sold out.
                      Treat a present number as a signal and an absent one as no information.</>}
                  />
                  <SortHeader
                    className="hidden md:table-cell"
                    label="Creators"
                    sortKeyVal="distinct_creators"
                    tip="Distinct creators who posted about this product inside the ranking window — at 30 days this is creators per month. Low creators against proven sales is the opportunity signal."
                  />
                  <th className="hidden md:table-cell py-4 px-4 font-medium text-[11px] text-muted-foreground">
                    <div className="flex items-center gap-1 justify-end">
                      Affiliate&nbsp;%
                      <InfoTip size={11}>
                        Share of this window’s videos carrying TikTok’s “Creator earns commission”
                        label. It replaces commission rate, which TikTok does not populate — of
                        47,837 products, zero carry a commission rate above zero.
                        <span className="block mt-1">
                          A LOWER BOUND: only 53.5% of video rows carry any ad label, and a missing
                          label is not proof a video was unpaid. “—” means no videos in the window.
                        </span>
                      </InfoTip>
                    </div>
                  </th>
                  <SortHeader
                    className="hidden md:table-cell"
                    label="Views"
                    sortKeyVal="periodViews"
                    tip="TikTok views from videos posted within the ranking window. This is what the Trending mode sorts by."
                  />
                  <th className="py-4 px-4 w-10"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {pageProducts.map((product, idx) => {
                  const rank = (page - 1) * limit + idx + 1;
                  const m = product.metrics;
                  const price = product.sale_price || 0;
                  const bookmarked = isProductBookmarked(product.product_id);

                  // Top 5 videos pre-sorted by server
                  const displayVideos = product.topVideos || [];

                  return (
                    <tr key={product.product_id} className="hover:bg-secondary/30 transition-colors">
                      <td className="py-4 px-4">
                        <span className={`inline-flex items-center justify-center w-6 h-6 rounded text-[10px] font-mono font-bold ${
                          rank <= 3 ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}>
                          {rank}
                        </span>
                      </td>

                      <td className="py-4 px-4">
                        <div className="flex items-center gap-3">
                          <div className="w-14 h-14 rounded-md border border-border flex-shrink-0 overflow-hidden bg-zinc-800">
                            {/* Through the cache-through proxy, not the payload's
                                image_url: precomputed payloads carry the raw
                                signed CDN URL and those 403 once the signature
                                lapses — measured 8 of 20 dead on this page.
                                Enlarging the box without this only enlarges the
                                hole. */}
                            <img src={`/api/thumb?product_id=${encodeURIComponent(product.product_id)}`} alt="" className="w-full h-full object-cover" loading="lazy" onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-start gap-1.5">
                              <Link
                                href={productDetailPath(product.product_id)}
                                className="text-[13px] font-medium text-foreground line-clamp-2 leading-snug hover:text-primary transition-colors"
                                data-testid={`product-link-${product.product_id}`}
                              >
                                {product.title}
                              </Link>
                              {/* Inline with the name, because it is a property
                                  of the product, not another metric column. */}
                              {product.opportunity && (
                                <span
                                  className="inline-flex items-center gap-0.5 flex-shrink-0 mt-px px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wide border border-primary/40 text-primary-bright bg-primary/10"
                                  title="Opportunity: measured sales in this window's top revenue quartile, promoted by fewer creators than the median product on this page. Proven demand, little competition."
                                  data-testid="opportunity-badge"
                                >
                                  <Sparkles size={8} /> Opportunity
                                </span>
                              )}
                            </div>
                            {/* Shop name — the pro's hierarchy leads with who is
                                selling, not just what. 77% of products carry it. */}
                            {product.seller_name && (
                              <p className="text-[10px] text-muted-foreground truncate mt-0.5">
                                {/* Addressed by name: these rows come from the
                                    precomputed payload, which carries the shop
                                    name but not its id. The API resolves it. */}
                                <Link
                                  href={brandProfilePath(`name:${product.seller_name}`)}
                                  className="hover:text-primary transition-colors"
                                  data-testid="product-row-brand-link"
                                >
                                  {product.seller_name}
                                </Link>
                              </p>
                            )}
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

                      {/* Price */}
                      <td className="py-4 px-4 text-right">
                        <span className="font-mono text-xs font-medium text-foreground">
                          {price > 0 ? `$${price.toFixed(2)}` : '—'}
                        </span>
                      </td>

                      {/* 7d / 30d GMV — always both, whatever the ranking window */}
                      <td className="py-4 px-4 text-right">
                        <GmvCell w={product.windows?.['7']} />
                      </td>
                      <td className="py-4 px-4 text-right">
                        <GmvCell w={product.windows?.['30']} />
                      </td>
                      {extraWindow && (
                        <td className="py-4 px-4 text-right">
                          <GmvCell w={product.windows?.[String(extraWindow)]} />
                        </td>
                      )}

                      {/* Total sold (lifetime) */}
                      <td className="py-4 px-4 text-right">
                        <span className="font-mono text-xs text-foreground">
                          {product.sold_count > 0 ? formatCompactNumber(product.sold_count) : '—'}
                        </span>
                      </td>

                      {/* In stock */}
                      <td className="hidden md:table-cell py-4 px-4 text-right">
                        <span className="font-mono text-xs text-foreground">
                          {product.stock_quantity != null && product.stock_quantity > 0
                            ? formatCompactNumber(product.stock_quantity)
                            : '—'}
                        </span>
                      </td>

                      {/* Creators in window. ZERO IS A REAL VALUE here and is
                          printed as 0, not a dash: "nobody is posting about a
                          product that is measurably selling" is precisely the
                          opportunity signal, and a dash would read as "unknown"
                          and hide it. Only a missing field dashes. */}
                      <td className="hidden md:table-cell py-4 px-4 text-right">
                        <span
                          className="font-mono text-xs text-foreground"
                          title={
                            (product.window_video_count ?? 0) +
                            ' video(s) in the ranking window from ' +
                            (product.distinct_creators ?? 0) + ' distinct creator(s)'
                          }
                        >
                          {product.distinct_creators == null
                            ? '—'
                            : product.distinct_creators.toLocaleString()}
                        </span>
                      </td>

                      {/* Affiliate intensity — null (no window videos) shows a
                          dash, never 0%, which would claim nobody was paid. */}
                      <td className="hidden md:table-cell py-4 px-4 text-right">
                        <span className="font-mono text-xs text-muted-foreground">
                          {product.affiliate_intensity == null
                            ? '—'
                            : `${Math.round(product.affiliate_intensity * 100)}%`}
                        </span>
                      </td>

                      {/* Views — the Trending ranking signal */}
                      <td className="hidden md:table-cell py-4 px-4 text-right">
                        {/* An em dash covers both "no views" and "we could not
                            read them"; the tooltip is what tells them apart,
                            because a zero and an unknown must not look alike. */}
                        <div title={m.viewsUnknown
                          ? 'View stats could not be read for this product on the last refresh — this is not zero views'
                          : (m.periodViews ?? 0).toLocaleString() + ' views from ' + (m.periodVideoCount ?? 0) + ' videos posted in this window\n' + (m.totalViews ?? 0).toLocaleString() + ' total views all-time'}>
                          <span className="font-mono text-xs text-foreground">
                            {(m.periodViews ?? 0) > 0 ? formatCompactNumber(m.periodViews!) : (
                              (m.totalViews ?? 0) > 0 ? <span className="text-zinc-500">{formatCompactNumber(m.totalViews!)}</span> : <span className="text-zinc-500">—</span>
                            )}
                          </span>
                        </div>
                      </td>

                      <td className="py-4 px-4">
                        <button onClick={() => toggleProductBookmark(product)} className="w-7 h-7 rounded flex items-center justify-center hover:bg-secondary transition-colors">
                          <Bookmark size={14} className={bookmarked ? 'text-primary fill-primary' : 'text-muted-foreground'} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Free tier sees the real top 10, then one upsell to the full list.
              Paid tier keeps normal pagination. */}
          {!isPaid ? (
            <button
              onClick={() => showPaywall('top_products')}
              className="w-full mt-4 mb-4 rounded-lg border border-primary/30 bg-primary/5 hover:bg-primary/10 transition-colors px-6 py-5 flex items-center justify-center gap-3 cursor-pointer"
              data-testid="upsell-products"
            >
              <Lock size={16} className="text-primary" />
              <span className="text-sm font-semibold text-foreground">
                Unlock {Math.max(0, total - pageProducts.length).toLocaleString()}+ more products — see everything selling right now
              </span>
            </button>
          ) : totalPages > 1 ? (
            <div className="flex items-center justify-center gap-2 mt-6 mb-4">
              <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
                className="h-9 w-9 rounded-md border border-border flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-30 disabled:pointer-events-none transition-colors">
                <ChevronLeft size={16} />
              </button>
              <span className="text-sm font-mono text-muted-foreground px-3">{page} / {totalPages}</span>
              <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}
                className="h-9 w-9 rounded-md border border-border flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-30 disabled:pointer-events-none transition-colors">
                <ChevronRight size={16} />
              </button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
