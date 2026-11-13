import { useState, useEffect, Fragment } from 'react';
import { Link } from 'wouter';
import { NICHES, formatViews, authHeader, cacheScope } from '@/lib/supabase';
import { InfoTip } from '@/components/InfoTip';
import { creatorProfilePath } from '@/components/CreatorSearch';
import { useSubscription } from '@/hooks/use-subscription';
import {
  ChevronLeft, ChevronRight, ChevronDown, ChevronUp,
  Lock, Users, CalendarClock, AlertCircle,
} from 'lucide-react';
import { LoadingBar } from '@/components/LoadingBar';

interface CreatorMetrics {
  attributedGmv: number;
  gmvConfidence: number;
  videosPosted: number;
  distinctProducts: number;
  viewsOnWindowVideos: number;
  affiliateIntensity: number;
  dominantNiche: string | null;
}
interface CreatorTopProduct {
  product_id: string;
  title: string | null;
  niche_slug: string | null;
  videos: number;
  views: number;
}
interface Creator {
  creator_key: string;
  display_name: string | null;
  avatar_url: string | null;
  handle: string | null;
  author_id: string | null;
  metrics: CreatorMetrics;
  topProducts: CreatorTopProduct[];
}

// Only the two windows precompute-creators.ts writes.
const WINDOWS = [
  { label: '7 Days', days: 7 },
  { label: '30 Days', days: 30 },
];

const creatorCache = new Map<string, { data: any; timestamp: number }>();
const CREATOR_CACHE_TTL = 30 * 60 * 1000;

type FetchResult = {
  creators: Creator[];
  total: number;        // rows this endpoint can serve (drives pagination + upsell)
  creatorCount: number; // true number ranked, >= total
  computedAt: string | null;
  notComputed: boolean;
};

async function fetchCreators(
  niche: string, days: number, page: number, limit: number,
): Promise<FetchResult> {
  // Scoped to the account: see cacheScope in lib/supabase.ts.
  const cacheKey = `${await cacheScope()}:${niche}:${days}:${page}:${limit}`;
  const cached = creatorCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CREATOR_CACHE_TTL) return cached.data;

  const params = new URLSearchParams({
    niche, days: String(days), page: String(page), limit: String(limit),
  });
  const res = await fetch(`/api/top-creators?${params}`, { headers: await authHeader() });

  // 503 is the designed "nightly job hasn't run for this slice yet" state, not
  // an error — the page renders it as a friendly wait message.
  if (res.status === 503) {
    return { creators: [], total: 0, creatorCount: 0, computedAt: null, notComputed: true };
  }
  if (!res.ok) throw new Error('Failed to fetch creators');

  const data = await res.json();
  const result: FetchResult = {
    creators: data.creators || [],
    total: data.total || 0,
    creatorCount: data.creatorCount || data.total || 0,
    computedAt: data.computedAt ?? null,
    notComputed: false,
  };
  creatorCache.set(cacheKey, { data: result, timestamp: Date.now() });
  return result;
}

