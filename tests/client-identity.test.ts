/**
 * Two small pure helpers behind two bugs a user could hit in one click.
 *
 *   video-key    Saved videos compared `video.id`, which no video row has.
 *                Saving one marked all of them; saving a second emptied the list.
 *   route-param  Opening a shop whose name contains a % ("100% Pure") threw a
 *                URIError during render and, with no error boundary, blanked
 *                the app.
 *
 * No React, no DOM, no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { videoKey, isVideoSaved, toggleSavedVideo } from '../client/src/lib/video-key';
import { decodeRouteParam } from '../client/src/lib/route-param';

// The shape /api/top-videos actually returns: no `id` anywhere.
const row = (n: string) => ({
  product_id: 'p1',
  video_url: `https://www.tiktok.com/@someone/video/${n}`,
  view_count: 1000,
});
const first = row('7412345678901234567');
const second = row('7498765432109876543');
const third = row('7455555555555555555');

test('videoKey: the TikTok id from the URL, different for different videos', () => {
  assert.equal(videoKey(first), '7412345678901234567');
  assert.notEqual(videoKey(first), videoKey(second));
});

test('videoKey: the same video reached by a different URL shape is the same video', () => {
  assert.equal(
    videoKey({ video_url: 'https://www.tiktok.com/@t/video/7412345678901234567?lang=en' }),
    videoKey(first),
  );
});

test('videoKey: rows without a video URL still get distinct keys', () => {
  assert.equal(videoKey({ id: 42 }), 'row:42');
  assert.notEqual(videoKey({ id: 42 }), videoKey({ id: 43 }));
  assert.equal(videoKey({ video_url: 'https://example.com/a' }), 'url:https://example.com/a');
});

test('saving one video marks that video and no other', () => {
  const saved = toggleSavedVideo([], first);
  assert.equal(isVideoSaved(saved, first), true);
  // With `v.id === video.id` both sides were undefined, so these were true.
  assert.equal(isVideoSaved(saved, second), false);
  assert.equal(isVideoSaved(saved, third), false);
});

test('saving a second video keeps the first', () => {
  // Used to empty the list: "already saved" matched, and the filter dropped
  // every row whose id was undefined — all of them.
  const saved = toggleSavedVideo(toggleSavedVideo([], first), second);
  assert.equal(saved.length, 2);
  assert.equal(isVideoSaved(saved, first), true);
  assert.equal(isVideoSaved(saved, second), true);
});

test('un-saving removes that video only', () => {
  let saved = [first, second, third];
  saved = toggleSavedVideo(saved, second);
  assert.deepEqual(saved, [first, third]);
});

test('toggleSavedVideo does not mutate the list it was given', () => {
  const before = [first];
  toggleSavedVideo(before, second);
  toggleSavedVideo(before, first);
  assert.deepEqual(before, [first]);
});

/** What the page receives: the link, after wouter's decodeURI pass. */
function throughRouter(name: string): string {
  const link = encodeURIComponent(name);
  try {
    return decodeURI(link);
  } catch {
    return link;
  }
}

test('decodeRouteParam: a shop with a % in its name no longer throws', () => {
  const seen = throughRouter('name:100% Pure');
  assert.equal(seen, 'name%3A100% Pure'); // the half-decoded form the page gets
  assert.throws(() => decodeURIComponent(seen), URIError); // what the page used to do
  assert.equal(decodeRouteParam(seen), 'name:100% Pure');
});

test('decodeRouteParam: round-trips the names shops actually have', () => {
  for (const name of [
    '7495514739648989419',
    'name:Tom & Jerry',
    'name:A/B Testing Co.',
    'name:Café Olé',
    'name:50% Off Store',
    'name:100%',
    'name:What? #1 + More',
    'id:7153000000000000000',
    'hayliesfaves',
  ]) {
    assert.equal(decodeRouteParam(throughRouter(name)), name, name);
  }
});

test('decodeRouteParam: empty in, empty out, and it never throws', () => {
  assert.equal(decodeRouteParam(undefined), '');
  assert.equal(decodeRouteParam(null), '');
  assert.equal(decodeRouteParam(''), '');
  for (const junk of ['%', '%%', '%E0%A4%A', '%zz', 'a%2', '%C3', '100%!']) {
    assert.doesNotThrow(() => decodeRouteParam(junk), junk);
  }
});
