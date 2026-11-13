/**
 * Asking the server whether this account pays — and telling "no" apart from
 * "I could not ask".
 *
 * The old check was `fetch(...).then(r => r.json()).then(d => setIsPaid(d.isPaid === true))`
 * with a catch that also set false. So every way the request could fail read as
 * "free": a 503 during a database outage (its body has no isPaid), a 500 (its
 * body is not JSON, so .json() throws), a dropped connection. A paying customer
 * got the paywall for the rest of the session because of one bad round trip —
 * the exact outcome api/check-subscription.ts answers 503 to prevent.
 *
 * Here only a 2xx with a body is an answer. Anything else is retried, and if
 * it still fails the caller is told `known: false` and keeps whatever it last
 * knew, rather than being handed a default dressed up as a fact.
 *
 * No React in this file, so it runs under node:test.
 */

export type SubscriptionAnswer =
  | { known: true; isPaid: boolean }
  | { known: false };

export interface AskOptions {
  fetchImpl?: typeof fetch;
  /** Waits between attempts; its length is the number of retries. */
  retryDelaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
}

/** Two retries, ~4s in all: long enough to ride out a cold start or a blip. */
export const DEFAULT_RETRY_DELAYS_MS = [1000, 3000];

export async function askSubscription(
  token: string,
  opts: AskOptions = {},
): Promise<SubscriptionAnswer> {
  const doFetch = opts.fetchImpl ?? fetch;
  const delays = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  for (let attempt = 0; ; attempt++) {
    try {
      const res = await doFetch('/api/check-subscription', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        return { known: true, isPaid: data?.isPaid === true };
      }
    } catch {
      // Network failure or an unparseable body: we could not ask.
    }
    if (attempt >= delays.length) return { known: false };
    await sleep(delays[attempt]);
  }
}
