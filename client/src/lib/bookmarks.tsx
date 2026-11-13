import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';
import type { VideoWithProduct, Product } from './supabase';
import { isVideoSaved, toggleSavedVideo } from './video-key';

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

// localStorage may be unavailable (e.g. sandboxed iframe hosts); degrade
// gracefully so bookmarks persist where possible and never throw where not.
function loadSaved<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function persistSaved<T>(key: string, value: T[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage blocked — keep in-memory only */
  }
}

export function BookmarkProvider({ children }: { children: ReactNode }) {
  const [savedVideos, setSavedVideos] = useState<VideoWithProduct[]>(() =>
    loadSaved<VideoWithProduct>(VIDEOS_KEY)
  );
  const [savedProducts, setSavedProducts] = useState<Product[]>(() =>
    loadSaved<Product>(PRODUCTS_KEY)
  );

  useEffect(() => {
    persistSaved(VIDEOS_KEY, savedVideos);
  }, [savedVideos]);

  useEffect(() => {
    persistSaved(PRODUCTS_KEY, savedProducts);
  }, [savedProducts]);

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
