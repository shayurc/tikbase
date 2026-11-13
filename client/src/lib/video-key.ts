/**
 * The identity of a video row.
 *
 * Bookmarks compared `video.id`, and the rows from /api/top-videos have never
 * had an `id` (see the object built in api/top-videos.ts) — the type said
 * `id: number`, the data said `undefined`. So every comparison was
 * `undefined === undefined`: saving one video lit the bookmark on all of them,
 * and saving a second removed everything, because "already saved" matched and
 * the filter that followed dropped every row.
 *
 * The TikTok video id in the URL is the one thing every row carries and no two
 * videos share, so that is the key. No React here, so this runs under node:test.
 */

export interface VideoIdentity {
  video_url?: string | null;
  id?: number | string | null;
}

export function videoKey(video: VideoIdentity): string {
  const match = /\/video\/(\d+)/.exec(video.video_url ?? '');
  if (match) return match[1];
  // A row with a real database id (older saved payloads) keeps working.
  if (video.id !== undefined && video.id !== null) return `row:${video.id}`;
  return `url:${video.video_url ?? ''}`;
}

export function isVideoSaved<T extends VideoIdentity>(saved: T[], video: VideoIdentity): boolean {
  const key = videoKey(video);
  return saved.some((v) => videoKey(v) === key);
}

/** Saved -> removed, not saved -> appended. Never touches any other row. */
export function toggleSavedVideo<T extends VideoIdentity>(saved: T[], video: T): T[] {
  const key = videoKey(video);
  return saved.some((v) => videoKey(v) === key)
    ? saved.filter((v) => videoKey(v) !== key)
    : [...saved, video];
}
