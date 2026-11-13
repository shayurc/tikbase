import { useState } from 'react';
import { useBookmarks } from '@/lib/bookmarks';
import { formatViews, timeAgo } from '@/lib/supabase';
import { videoKey } from '@/lib/video-key';
import { Bookmark, Eye, ExternalLink, ShoppingBag, Trash2 } from 'lucide-react';

export default function SavedPage() {
  const [tab, setTab] = useState<'videos' | 'products'>('videos');
  const {
    savedVideos,
    savedProducts,
    toggleVideoBookmark,
    toggleProductBookmark,
  } = useBookmarks();

  return (
    <div className="p-5 md:p-8" data-testid="saved-page">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-foreground mb-1">Saved</h1>
        <p className="text-sm text-muted-foreground">
          Your bookmarked videos and products
        </p>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 bg-card rounded-lg p-1 border border-border w-fit mb-6">
        <button
          onClick={() => setTab('videos')}
          className={`px-4 py-1.5 rounded-md text-xs font-medium transition-colors ${
            tab === 'videos'
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:text-foreground'
          }`}
          data-testid="tab-videos"
        >
          Videos ({savedVideos.length})
        </button>
        <button
          onClick={() => setTab('products')}
          className={`px-4 py-1.5 rounded-md text-xs font-medium transition-colors ${
            tab === 'products'
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:text-foreground'
          }`}
          data-testid="tab-products"
        >
          Products ({savedProducts.length})
        </button>
      </div>

      {/* Videos Tab */}
      {tab === 'videos' && (
        <>
          {savedVideos.length === 0 ? (
            <div className="text-center py-20">
              <Bookmark size={32} className="mx-auto text-muted-foreground/30 mb-3" />
              <p className="text-sm text-muted-foreground">No saved videos yet.</p>
              <p className="text-xs text-muted-foreground/70 mt-1">
                Bookmark videos from the Videos page to see them here.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {savedVideos.map(video => {
                const vKey = videoKey(video);
                // The saved cover_image_url is a signed CDN link that 403s
                // within a day, so a video saved yesterday showed a broken
                // image. /api/thumb serves stored bytes by video id, the same
                // way the Videos page does.
                const tiktokId = /^\d+$/.test(vKey) ? vKey : null;
                return (
                <div
                  key={vKey}
                  className="rounded-lg border border-border bg-card overflow-hidden"
                  data-testid={`saved-video-${vKey}`}
                >
                  <div className="relative aspect-[9/16] max-h-[260px] overflow-hidden bg-muted">
                    {tiktokId || video.cover_image_url ? (
                      <img
                        src={tiktokId ? `/api/thumb?vid=${tiktokId}` : video.cover_image_url}
                        alt=""
                        loading="lazy"
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-muted-foreground text-xs">
                        No thumbnail
                      </div>
                    )}
                    <div className="absolute bottom-2 left-2 flex items-center gap-1 px-2 py-0.5 rounded bg-black/70">
                      <Eye size={12} className="text-white/80" />
                      <span className="text-[11px] font-mono font-medium text-white">
                        {formatViews(video.view_count || 0)}
                      </span>
                    </div>
                    <button
                      onClick={() => toggleVideoBookmark(video)}
                      className="absolute top-2 right-2 w-7 h-7 rounded-full flex items-center justify-center bg-black/50 hover:bg-red-500/80 transition-colors"
                      aria-label="Remove saved video"
                      data-testid={`remove-video-${vKey}`}
                    >
                      <Trash2 size={12} className="text-white" />
                    </button>
                  </div>
                  <div className="p-3">
                    <div className="flex items-center gap-2 mb-2">
                      {video.creator_key ? (
                        <img
                          src={`/api/avatar?key=${encodeURIComponent(video.creator_key)}`}
                          alt=""
                          loading="lazy"
                          className="w-5 h-5 rounded-full object-cover bg-muted"
                        />
                      ) : (
                        <div className="w-5 h-5 rounded-full bg-muted" />
                      )}
                      <span className="text-xs font-medium text-foreground truncate">
                        {video.author_name || 'Unknown'}
                      </span>
                      <span className="text-[10px] text-muted-foreground ml-auto">
                        {timeAgo(video.created_at)}
                      </span>
                    </div>
                    {video.product && (
                      <div className="pt-2 border-t border-border">
                        <div className="flex items-center gap-1 mb-1">
                          <ShoppingBag size={10} className="text-primary" />
                          <span className="text-[10px] font-mono font-semibold tracking-wider text-primary uppercase">
                            Product
                          </span>
                        </div>
                        <p className="text-xs text-foreground line-clamp-1">
                          {video.product.title}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* Products Tab */}
      {tab === 'products' && (
        <>
          {savedProducts.length === 0 ? (
            <div className="text-center py-20">
              <Bookmark size={32} className="mx-auto text-muted-foreground/30 mb-3" />
              <p className="text-sm text-muted-foreground">No saved products yet.</p>
              <p className="text-xs text-muted-foreground/70 mt-1">
                Bookmark products from the Products page to see them here.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {savedProducts.map(product => (
                <div
                  key={product.product_id}
                  className="flex items-center gap-4 p-3 rounded-lg border border-border bg-card"
                  data-testid={`saved-product-${product.product_id}`}
                >
                  {/* Proxied: a bookmark can outlive the signed CDN URL that
                      was captured with it by months. */}
                  <img
                    src={`/api/thumb?product_id=${encodeURIComponent(product.product_id)}`}
                    alt=""
                    className="w-12 h-12 rounded object-cover border border-border bg-muted"
                    onError={e => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground line-clamp-1">
                      {product.title}
                    </p>
                    <div className="flex items-center gap-3 mt-1">
                      <span className="text-xs font-mono text-muted-foreground">
                        {(product.sold_count || 0).toLocaleString()} sold
                      </span>
                      <span className="text-xs font-mono text-primary">
                        ${(product.sale_price || 0).toFixed(2)}
                      </span>
                    </div>
                  </div>
                  {product.product_url && (
                    <a
                      href={product.product_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="w-8 h-8 rounded flex items-center justify-center hover:bg-secondary transition-colors"
                    >
                      <ExternalLink size={14} className="text-muted-foreground" />
                    </a>
                  )}
                  <button
                    onClick={() => toggleProductBookmark(product)}
                    className="w-8 h-8 rounded flex items-center justify-center hover:bg-red-500/20 transition-colors"
                    data-testid={`remove-product-${product.product_id}`}
                  >
                    <Trash2 size={14} className="text-muted-foreground hover:text-red-400" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