// GMV is modelled from ranked products only. A creator whose promoted products
// are all unranked genuinely has no figure — render an em dash rather than
// "$0", which would read as "sold nothing".
function formatGmv(n: number): string {
  if (!(n > 0)) return '—';
  if (n >= 1_000_000) return '$' + (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return '$' + (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return '$' + n.toFixed(0);
}

const CONFIDENCE_TITLE =
  'Share of modeled GMV from measured sales deltas. ' +
  'Higher means more of this figure is backed by real day-over-day sales rather than estimates.';

// Amber confidence dot. Filled proportionally to how much of the modelled GMV
// is backed by measured deltas: hollow at 0, solid at 1.
function ConfidenceDot({ value, hasGmv }: { value: number; hasGmv: boolean }) {
  if (!hasGmv) return <span className="text-muted-foreground">—</span>;
  const pct = Math.round(value * 100);
  // Same vocabulary as the products table's dot, which was not true before:
  // there, accent = measured and amber = modelled, while this ramp was amber
  // at every level — so a 100%-measured creator and a 0% one differed only in
  // shade, and a fully measured creator looked modelled next to a product that
  // did not. Above two thirds measured now reads as the accent.
  const tone =
    value >= 0.66 ? 'bg-primary' : value >= 0.33 ? 'bg-warning/70' : 'bg-warning/30';
  return (
    <span
      className="inline-flex items-center gap-1.5 cursor-help"
      title={`${CONFIDENCE_TITLE} This creator: ${pct}%.`}
    >
      <span
        className={`inline-block h-2 w-2 rounded-full ${tone} ${
          value === 0 ? 'ring-1 ring-inset ring-warning/50' : ''
        }`}
      />
      <span className="font-mono text-xs text-muted-foreground">{pct}%</span>
    </span>
  );
}

function CreatorIdentity({ c }: { c: Creator }) {
  const name = c.display_name || c.handle || c.creator_key;
  return (
    <div className="flex items-center gap-2.5 min-w-0">
      {/* Through the cache-through proxy, not the raw CDN URL: TikTok avatar
          links are signed and 403 once the signature expires (~a day), which
          left the leaderboard full of blank circles. /api/avatar stores the
          bytes once per creator and always renders something. */}
      <img
        src={`/api/avatar?key=${encodeURIComponent(c.creator_key)}`}
        alt=""
        loading="lazy"
        className="h-11 w-11 rounded-full object-cover bg-secondary flex-shrink-0"
      />
      <div className="min-w-0">
        {/* stopPropagation: the row's own click toggles the inline product
            panel, and a click on the name must navigate instead of doing both.
            Numeric-key creators get a profile too — the key is the identity. */}
        <Link
          href={creatorProfilePath(c.creator_key)}
          onClick={e => e.stopPropagation()}
          className="text-sm font-medium text-foreground truncate hover:text-primary transition-colors block"
          data-testid={`creator-link-${c.creator_key}`}
        >
          {name}
        </Link>
        {/* Numeric-key creators have no handle — show the display name only
            rather than inventing an @id: label. */}
        {c.handle && (
          <div className="text-[11px] text-muted-foreground font-mono truncate">@{c.handle}</div>
        )}
      </div>
    </div>
  );
}

export default function CreatorsPage() {
  const { isPaid, showPaywall } = useSubscription();
  const [niche, setNiche] = useState(NICHES[0].slug);
  const [window, setWindow] = useState(WINDOWS[1]); // 30 Days
  const [creators, setCreators] = useState<Creator[]>([]);
  const [total, setTotal] = useState(0);
  const [creatorCount, setCreatorCount] = useState(0);
  const [computedAt, setComputedAt] = useState<string | null>(null);
  const [notComputed, setNotComputed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);

  const limit = 50;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  // Free tier is pinned server-side to all/30d; keep the controls in sync so the
  // UI never claims a filter the response does not honour.
  useEffect(() => {
    if (!isPaid) {
      setNiche('all');
      setWindow(WINDOWS[1]);
      setPage(1);
    }
  }, [isPaid]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    fetchCreators(niche, window.days, page, limit)
      .then(r => {
        if (cancelled) return;
        setCreators(r.creators);
        setTotal(r.total);
        setCreatorCount(r.creatorCount);
        setComputedAt(r.computedAt);
        setNotComputed(r.notComputed);
      })
      .catch(() => { if (!cancelled) setError(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [niche, window.days, page]);

  const lockedNiche = (slug: string) => !isPaid && slug !== 'all';

  return (
    <div className="p-5 md:p-8 max-w-[1400px] mx-auto">
      <div className="mb-1 flex items-center gap-2">
        <h1 className="text-xl font-semibold text-foreground">Top Affiliates</h1>
        <InfoTip size={12}>
          Creators ranked by <span className="font-semibold text-foreground">modeled GMV</span> —
          each product's estimated revenue for the window, split across the creators who
          posted about it in proportion to their share of views on that product's window
          videos. It is an attribution model, not measured payouts.
        </InfoTip>
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        Ranked by estimated sales influence across TikTok Shop products.
      </p>


      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <select
          value={niche}
          onChange={e => {
            if (lockedNiche(e.target.value)) {
              e.target.value = 'all';
              showPaywall('creator_category_filter');
              return;
            }
            setPage(1);
            setNiche(e.target.value);
          }}
          className="h-9 px-3 rounded-md text-sm font-medium border border-border bg-card text-foreground focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer"
          data-testid="creators-niche"
        >
          {NICHES.map(n => (
            <option key={n.slug} value={n.slug} disabled={lockedNiche(n.slug)}>
              {n.label}{lockedNiche(n.slug) ? ' (Pro)' : ''}
            </option>
          ))}
        </select>

        <div className="flex items-center gap-1 bg-card rounded-lg p-1 border border-border max-w-full overflow-x-auto [&>button]:flex-shrink-0">
          {WINDOWS.map(w => {
            const isLocked = !isPaid && w.days !== 30;
            return (
              <button
                key={w.label}
                onClick={() => {
                  if (isLocked) { showPaywall('creator_timeframe'); return; }
                  setPage(1);
                  setWindow(w);
                }}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  window.label === w.label
                    ? 'bg-primary text-primary-foreground'
                    : isLocked
                      ? 'text-zinc-600'
                      : 'text-muted-foreground hover:text-foreground'
                }`}
                data-testid={`creators-window-${w.days}`}
              >
                {w.label}
                {isLocked && <Lock size={8} className="inline ml-1 opacity-50" />}
              </button>
            );
          })}
        </div>

        <span className="text-xs text-muted-foreground font-mono ml-auto">
          {loading ? '...' : `${creatorCount.toLocaleString()} creators ranked`}
        </span>
      </div>

      {/* Modelling disclosure — this page's headline number is an estimate and
          must never read as measured payouts. */}
      <div className="flex items-start gap-2 mb-4 px-3 py-2 rounded-md bg-zinc-900/60 border border-zinc-800 text-[11px] text-zinc-400">
        <AlertCircle size={13} className="text-zinc-500 flex-shrink-0 mt-0.5" />
        <span>
          <span className="text-zinc-300">Est. GMV is modeled</span>, not measured payouts:
          product revenue is split across creators by their share of views on that product's
          videos posted in the window. Only products ranked in this niche contribute, so
          creators promoting unranked products show “—”. Views are lifetime counts on
          videos posted in the window.
          {computedAt && (
            <> Last computed{' '}
              <span className="font-mono text-zinc-300">
                {new Date(computedAt).toISOString().slice(0, 16).replace('T', ' ')}Z
              </span>.
            </>
          )}
        </span>
      </div>

      {loading && <LoadingBar loading={loading} />}

      {/* 503 — the nightly aggregation has not written this slice yet. */}
      {!loading && notComputed && (
        <div className="flex flex-col items-center text-center py-20 px-6" data-testid="creators-empty">
          <div className="w-11 h-11 rounded-full bg-secondary/60 flex items-center justify-center mb-3">
            <CalendarClock size={20} className="text-muted-foreground" />
          </div>
          <p className="text-sm font-medium text-foreground mb-1">
            First leaderboard computes tonight
          </p>
          <p className="text-xs text-muted-foreground max-w-sm">
            Affiliate rankings are built once a day from the full video history. This
            niche and timeframe hasn't been computed yet — check back after tonight's run.
          </p>
        </div>
      )}

      {!loading && error && (
        <div className="flex flex-col items-center text-center py-20 px-6" data-testid="creators-error">
          <div className="w-11 h-11 rounded-full bg-secondary/60 flex items-center justify-center mb-3">
            <AlertCircle size={20} className="text-muted-foreground" />
          </div>
          <p className="text-sm font-medium text-foreground mb-1">Couldn't load the leaderboard</p>
          <p className="text-xs text-muted-foreground max-w-xs">
            Something went wrong fetching creators. Try switching niche or reloading.
          </p>
        </div>
      )}

      {!loading && !error && !notComputed && total === 0 && (
        <div className="flex flex-col items-center text-center py-20 px-6">
          <div className="w-11 h-11 rounded-full bg-secondary/60 flex items-center justify-center mb-3">
            <Users size={20} className="text-muted-foreground" />
          </div>
          <p className="text-sm font-medium text-foreground mb-1">No creators in this view yet</p>
          <p className="text-xs text-muted-foreground max-w-xs">
            No creators posted about products in this niche and timeframe. Try a longer
            window or switch niche to <span className="text-foreground">All Categories</span>.
          </p>
        </div>
      )}

      {!loading && !error && !notComputed && creators.length > 0 && (
        <>
          {/* MOBILE — same reflow as the products table, same reason: nine
              numeric columns cannot survive 390px. Headline is the modelled
              GMV with its confidence dot; the rest sits underneath. Tapping
              opens the creator's profile rather than the inline panel, which
              needs a table row to expand into. */}
          <div className="md:hidden space-y-3">
            {creators.map((c, i) => {
              const rank = (page - 1) * limit + i + 1;
              const hasGmv = c.metrics.attributedGmv > 0;
              const name = c.display_name || c.handle || c.creator_key;
              return (
                <Link
                  key={c.creator_key}
                  href={creatorProfilePath(c.creator_key)}
                  className="block rounded-lg border border-border bg-card p-4 no-underline active:bg-secondary/30 transition-colors"
                  data-testid={`creator-card-${rank}`}
                >
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-[11px] text-muted-foreground w-5 flex-shrink-0">{rank}</span>
                    <img
                      src={`/api/avatar?key=${encodeURIComponent(c.creator_key)}`}
                      alt=""
                      loading="lazy"
                      className="h-12 w-12 rounded-full object-cover bg-secondary flex-shrink-0"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-foreground truncate">{name}</p>
                      {c.handle && (
                        <p className="text-[11px] text-muted-foreground font-mono truncate">@{c.handle}</p>
                      )}
                    </div>
                    <div className="text-right flex-shrink-0">
                      <div className="flex items-center justify-end gap-1.5">
                        <ConfidenceDot value={c.metrics.gmvConfidence} hasGmv={hasGmv} />
                        <span className="font-mono text-base font-semibold text-foreground">
                          {formatGmv(c.metrics.attributedGmv)}
                        </span>
                      </div>
                      <p className="text-[10px] uppercase tracking-wide text-muted-foreground mt-0.5">Est. GMV</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 mt-3.5 pt-3 border-t border-border/60 text-[11px]">
                    <span className="text-muted-foreground">
                      Videos <span className="font-mono text-foreground ml-0.5">{c.metrics.videosPosted.toLocaleString()}</span>
                    </span>
                    <span className="text-muted-foreground">
                      Products <span className="font-mono text-foreground ml-0.5">{c.metrics.distinctProducts.toLocaleString()}</span>
                    </span>
                    <span className="text-muted-foreground">
                      Views <span className="font-mono text-foreground ml-0.5">{formatViews(c.metrics.viewsOnWindowVideos)}</span>
                    </span>
                  </div>
                </Link>
              );
            })}
          </div>

          <div className="hidden md:block rounded-lg border border-border overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-card/50 text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="text-left font-medium py-3 pl-5 pr-3 w-12">#</th>
                  <th className="text-left font-medium py-3 px-3 min-w-[200px]">Creator</th>
                  <th className="text-right font-medium py-3 px-3 whitespace-nowrap">Videos</th>
                  <th className="text-right font-medium py-3 px-3 whitespace-nowrap">Products</th>
                  <th className="text-right font-medium py-3 px-3 whitespace-nowrap">Views</th>
                  <th className="text-right font-medium py-3 px-3 whitespace-nowrap">Affiliate&nbsp;%</th>
                  <th className="text-right font-medium py-3 px-3 whitespace-nowrap">
                    Est. GMV (modeled)
                  </th>
                  <th className="text-right font-medium py-3 px-3 whitespace-nowrap">
                    <span title={CONFIDENCE_TITLE} className="cursor-help">Confidence</span>
                  </th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {creators.map((c, i) => {
                  const rank = (page - 1) * limit + i + 1;
                  const isOpen = expanded === c.creator_key;
                  const hasGmv = c.metrics.attributedGmv > 0;
                  return (
                    <Fragment key={c.creator_key}>
                    <tr
                      className="border-b border-border/60 last:border-0 hover:bg-secondary/30 transition-colors cursor-pointer align-middle"
                      onClick={() => setExpanded(isOpen ? null : c.creator_key)}
                      data-testid={`creator-row-${rank}`}
                    >
                      <td className="py-3.5 pl-5 pr-3 font-mono text-xs text-muted-foreground">
                        {rank}
                      </td>
                      <td className="py-3.5 px-3"><CreatorIdentity c={c} /></td>
                      <td className="py-3.5 px-3 text-right font-mono text-xs text-foreground">
                        {c.metrics.videosPosted.toLocaleString()}
                      </td>
                      <td className="py-3.5 px-3 text-right font-mono text-xs text-foreground">
                        {c.metrics.distinctProducts.toLocaleString()}
                      </td>
                      <td className="py-3.5 px-3 text-right font-mono text-xs text-foreground">
                        {formatViews(c.metrics.viewsOnWindowVideos)}
                      </td>
                      <td className="py-3.5 px-3 text-right font-mono text-xs text-muted-foreground">
                        {Math.round(c.metrics.affiliateIntensity * 100)}%
                      </td>
                      <td className="py-3.5 px-3 text-right font-mono text-xs font-semibold text-foreground">
                        {formatGmv(c.metrics.attributedGmv)}
                      </td>
                      <td className="py-3.5 px-3 text-right">
                        <ConfidenceDot value={c.metrics.gmvConfidence} hasGmv={hasGmv} />
                      </td>
                      <td className="py-3.5 pr-4 text-muted-foreground">
                        {isOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                      </td>
                    </tr>
                    {/* Panel is emitted immediately after its own row so it
                        opens inline, not at the bottom of the table body. */}
                    {isOpen && (
                    <tr className="border-b border-border/60 bg-secondary/20">
                      <td colSpan={9} className="px-4 py-3">
                        <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-2">
                          Top products this window
                        </div>
                        {c.topProducts.length === 0 ? (
                          <div className="text-xs text-muted-foreground">No products recorded.</div>
                        ) : (
                          <div className="flex flex-col gap-2">
                            {c.topProducts.map(p => (
                              <div key={p.product_id} className="flex items-center gap-3 min-w-0">
                                <img
                                  src={`/api/thumb?product_id=${encodeURIComponent(p.product_id)}`}
                                  alt=""
                                  loading="lazy"
                                  className="h-10 w-10 rounded object-cover bg-secondary flex-shrink-0"
                                  onError={e => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }}
                                />
                                <div className="min-w-0 flex-1">
                                  <div className="text-xs text-foreground truncate">
                                    {p.title || p.product_id}
                                  </div>
                                  <div className="text-[11px] text-muted-foreground font-mono">
                                    {p.videos} video{p.videos === 1 ? '' : 's'} · {formatViews(p.views)} views
                                    {p.niche_slug ? ` · ${p.niche_slug}` : ''}
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                    )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Free tier sees the real top 5, then one upsell to the full list.
              Paid tier keeps normal pagination. */}
          {!isPaid ? (
            <button
              onClick={() => showPaywall('top_creators')}
              className="w-full mt-4 mb-4 rounded-lg border border-primary/30 bg-primary/5 hover:bg-primary/10 transition-colors px-6 py-5 flex items-center justify-center gap-3 cursor-pointer"
              data-testid="upsell-creators"
            >
              <Lock size={16} className="text-primary" />
              <span className="text-sm font-semibold text-foreground">
                Unlock {Math.max(0, total - creators.length).toLocaleString()} more ranked affiliates —
                see who's really driving sales
              </span>
            </button>
          ) : totalPages > 1 ? (
            <div className="flex items-center justify-center gap-2 mt-6 mb-4">
              <button
                aria-label="Previous page"
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="h-9 w-9 rounded-md border border-border flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-30 disabled:pointer-events-none transition-colors"
              >
                <ChevronLeft size={16} />
              </button>
              <span className="text-sm font-mono text-muted-foreground px-3">
                {page} / {totalPages}
              </span>
              <button
                aria-label="Next page"
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="h-9 w-9 rounded-md border border-border flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-30 disabled:pointer-events-none transition-colors"
              >
                <ChevronRight size={16} />
              </button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
