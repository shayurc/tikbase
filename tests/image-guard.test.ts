/**
 * api/_lib/image-guard.ts — what the unauthenticated image proxies will fetch
 * and store with the service-role key. No network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { plausibleVideoId, sniffImage, acceptableImage, MAX_IMAGE_BYTES } from '../api/_lib/image-guard';

const NOW = Date.UTC(2026, 10, 13);
/** A snowflake id for a given post time. */
const idFor = (ms: number) => String((BigInt(Math.floor(ms / 1000)) << 32n) | 12345n);

test('video id: a real one from the smoke test, and ids across the tracked years', () => {
  assert.equal(plausibleVideoId('7412345678901234567', NOW), true);
  assert.equal(plausibleVideoId(idFor(Date.UTC(2021, 5, 1)), NOW), true);
  assert.equal(plausibleVideoId(idFor(NOW - 3600_000), NOW), true);
});

test('video id: the old rule accepted any five digits; these are all refused now', () => {
  for (const bad of ['12345', '99999999', '1'.repeat(14), '9'.repeat(40), '', 'abc', '74123456789012345x', '-7412345678901234567']) {
    assert.equal(plausibleVideoId(bad, NOW), false, bad);
  }
});

test('video id: right length but a post time outside TikTok Shop is refused', () => {
  assert.equal(plausibleVideoId(idFor(Date.UTC(2015, 0, 1)).padStart(15, '1'), NOW), false);
  assert.equal(plausibleVideoId(idFor(NOW + 30 * 86_400_000), NOW), false); // the future
  assert.equal(plausibleVideoId('100000000000000', NOW), false); // decodes to 1970
});

const bytes = (...head: number[]) => Uint8Array.from([...head, ...new Array(32).fill(0)]);
const text = (s: string) => new TextEncoder().encode(s);

test('sniff: the formats the CDNs actually serve', () => {
  assert.equal(sniffImage(bytes(0xff, 0xd8, 0xff, 0xe0)), 'image/jpeg');
  assert.equal(sniffImage(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), 'image/png');
  assert.equal(sniffImage(text('GIF89a' + 'x'.repeat(20))), 'image/gif');
  assert.equal(sniffImage(text('RIFF\x10\x00\x00\x00WEBPVP8 ')), 'image/webp');
  assert.equal(sniffImage(text('\x00\x00\x00\x1cftypavif\x00\x00\x00\x00')), 'image/avif');
});

test('acceptable: HTML, SVG and JSON are not images, whatever the header said', () => {
  for (const body of ['<!doctype html><script>alert(1)</script>', '<svg xmlns="http://www.w3.org/2000/svg" onload="x()"/>', '{"error":"expired"}']) {
    assert.deepEqual(acceptableImage(text(body)), { ok: false, reason: 'not-an-image' });
  }
});

test('acceptable: empty and oversized bodies are refused', () => {
  assert.deepEqual(acceptableImage(new Uint8Array(0)), { ok: false, reason: 'empty' });
  const huge = new Uint8Array(MAX_IMAGE_BYTES + 1);
  huge.set([0xff, 0xd8, 0xff]);
  assert.deepEqual(acceptableImage(huge), { ok: false, reason: 'too-large' });
});

test('acceptable: a real image is stored under the type its bytes are', () => {
  assert.deepEqual(acceptableImage(bytes(0xff, 0xd8, 0xff, 0xdb)), { ok: true, contentType: 'image/jpeg' });
});
