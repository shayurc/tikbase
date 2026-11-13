import { useState, useEffect } from 'react';
import { useRoute, Link } from 'wouter';
import { formatViews, authHeader } from '@/lib/supabase';
import { useSubscription } from '@/hooks/use-subscription';
import { InfoTip } from '@/components/InfoTip';
import { LoadingBar } from '@/components/LoadingBar';
import { productDetailPath } from '@/components/ProductSearch';
import {
  ArrowLeft, ExternalLink, Lock, Store, AlertCircle, Package, ShoppingCart, Layers,
} from 'lucide-react';
import { decodeRouteParam } from '@/lib/route-param';

interface BrandProduct {
  product_id: string;
  title: string | null;
  niche_slug: string | null;
  image_url: string;
  sale_price: number | null;
  sold_count: number;
  stock_quantity: number | null;
  gmv30d?: { estRevenue: number; hasRealDelta: boolean };
}
interface BrandData {
  brand: {
    seller_id: string;
    seller_name: string | null;
    seller_tiktok_url: string | null;
    product_count: number;
    total_sold: number;
    niches: string[];
    first_seen: string | null;
    revenue30d?: { estRevenue: number; products: number; measured: number };
  };
  products: BrandProduct[];
  productsTotal: number;
  productsPage: number;
  productsLimit: number;
  tier: 'free' | 'paid';
}

