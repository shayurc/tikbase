import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';
import type { VideoWithProduct, Product } from './supabase';
import { isVideoSaved, toggleSavedVideo } from './video-key';
import { useAuth } from './auth';
import { loadScoped, saveScoped, type KeyValueStore } from './bookmark-store';

interface BookmarkState {
  savedVideos: VideoWithProduct[];
  savedProducts: Product[];
  /** Takes the row, not an id: video rows have no id. See lib/video-key.ts. */
  isVideoBookmarked: (video: VideoWithProduct) => boolean;
  isProductBookmarked: (productId: string) => boolean;
  toggleVideoBookmark: (video: VideoWithProduct) => void;
  toggleProductBookmark: (product: Product) => void;
}

const BookmarkContext = createContext<BookmarkState | null>(null);

const VIDEOS_KEY = 'tikbase:savedVideos';
const PRODUCTS_KEY = 'tikbase:savedProducts';
const EMPTY_VIDEOS: VideoWithProduct[] = [];
const EMPTY_PRODUCTS: Product[] = [];

/** Never throws: a browser with storage blocked gets in-memory bookmarks. */
function browserStore(): KeyValueStore {
  return {
    getItem: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    setItem: (k, v) => { try { localStorage.setItem(k, v); } catch { /* blocked */ } },
    removeItem: (k) => { try { localStorage.removeItem(k); } catch { /* blocked */ } },
  };
}

export function BookmarkProvider({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  // null until auth has settled: loading someone's list before we know who is
  // signed in is how one account ends up looking at another's.
  const scope = loading ? null : (user?.id ?? 'anon');

  const [saved, setSaved] = useState<{
    scope: string | null;
    videos: VideoWithProduct[];
    products: Product[];
  }>({ scope: null, videos: [], products: [] });

  useEffect(() => {
    if (scope === null) return;
    const store = browserStore();
    setSaved({
      scope,
      videos: loadScoped<VideoWithProduct>(store, VIDEOS_KEY, scope),
      products: loadScoped<Product>(store, PRODUCTS_KEY, scope),
    });
  }, [scope]);

  useEffect(() => {
    // Only ever write a list back under the account it was loaded for. Between
    // a sign-out and the next load, `saved` still holds the previous account's.
    if (saved.scope === null || saved.scope !== scope) return;
    const store = browserStore();
    saveScoped(store, VIDEOS_KEY, saved.scope, saved.videos);
    saveScoped(store, PRODUCTS_KEY, saved.scope, saved.products);
  }, [saved, scope]);

  // What the rest of the app sees: nothing, until this account's list is loaded.
  const current = saved.scope !== null && saved.scope === scope;
  const savedVideos = current ? saved.videos : EMPTY_VIDEOS;
  const savedProducts = current ? saved.products : EMPTY_PRODUCTS;
  const setSavedVideos = useCallback(
    (update: (prev: VideoWithProduct[]) => VideoWithProduct[]) =>
      setSaved((s) => ({ ...s, videos: update(s.videos) })),
    [],
  );
  const setSavedProducts = useCallback(
    (update: (prev: Product[]) => Product[]) =>
      setSaved((s) => ({ ...s, products: update(s.products) })),
    [],
  );

  const isVideoBookmarked = useCallback(
    (video: VideoWithProduct) => isVideoSaved(savedVideos, video),
    [savedVideos]
  );

  const isProductBookmarked = useCallback(
    (productId: string) => savedProducts.some(p => p.product_id === productId),
    [savedProducts]
  );

  const toggleVideoBookmark = useCallback((video: VideoWithProduct) => {
    setSavedVideos(prev => toggleSavedVideo(prev, video));
  }, []);

  const toggleProductBookmark = useCallback((product: Product) => {
    setSavedProducts(prev => {
      const exists = prev.some(p => p.product_id === product.product_id);
      if (exists) return prev.filter(p => p.product_id !== product.product_id);
      return [...prev, product];
    });
  }, []);

  return (
    <BookmarkContext.Provider
      value={{
        savedVideos,
        savedProducts,
        isVideoBookmarked,
        isProductBookmarked,
        toggleVideoBookmark,
        toggleProductBookmark,
      }}
    >
      {children}
    </BookmarkContext.Provider>
  );
}

export function useBookmarks() {
  const ctx = useContext(BookmarkContext);
  if (!ctx) throw new Error('useBookmarks must be used within BookmarkProvider');
  return ctx;
}
