import { useState, useEffect } from 'react';
import {
  NICHES,
  TIMEFRAMES,
  fetchTopVideos,
  formatViews,
  timeAgo,
  extractPostDate,
  type VideoWithProduct,
} from '@/lib/supabase';
import { useBookmarks } from '@/lib/bookmarks';
import { useSubscription } from '@/hooks/use-subscription';
import { Bookmark, ExternalLink, Eye, ShoppingBag, ChevronLeft, ChevronRight, Lock } from 'lucide-react';
import { LoadingBar } from '@/components/LoadingBar';
import { InfoTip } from '@/components/InfoTip';
import { OnboardingBanner } from '@/components/OnboardingBanner';

export default function VideosPage() {
  const [niche, setNiche] = useState(NICHES[0].slug);
  // Default to 2 Weeks always, upgrade to 1 Month once we confirm paid status
  const [timeframe, setTimeframe] = useState(TIMEFRAMES[1]); // "2 Weeks"
  const [videos, setVideos] = useState<VideoWithProduct[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const { isVideoBookmarked, toggleVideoBookmark } = useBookmarks();
  const { isPaid, showPaywall } = useSubscription();

  const limit = 50;
  const totalPages = Math.ceil(total / limit);

  // Free users get the real top 10 on the 1 Week window (server enforces
  // all/7d/top-10; align the UI so the active pill matches what's returned).
  useEffect(() => {
    if (!isPaid) {
      const oneWeek = TIMEFRAMES.find(t => t.label === '1 Week');
      if (oneWeek) setTimeframe(oneWeek);
    }
  }, [isPaid]);

  useEffect(() => {
    setPage(1);
  }, [niche, timeframe]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchTopVideos(niche, timeframe.days, page, limit)
      .then(res => {
        if (!cancelled) {
          setVideos(res.videos);
          setTotal(res.total);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [niche, timeframe, page]);

  // Pre-fetch the OTHER timeframes for snappier tab switching — but only after
  // the current view has loaded, and sequentially, so we don't fire 5 heavy
  // uncached computations at once and starve the foreground request. Disabled
  // while the current view is still loading.
  //
  // Pro only. The server pins a free caller to one window whatever is asked
  // for, so for them this was five more requests for the same ten rows on
  // every visit — read volume on a project that has already hit its cap once.
  useEffect(() => {
    if (loading || !isPaid) return;
    let cancelled = false;
    const others = TIMEFRAMES.filter(t => t.days !== timeframe.days);
    (async () => {
      for (const t of others) {
        if (cancelled) return;
        await fetchTopVideos(niche, t.days, 1, limit).catch(() => {});
      }
    })();
    return () => { cancelled = true; };
  }, [niche, loading, isPaid]);

  const nicheLabel = NICHES.find(n => n.slug === niche)?.label || niche;

  return (
    <div className="p-5 md:p-8" data-testid="videos-page">
      {/* First-run "how it works" strip (dismissible) */}
      <OnboardingBanner />

      {/* Header */}
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-foreground mb-1">Top Videos</h1>
        <p className="text-sm text-muted-foreground flex items-center gap-1.5">
          Trending TikTok Shop videos ranked by views
          <InfoTip size={13}>
            The most-viewed TikTok videos selling a product, within your chosen
            niche and timeframe. Use the filters below to narrow by category and
            recency; bookmark any video with the ☆ to save it.
          </InfoTip>
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-4 mb-8">
        {/* Niche dropdown */}
        <select
          value={niche}
          onChange={e => {
            if (!isPaid && e.target.value !== 'all') {
              e.target.value = 'all';
              showPaywall('category_filter');
              return;
            }
            setNiche(e.target.value);
          }}
          className="h-9 px-3 rounded-md text-sm font-medium border border-border bg-card text-foreground focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer"
          data-testid="niche-filter"
        >
          {NICHES.map(n => (
            <option key={n.slug} value={n.slug} disabled={!isPaid && n.slug !== 'all'}>
              {n.label}{!isPaid && n.slug !== 'all' ? ' (Pro)' : ''}
            </option>
          ))}
        </select>

        {/* Timeframe pills */}
        <div className="flex items-center gap-1 bg-card rounded-lg p-1 border border-border max-w-full overflow-x-auto [&>button]:flex-shrink-0">
          {TIMEFRAMES.map(tf => {
            const isLocked = !isPaid && tf.label !== '1 Week';
            return (
              <button
                key={tf.label}
                onClick={() => {
                  if (isLocked) { showPaywall('timeframe'); return; }
                  setTimeframe(tf);
                }}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  timeframe.label === tf.label
                    ? 'bg-primary text-primary-foreground'
                    : isLocked
                      ? 'text-zinc-600'
                      : 'text-muted-foreground hover:text-foreground'
                }`}
                data-testid={`timeframe-${tf.days}`}
              >
                {tf.label}
                {isLocked && <Lock size={8} className="inline ml-1 opacity-50" />}
              </button>
            );
          })}
        </div>

        {/* Result count */}
        <span className="text-xs text-muted-foreground font-mono ml-auto">
          {loading ? '...' : `${total.toLocaleString()} videos`}
        </span>
      </div>

      {loading && <LoadingBar loading={loading} />}

      {/* Video grid */}
      {!loading && videos.length === 0 && (
        <div className="flex flex-col items-center text-center py-20 px-6">
          <div className="w-11 h-11 rounded-full bg-secondary/60 flex items-center justify-center mb-3">
            <Eye size={20} className="text-muted-foreground" />
          </div>
          <p className="text-sm font-medium text-foreground mb-1">
            No videos for {nicheLabel} in this timeframe
          </p>
          <p className="text-xs text-muted-foreground max-w-xs">
            Nothing matched this niche and recency window. Try a longer timeframe
            or switch the niche to <span className="text-foreground">All</span> to see
            everything trending.
          </p>
        </div>
      )}

      {!loading && videos.length > 0 && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {videos.map((video, idx) => {
              const rank = (page - 1) * limit + idx + 1;
              const bookmarked = isVideoBookmarked(video.id);

              return (
                <div
                  key={video.id}
                  className="group rounded-lg border border-border bg-card overflow-hidden hover:border-primary/30 transition-colors"
                  data-testid={`video-card-${video.id}`}
                >
                  {/* Thumbnail */}
                  <div className="relative aspect-[9/16] max-h-[280px] overflow-hidden bg-muted">
                    {(() => {
                      // Try oEmbed thumbnail as a more reliable fallback
                      const videoId = video.video_url?.match(/video\/(\d+)/)?.[1];
                      const oembedThumb = videoId ? `https://www.tiktok.com/oembed?url=https://www.tiktok.com/@t/video/${videoId}` : null;
                      return (video.cover_image_url || videoId) ? (
                        <img
                          src={videoId ? `/api/thumb?vid=${videoId}` : (video.cover_image_url || '')}
                          alt=""
                          className="w-full h-full object-cover"
                          loading="lazy"
                          onError={(e) => {
                            const target = e.target as HTMLImageElement;
                            // On CDN failure, try fetching a fresh URL from oEmbed
                            if (oembedThumb && !target.dataset.retried) {
                              target.dataset.retried = '1';
                              fetch(oembedThumb).then(r => r.json()).then(d => {
                                if (d.thumbnail_url) { target.src = d.thumbnail_url; }
                                else { target.style.display = 'none'; const fb = target.nextElementSibling as HTMLElement; if (fb) fb.style.display = 'flex'; }
                              }).catch(() => { target.style.display = 'none'; const fb = target.nextElementSibling as HTMLElement; if (fb) fb.style.display = 'flex'; });
                            } else {
                              target.style.display = 'none';
                              const fallback = target.nextElementSibling as HTMLElement;
                              if (fallback) fallback.style.display = 'flex';
                            }
                          }}
                        />
                      ) : null;
                    })()}
                    <div
                      className="w-full h-full items-center justify-center bg-gradient-to-b from-zinc-800 to-zinc-900"
                      style={{ display: video.cover_image_url ? 'none' : 'flex' }}
                    >
                      <div className="text-center">
                        <div className="w-12 h-12 rounded-full bg-primary/20 flex items-center justify-center mx-auto mb-2">
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="hsl(var(--primary))" strokeWidth="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                        </div>
                        <span className="text-[10px] font-mono text-zinc-500">{formatViews(video.view_count || 0)} views</span>
                      </div>
                    </div>

                    {/* Rank badge */}
                    <div
                      className="absolute top-2 left-2 px-2 py-0.5 rounded font-mono text-xs font-bold bg-primary text-primary-foreground"
                    >
                      #{rank}
                    </div>

                    {/* View count overlay */}
                    <div className="absolute bottom-2 left-2 flex items-center gap-1 px-2 py-0.5 rounded bg-black/70 backdrop-blur-sm">
                      <Eye size={12} className="text-white/80" />
                      <span className="text-[11px] font-mono font-medium text-white">
                        {formatViews(video.view_count || 0)}
                      </span>
                    </div>

                    {/* Bookmark */}
                    <button
                      onClick={e => {
                        e.stopPropagation();
                        toggleVideoBookmark(video);
                      }}
                      className="absolute top-2 right-2 w-7 h-7 rounded-full flex items-center justify-center bg-black/50 backdrop-blur-sm hover:bg-black/70 transition-colors"
                      data-testid={`bookmark-video-${video.id}`}
                    >
                      <Bookmark
                        size={14}
                        className={bookmarked ? 'text-primary fill-primary' : 'text-white/70'}
                      />
                    </button>

                    {/* Video link */}
                    {video.video_url && (
                      <a
                        href={isPaid ? video.video_url : undefined}
                        onClick={e => { if (!isPaid) { e.preventDefault(); showPaywall('video_detail'); } }}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="absolute bottom-2 right-2 w-7 h-7 rounded-full flex items-center justify-center bg-black/50 backdrop-blur-sm hover:bg-black/70 transition-colors cursor-pointer"
                        data-testid={`link-video-${video.id}`}
                      >
                        <ExternalLink size={12} className="text-white/70" />
                      </a>
                    )}
                  </div>

                  {/* Video info */}
                  <div className="p-3">
                    <div className="flex items-center gap-2 mb-2">
                      {video.creator_key ? (
                        <img
                          src={`/api/avatar?key=${encodeURIComponent(video.creator_key)}`}
                          alt=""
                          loading="lazy"
                          className="w-6 h-6 rounded-full object-cover flex-shrink-0 bg-muted"
                        />
                      ) : (
                        <div className="w-6 h-6 rounded-full bg-muted flex-shrink-0" />
                      )}
                      <span className="text-xs font-medium text-foreground truncate">
                        {video.author_name || 'Unknown'}
                      </span>
                      <span className="text-[10px] text-muted-foreground ml-auto flex-shrink-0">
                        {(() => {
                          const postDate = extractPostDate(video.video_url);
                          return postDate ? timeAgo(postDate.toISOString()) : timeAgo(video.created_at);
                        })()}
                      </span>
                    </div>

                    {/* Product Card */}
                    {video.product && (
                      <div className="mt-2 rounded-lg border border-border bg-zinc-900/50 overflow-hidden">
                        <div className="flex items-center gap-3 p-2.5">
                          <div className="w-16 h-16 rounded-md flex-shrink-0 border border-border overflow-hidden bg-zinc-800">
                            <img
                              src={video.product.image_url || video.cover_image_url || ''}
                              alt=""
                              className="w-full h-full object-cover"
                              onError={(e) => {
                                const img = e.target as HTMLImageElement;
                                // If product image fails, try video thumbnail
                                if (img.src !== (video.cover_image_url || '') && video.cover_image_url) {
                                  img.src = video.cover_image_url;
                                } else {
                                  img.style.display = 'none';
                                }
                              }}
                            />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-xs text-foreground font-medium leading-snug line-clamp-2">
                              {video.product.title}
                            </p>
                            <span className="inline-block mt-1 text-[10px] font-mono font-semibold text-primary-bright bg-primary/10 px-1.5 py-0.5 rounded">
                              {(video.product.sold_count || 0).toLocaleString()} sold
                            </span>
                          </div>
                        </div>
                        {video.product.product_url && (
                          <a
                            href={isPaid ? video.product.product_url : undefined}
                            onClick={e => { if (!isPaid) { e.preventDefault(); showPaywall('product_detail'); } }}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center justify-center gap-1.5 py-2 border-t border-border text-[11px] font-medium text-primary hover:bg-primary/5 transition-colors cursor-pointer"
                          >
                            <ExternalLink size={11} />
                            View Product
                          </a>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Free tier sees the real top 10, then one upsell to the full list.
              Paid tier keeps normal pagination. */}
          {!isPaid ? (
            <button
              onClick={() => showPaywall('top_videos')}
              className="w-full mt-8 mb-4 rounded-lg border border-primary/30 bg-primary/5 hover:bg-primary/10 transition-colors px-6 py-5 flex items-center justify-center gap-3 cursor-pointer"
              data-testid="upsell-videos"
            >
              <Lock size={16} className="text-primary" />
              <span className="text-sm font-semibold text-foreground">
                Unlock {Math.max(0, total - videos.length).toLocaleString()}+ more videos — see everything trending right now
              </span>
            </button>
          ) : totalPages > 1 ? (
            <div className="flex items-center justify-center gap-2 mt-8 mb-4">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="h-9 w-9 rounded-md border border-border flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-30 disabled:pointer-events-none transition-colors"
                data-testid="page-prev"
              >
                <ChevronLeft size={16} />
              </button>
              <span className="text-sm font-mono text-muted-foreground px-3">
                {page} / {totalPages}
              </span>
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="h-9 w-9 rounded-md border border-border flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-30 disabled:pointer-events-none transition-colors"
                data-testid="page-next"
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