// Same rule as every other money column in the app: no figure is an em dash,
// never "$0" — that reads as "sold nothing" rather than "not modelled".
function formatGmv(n: number | undefined | null): string {
  if (n === undefined || n === null || !(n > 0)) return '—';
  if (n >= 1_000_000) return '$' + (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return '$' + (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return '$' + n.toFixed(0);
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

export default function BrandProfilePage() {
  const [, params] = useRoute('/dashboard/brand/:sellerId');
  const { isPaid, showPaywall } = useSubscription();
  const [data, setData] = useState<BrandData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [page, setPage] = useState(1);

  // Encoded at the link, because the second address form is 'name:<shop>' and
  // shop names contain spaces, slashes and ampersands.
  // decodeRouteParam, not decodeURIComponent: a shop name with a % in it
  // ("100% Pure") threw here and took the whole app down with it.
  const sellerId = decodeRouteParam(params?.sellerId);

  useEffect(() => {
    if (!sellerId) return;
    let cancelled = false;
    setLoading(true);
    setError(false);
    setNotFound(false);

    (async () => {
      try {
        const res = await fetch(
          `/api/brand-profile?seller_id=${encodeURIComponent(sellerId)}&page=${page}`,
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
  }, [sellerId, page]);

  const b = data?.brand;
  const name = b?.seller_name || sellerId.replace(/^name:/, '');
  const totalPages = data
    ? Math.max(1, Math.ceil(data.productsTotal / Math.max(1, data.productsLimit)))
    : 1;

  return (
    <div className="p-5 md:p-8 max-w-[1400px] mx-auto">
      <Link
        href="/dashboard/products"
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors mb-4"
        data-testid="brand-profile-back"
      >
        <ArrowLeft size={13} />
        Products
      </Link>

      {loading && <LoadingBar loading={loading} />}

      {!loading && notFound && (
        <div className="flex flex-col items-center text-center py-20 px-6" data-testid="brand-profile-404">
          <div className="w-11 h-11 rounded-full bg-secondary/60 flex items-center justify-center mb-3">
            <Store size={20} className="text-muted-foreground" />
          </div>
          <p className="text-sm font-medium text-foreground mb-1">Brand not found</p>
          <p className="text-xs text-muted-foreground max-w-xs font-mono break-all">{sellerId}</p>
        </div>
      )}

      {!loading && error && (
        <div className="flex flex-col items-center text-center py-20 px-6" data-testid="brand-profile-error">
          <div className="w-11 h-11 rounded-full bg-secondary/60 flex items-center justify-center mb-3">
            <AlertCircle size={20} className="text-muted-foreground" />
          </div>
          <p className="text-sm font-medium text-foreground mb-1">Couldn't load this brand</p>
          <p className="text-xs text-muted-foreground max-w-xs">
            Something went wrong. Try reloading the page.
          </p>
        </div>
      )}

      {!loading && !error && !notFound && data && b && (
        <>
          {/* Identity. Brands carry no logo in the catalogue, so the tile is a
              glyph rather than a broken image. */}
          <div className="flex items-start gap-5 mb-8">
            <div className="h-20 w-20 md:h-24 md:w-24 rounded-xl bg-secondary flex items-center justify-center flex-shrink-0">
              <Store size={30} className="text-muted-foreground" />
            </div>
            <div className="min-w-0 flex-1">
              <h1 className="text-2xl font-semibold text-foreground break-words tracking-tight" data-testid="brand-profile-name">
                {name}
              </h1>
              {b.seller_tiktok_url ? (
                <a
                  href={b.seller_tiktok_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs font-mono text-muted-foreground hover:text-primary transition-colors"
                  data-testid="brand-profile-tiktok"
                >
                  Shop on TikTok
                  <ExternalLink size={10} />
                </a>
              ) : (
                <span className="text-xs font-mono text-muted-foreground break-all">{b.seller_id}</span>
              )}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-[11px] text-muted-foreground">
                <span>
                  First seen <span className="font-mono text-foreground">{formatDate(b.first_seen)}</span>
                </span>
                {b.niches.length > 0 && (
                  <span className="font-mono text-foreground truncate max-w-full">
                    {b.niches.slice(0, 4).join(' · ')}
                    {b.niches.length > 4 && ` +${b.niches.length - 4}`}
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
            <StatCard
              label="Products" icon={<Package size={11} />}
              value={b.product_count.toLocaleString()}
            />
            <StatCard
              label="Units sold" icon={<ShoppingCart size={11} />}
              value={formatViews(b.total_sold)}
              hint={
                <InfoTip size={11}>
                  Lifetime units across every product we track for this shop, as reported
                  by TikTok Shop — not a 30-day figure.
                </InfoTip>
              }
            />
            <StatCard
              label="Niches" icon={<Layers size={11} />}
              value={b.niches.length.toLocaleString()}
            />
            <StatCard
              label="Est. GMV 30d"
              icon={<Lock size={11} className={isPaid ? 'opacity-0' : ''} />}
              value={formatGmv(b.revenue30d?.estRevenue)}
              muted={!b.revenue30d}
              hint={
                <InfoTip size={11}>
                  Modeled from measured sales movement, not reported payouts.
                  {!isPaid && ' Available on Pro.'}
                  {b.revenue30d && (
                    <> Covers {b.revenue30d.products.toLocaleString()} of{' '}
                    {b.product_count.toLocaleString()} products
                    {b.revenue30d.measured > 0
                      ? `, ${b.revenue30d.measured.toLocaleString()} backed by a measured sales delta`
                      : '; none of them have a measured sales delta yet, so the figure is fully modeled'}
                    .</>
                  )}
                </InfoTip>
              }
            />
          </div>

          {/* Catalogue */}
          <div className="flex items-center gap-2 mb-2">
            <h2 className="text-sm font-semibold text-foreground">Catalogue</h2>
            <span className="text-xs text-muted-foreground font-mono" data-testid="brand-products-total">
              {data.productsTotal.toLocaleString()} total
            </span>
          </div>
          {data.products.length === 0 ? (
            <div className="rounded-lg border border-border px-4 py-8 text-center text-xs text-muted-foreground mb-6">
              No products recorded for this brand.
            </div>
          ) : (
            <div className="rounded-lg border border-border overflow-x-auto mb-3">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-card/50 text-[11px] uppercase tracking-wide text-muted-foreground">
                    <th className="text-left font-medium py-3 pl-5 pr-3">Product</th>
                    <th className="text-right font-medium py-3 px-3 whitespace-nowrap">Price</th>
                    <th className="text-right font-medium py-3 px-3 whitespace-nowrap">Sold</th>
                    <th className="text-right font-medium py-3 px-5 whitespace-nowrap">
                      {isPaid ? 'Est. GMV 30d' : 'Est. GMV'}
                    </th>
                  </tr>
                </thead>
                <tbody data-testid="brand-profile-products">
                  {data.products.map(p => (
                    <tr key={p.product_id} className="border-b border-border/60 last:border-0">
                      <td className="py-3.5 pl-5 pr-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <img
                            src={p.image_url}
                            alt=""
                            loading="lazy"
                            className="h-12 w-12 rounded-md object-cover bg-secondary flex-shrink-0"
                            onError={e => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }}
                          />
                          {/* Bounded so a 200-character title cannot push the
                              numeric columns out of a 390px viewport. */}
                          <div className="min-w-0 max-w-[520px]">
                            <Link
                              href={productDetailPath(p.product_id)}
                              className="text-xs text-foreground hover:text-primary transition-colors line-clamp-2 leading-snug"
                              data-testid={`brand-product-${p.product_id}`}
                            >
                              {p.title || p.product_id}
                            </Link>
                            {p.niche_slug && (
                              <div className="text-[11px] text-muted-foreground font-mono">{p.niche_slug}</div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="py-3.5 px-3 text-right font-mono text-xs text-foreground whitespace-nowrap">
                        {p.sale_price != null && p.sale_price > 0 ? `$${p.sale_price.toFixed(2)}` : '—'}
                      </td>
                      <td className="py-3.5 px-3 text-right font-mono text-xs text-foreground whitespace-nowrap">
                        {formatViews(p.sold_count)}
                      </td>
                      <td
                        className={`py-3.5 px-5 text-right font-mono text-xs whitespace-nowrap ${
                          p.gmv30d ? 'text-foreground' : 'text-muted-foreground'
                        }`}
                      >
                        {formatGmv(p.gmv30d?.estRevenue)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Free is served the first 3 products by the API, and the total is
              stated honestly above — the upsell promises only what Pro delivers. */}
          {!isPaid && data.productsTotal > data.products.length ? (
            <button
              onClick={() => showPaywall('brand_profile_products')}
              className="w-full mb-6 rounded-lg border border-primary/30 bg-primary/5 hover:bg-primary/10 transition-colors px-6 py-5 flex items-center justify-center gap-3 cursor-pointer"
              data-testid="upsell-brand-products"
            >
              <Lock size={16} className="text-primary" />
              <span className="text-sm font-semibold text-foreground text-left">
                Unlock all {data.productsTotal.toLocaleString()} products from {name} and
                their modeled GMV
              </span>
            </button>
          ) : isPaid && totalPages > 1 ? (
            <div className="flex items-center justify-center gap-2 mb-6">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="h-9 px-3 rounded-md border border-border text-xs text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-30 disabled:pointer-events-none transition-colors"
                data-testid="brand-products-prev"
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
                data-testid="brand-products-next"
              >
                Next
              </button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
